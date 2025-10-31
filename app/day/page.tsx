"use client";

import { useEffect, useRef, useState } from "react";

/* =================== PLAN DNIA (opcjonalny TXT fallback) =================== */
type PlanStep = {
  mode: "VERIFY";
  target: string;
};

async function loadDayPlanOrTxt(dayFileParam: string): Promise<PlanStep[]> {
  try {
    const r = await fetch(`/days/${dayFileParam}.plan.json`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j?.steps) && j.steps.length) {
        // tylko VERIFY w tym minimalu
        return (j.steps as any[]).map((s) => ({
          mode: "VERIFY" as const,
          target: String(s.target ?? s.text ?? ""),
        }));
      }
    }
  } catch {}
  // TXT – każda linia to jeden krok VERIFY
  try {
    const r2 = await fetch(`/days/${dayFileParam}.txt`, { cache: "no-store" });
    if (r2.ok) {
      const txt = await r2.text();
      return txt
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((line) => ({ mode: "VERIFY" as const, target: line }));
    }
  } catch {}
  // fallback awaryjny
  return [{ mode: "VERIFY", target: "Brak treści dla tego dnia." }];
}

/* =============================== STAŁE ===================================== */
const MAX_TIME_SECONDS = 6 * 60;         // 6 minut
const SPEAKING_FRAMES_REQUIRED = 2;      // ile kolejnych ramek uznajemy za „mówi”
const SILENCE_TRIGGER_MS = 10_000;       // po tylu ms ciszy pokażemy przypominajkę

/* =============================== STRONA ==================================== */
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Ustawienia z URL (np. ?day=3)
  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("day") || "01" : "01";
  const dayFileParam = dayRaw.padStart(2, "0");
  const DAY_LABEL = (() => {
    const n = parseInt(dayRaw, 10);
    return Number.isNaN(n) ? dayRaw : String(n);
  })();

  /* ===== STANY SESJI ===== */
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  // licznik
  const [remaining, setRemaining] = useState(MAX_TIME_SECONDS);
  const endAtRef = useRef<number | null>(null);
  const countdownIdRef = useRef<number | null>(null);

  // VU + mikrofon/kamera
  const [levelPct, setLevelPct] = useState(0);
  const [speakingBlink, setSpeakingBlink] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const rafRef = useRef<number | null>(null);
  const speakingFramesRef = useRef(0);

  // logika ciszy (JEDYNA przypominajka)
  const [silencePause, setSilencePause] = useState(false);
  const pauseMessage =
    "Jeśli nie czujesz, że to dobry moment, zawsze możesz wrócić później.\n\nJeśli chcesz kontynuować, dotknij ekranu.";
  const lastVoiceAtRef = useRef<number>(Date.now());

  // referencje stanów
  const isRunningRef = useRef(isRunning);
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  /* ===== 1) Wczytaj plan ===== */
  useEffect(() => {
    (async () => {
      const s = await loadDayPlanOrTxt(dayFileParam);
      setSteps(s);
      setIdx(0);
      setDisplayText(s[0]?.target ?? "");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ===== TIMER ===== */
  function startCountdown(seconds: number) {
    stopCountdown();
    endAtRef.current = Date.now() + seconds * 1000;
    setRemaining(Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000)));
    countdownIdRef.current = window.setInterval(() => {
      if (!endAtRef.current) return;
      const secs = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0) stopSession();
    }, 250);
  }
  function stopCountdown() {
    if (countdownIdRef.current) {
      window.clearInterval(countdownIdRef.current);
      countdownIdRef.current = null;
    }
    endAtRef.current = null;
  }

  /* ===== AUDIO/VIDEO + VAD ===== */
  async function startAV(): Promise<boolean> {
    stopAV();
    setMicError(null);
    speakingFramesRef.current = 0;
    lastVoiceAtRef.current = Date.now();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        }
      });
      streamRef.current = stream;
      if (videoRef.current) (videoRef.current as any).srcObject = stream;

      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new Ctx();
      audioCtxRef.current = ac;

      if (ac.state === "suspended") {
        await ac.resume().catch(() => {});
        const resumeOnClick = () => ac.resume().catch(() => {});
        document.addEventListener("click", resumeOnClick, { once: true });
      }

      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.86;
      ac.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.fftSize);

      const loop = () => {
        if (!analyserRef.current || !isRunningRef.current) return;

        analyser.getByteTimeDomainData(data);

        let peak = 0,
          sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const x = (data[i] - 128) / 128;
          const a = Math.abs(x);
          if (a > peak) peak = a;
          sumSq += x * x;
        }
        const rms = Math.sqrt(sumSq / data.length);
        const vu = Math.min(100, peak * 480);

        setLevelPct((prev) => Math.max(vu, prev * 0.85));

        const speakingNow = rms > 0.017 || peak > 0.04 || vu > 7;

        if (speakingNow) {
          speakingFramesRef.current += 1;
          if (speakingFramesRef.current >= SPEAKING_FRAMES_REQUIRED) {
            setSpeakingBlink(true);
            lastVoiceAtRef.current = Date.now(); // słyszeliśmy głos → reset licznika ciszy
          }
        } else {
          speakingFramesRef.current = 0;
        }
        // wyłącz mignięcie kropek po chwili
        window.setTimeout(() => setSpeakingBlink(false), 120);

        // ======= JEDYNA PRZYPOMINAJKA: po 10 s ciszy =========
        if (isRunningRef.current && !silencePause) {
          const now = Date.now();
          if (now - lastVoiceAtRef.current >= SILENCE_TRIGGER_MS) {
            // zatrzymaj licznik, pokaż overlay
            const secsLeft =
              endAtRef.current != null ? Math.max(0, Math.ceil((endAtRef.current - now) / 1000)) : remaining;
            stopCountdown();
            setRemaining(secsLeft);
            setSilencePause(true);
          }
        }

        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      return true;
    } catch (err: any) {
      console.error("getUserMedia error:", err);
      setMicError(
        err?.name === "NotAllowedError"
          ? "Brak zgody na mikrofon/kamerę."
          : "Nie udało się uruchomić mikrofonu/kamery."
      );
      return false;
    }
  }

  function stopAV() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {}
      audioCtxRef.current = null;
    }
  }

  /* ===== KROKI (tylko VERIFY w tym minimalu) ===== */
  function runStep(i: number) {
    const s = steps[i];
    if (!s) return;
    setDisplayText(s.target || "");
    lastVoiceAtRef.current = Date.now(); // przy nowym kroku licz ciszę od zera
  }
  function gotoNext(i: number) {
    const next = (i + 1) % steps.length;
    setIdx(next);
    runStep(next);
  }

  /* ===== START/STOP SESJI ===== */
  const startSession = async () => {
    if (!steps.length) return;
    const ok = await startAV();
    if (!ok) return;
    setIsRunning(true);
    setSilencePause(false);
    setIdx(0);
    runStep(0);
    startCountdown(MAX_TIME_SECONDS);
  };

  const stopSession = () => {
    setIsRunning(false);
    setSilencePause(false);
    stopCountdown();
    stopAV();
    setLevelPct(0);
  };

  /* ===== WZNOWIENIE PO PRZYPOMINAJCE ===== */
  function resumeAfterSilence() {
    if (!silencePause) return;
    lastVoiceAtRef.current = Date.now();
    setSilencePause(false);
    startCountdown(remaining); // kontynuuj od miejsca, w którym przerwaliśmy
  }

  /* ===== RENDER ===== */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const centerTextStyle: React.CSSProperties = {
    whiteSpace: "pre-wrap",
    textAlign: "center",
    maxWidth: 780,
    margin: "0 auto",
    fontSize: 24,
    lineHeight: 1.5,
    textShadow: "0 1px 2px rgba(0,0,0,0.55)"
  };

  return (
    <main className="prompter-full">
      <header className="topbar topbar--dense">
        <nav className="tabs">
          <a className="tab active" href="/day" aria-current="page">
            Prompter
          </a>
          <span className="tab disabled" aria-disabled="true" title="Wkrótce">
            Rysownik
          </span>
        </nav>
        <div className="top-info compact">
          <span className="meta">
            <b>Użytkownik:</b> {USER_NAME}
          </span>
          <span className="dot">•</span>
          <span className="meta">
            <b>Dzień programu:</b> {DAY_LABEL}
          </span>
        </div>
        <div className="controls-top">
          {!isRunning ? (
            <button className="btn" onClick={startSession}>
              Start
            </button>
          ) : (
            <button className="btn" onClick={stopSession}>
              Stop
            </button>
          )}
        </div>
      </header>

      {/* ZEGAR NA GÓRZE */}
      <div className="timer-top timer-top--strong">{fmt(remaining)}</div>

      <div className="stage mirrored">
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* Intro (gdy nie wystartowano) */}
        {!isRunning && (
          <div className="overlay center">
            <div style={{ ...centerTextStyle, fontSize: 20 }}>
              Twoja sesja potrwa około <b>6 minut</b>.
              {"\n"}Prosimy o powtarzanie na głos wyświetlanych treści.
              {"\n"}{"\n"}Aktywowano analizator dźwięku <b>MeRoar™</b>.
            </div>
            {micError && (
              <p style={{ marginTop: 16, color: "#ffb3b3", fontSize: 14, textAlign: "center" }}>{micError}</p>
            )}
          </div>
        )}

        {/* Sesja: centralny tekst kroku */}
        {isRunning && (
          <div className="overlay center">
            <div className="center-text fade" style={centerTextStyle}>
              {displayText}
            </div>
          </div>
        )}

        {/* PRZYPOMINAJKA po 10 s ciszy (pauza) */}
        {isRunning && silencePause && (
          <div
            onClick={resumeAfterSilence}
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              background: "rgba(0,0,0,0.55)",
              cursor: "pointer",
              zIndex: 50
            }}
          >
            <div
              style={{
                ...centerTextStyle,
                fontSize: 18,
                maxWidth: 560,
                padding: "0 18px",
                color: "#fff"
              }}
            >
              {pauseMessage}
            </div>
          </div>
        )}

        {/* VU po prawej */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
          {speakingBlink && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 4,
                textAlign: "center",
                fontSize: 10,
                opacity: 0.7
              }}
            >
              ●
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
