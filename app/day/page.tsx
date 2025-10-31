"use client";

import { useEffect, useRef, useState } from "react";

/* =============== PLAN DNIA =============== */
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;
  prompt?: string;
  min_sentences?: number;
  starts_with?: string[];
  starts_with_any?: string[];
  prep_ms?: number;
  dwell_ms?: number;
  note?: string;
};

async function loadDayPlanOrTxt(day: string): Promise<{ source: "json" | "txt"; steps: PlanStep[] }> {
  try {
    const r = await fetch(`/days/${day}.plan.json`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const steps = Array.isArray(j?.steps) ? (j.steps as PlanStep[]) : [];
      if (steps.length) return { source: "json", steps };
    }
  } catch {}
  const r2 = await fetch(`/days/${day}.txt`, { cache: "no-store" });
  if (!r2.ok) throw new Error(`Brak pliku dnia: ${day}.plan.json i ${day}.txt`);
  const txt = await r2.text();
  const steps: PlanStep[] = txt
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(line => ({ mode: "VERIFY" as const, target: line }));
  return { source: "txt", steps };
}

/* =============== HELPERS =============== */
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

/* =============== PAGE =============== */
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Ustawienia
  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień " + (typeof window !== "undefined" ? getParam("day", "01") : "01");
  const MAX_TIME = 6 * 60; // 6 minut

  // Progi/czasy VAD
  const SPEAKING_FRAMES_REQUIRED = 2;
  const SILENCE_MS = 7000;
  const ADVANCE_AFTER_FIRST_SPEAK_MS = 4000;

  // Stany główne
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");

  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const remainingRef = useRef(remaining);
  useEffect(() => { remainingRef.current = remaining; }, [remaining]);

  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);
  const [micError, setMicError] = useState<string | null>(null);

  // Hint (ref-bezpieczny)
  const [showSilenceHint, _setShowSilenceHint] = useState(false);
  const showSilenceHintRef = useRef(false);
  const setShowSilenceHint = (v: boolean) => { showSilenceHintRef.current = v; _setShowSilenceHint(v); };

  const [speakingBlink, setSpeakingBlink] = useState(false);

  // Refy bieżących wartości
  const idxRef = useRef(idx);
  const stepsRef = useRef<PlanStep[]>([]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  // Timery/RAF
  const stepTimerRef = useRef<number | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  const rafVadRef = useRef<number | null>(null);

  // **CHRONO** (na RAF)
  const chronoRafRef = useRef<number | null>(null);
  const chronoStartTsRef = useRef<number | null>(null);

  // AV
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // VAD pomocnicze
  const heardThisStepRef = useRef(false);
  const speakingFramesRef = useRef(0);
  const lastSpeakTsRef = useRef<number>(0);

  /* ---- 1) Wczytaj plan ---- */
  useEffect(() => {
    const day = getParam("day", "01");
    (async () => {
      try {
        const { source, steps } = await loadDayPlanOrTxt(day);
        setSteps(steps);
        setIdx(0);
        setDisplayText(steps[0]?.mode === "VERIFY" ? (steps[0].target || "") : (steps[0]?.prompt || ""));
        console.log(`[DAY ${day}] source:`, source, `steps: ${steps.length}`);
      } catch (e) {
        console.error(e);
        const fallback = [{ mode: "VERIFY" as const, target: "Brak treści dla tego dnia." }];
        setSteps(fallback);
        setDisplayText(fallback[0].target!);
      }
    })();
  }, []);

  /* ---- 2) Start/Stop AV + pętla VAD ---- */
  async function startAV(): Promise<boolean> {
    stopAV();
    setMicError(null);
    speakingFramesRef.current = 0;

    // ostrzeżenie bez HTTPS
    if (typeof window !== "undefined" && location.protocol !== "https:" && location.hostname !== "localhost") {
      console.warn("getUserMedia wymaga HTTPS na produkcji.");
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });

      streamRef.current = stream;

      // VIDEO: przypnij źródło i wymuś play (autoplay policy)
      const v = videoRef.current;
      if (v) {
        (v as any).srcObject = stream;
        v.onloadedmetadata = () => {
          v.play().catch(() => {
            // niektóre przeglądarki wymagają gestu użytkownika
          });
        };
        // podwójna próba (czasem onloadedmetadata nie strzela na mobilnych)
        try { await v.play(); } catch {}
      }

      // AUDIO: AudioContext + Analyser
      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new Ctx();
      audioCtxRef.current = ac;

      if (ac.state === "suspended") {
        // Safari/iOS – wznowimy po kliknięciu (Start)
        try { await ac.resume(); } catch {}
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
        if (!analyserRef.current) return;
        analyser.getByteTimeDomainData(data);

        // Peak + RMS
        let peak = 0, sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const x = (data[i] - 128) / 128;
          const a = Math.abs(x);
          if (a > peak) peak = a;
          sumSq += x * x;
        }
        const rms = Math.sqrt(sumSq / data.length);
        const vu = Math.min(100, peak * 460);

        setLevelPct(prev => Math.max(vu, prev * 0.85));

        // czułość (lekko podbita vs poprzednio)
        const speakingNow = (rms > 0.020) || (peak > 0.045) || (vu > 8);

        if (speakingNow) {
          speakingFramesRef.current += 1;
          if (speakingFramesRef.current >= SPEAKING_FRAMES_REQUIRED) {
            lastSpeakTsRef.current = performance.now();
            setSpeakingBlink(true);

            const s = stepsRef.current[idxRef.current];
            if (s?.mode === "VERIFY" && !heardThisStepRef.current) {
              heardThisStepRef.current = true;
              setShowSilenceHint(false);
              if (advanceTimerRef.current) { window.clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null; }
              const thisIdx = idxRef.current;
              advanceTimerRef.current = window.setTimeout(() => {
                if (idxRef.current === thisIdx) gotoNext(thisIdx);
              }, ADVANCE_AFTER_FIRST_SPEAK_MS);
            }
          }
        } else {
          speakingFramesRef.current = 0;
        }

        // HINT po 7s ciszy
        const silentFor = performance.now() - lastSpeakTsRef.current;
        const s = stepsRef.current[idxRef.current];
        if (s?.mode === "VERIFY") {
          if (silentFor >= SILENCE_MS && !showSilenceHintRef.current) setShowSilenceHint(true);
          if (silentFor < SILENCE_MS && showSilenceHintRef.current) setShowSilenceHint(false);
        } else if (showSilenceHintRef.current) {
          setShowSilenceHint(false);
        }

        window.setTimeout(() => setSpeakingBlink(false), 120);
        rafVadRef.current = requestAnimationFrame(loop);
      };
      rafVadRef.current = requestAnimationFrame(loop);

      return true;
    } catch (err: any) {
      console.error("getUserMedia error:", err);
      setMicError(
        err?.name === "NotAllowedError"
          ? "Brak zgody na mikrofon/kamerę. Sprawdź uprawnienia przeglądarki dla tej domeny."
          : "Nie udało się uruchomić mikrofonu/kamery."
      );
      return false;
    }
  }

  function stopAV() {
    if (rafVadRef.current) { cancelAnimationFrame(rafVadRef.current); rafVadRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
  }

  /* ---- 3) Chronometr na requestAnimationFrame ---- */
  function startChrono() {
    chronoStartTsRef.current = performance.now();
    setRemaining(MAX_TIME);

    const tick = () => {
      if (!chronoStartTsRef.current) return;
      const elapsed = Math.floor((performance.now() - chronoStartTsRef.current) / 1000);
      const nextRemaining = Math.max(0, MAX_TIME - elapsed);
      if (nextRemaining !== remainingRef.current) {
        remainingRef.current = nextRemaining;
        setRemaining(nextRemaining);
      }
      if (nextRemaining > 0 && isRunning) {
        chronoRafRef.current = requestAnimationFrame(tick);
      } else {
        setIsRunning(false);
        stopAV();
        setLevelPct(0);
      }
    };
    chronoRafRef.current = requestAnimationFrame(tick);
  }

  function stopChrono() {
    if (chronoRafRef.current) cancelAnimationFrame(chronoRafRef.current);
    chronoRafRef.current = null;
    chronoStartTsRef.current = null;
  }

  /* ---- 4) Timery kroków ---- */
  function clearStepTimers() {
    if (stepTimerRef.current) { window.clearTimeout(stepTimerRef.current); stepTimerRef.current = null; }
    if (advanceTimerRef.current) { window.clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null; }
  }

  function runStep(i: number) {
    if (!stepsRef.current.length) return;
    const s = stepsRef.current[i];
    if (!s) return;

    clearStepTimers();
    heardThisStepRef.current = false;
    speakingFramesRef.current = 0;
    setShowSilenceHint(false);

    if (s.mode === "VERIFY") {
      lastSpeakTsRef.current = performance.now();
      setDisplayText(s.target || "");
    } else {
      const prep = Number(s.prep_ms ?? 5000);
      const dwell = Number(s.dwell_ms ?? 45000);
      setDisplayText(s.prompt || "");
      stepTimerRef.current = window.setTimeout(() => {
        setDisplayText(s.prompt || "");
        stepTimerRef.current = window.setTimeout(() => {
          if (idxRef.current === i) gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearStepTimers();
    setShowSilenceHint(false);
    const next = (i + 1) % stepsRef.current.length;
    setIdx(next);
    runStep(next);
  }

  /* ---- 5) Start/Stop sesji ---- */
  const startSession = async () => {
    if (!stepsRef.current.length) return;

    // 1) Permission + AV
    const ok = await startAV();
    if (!ok) { setIsRunning(false); return; }

    // 2) Start sesji + chrono
    setIsRunning(true);
    setRemaining(MAX_TIME);
    startChrono();

    // 3) Krok 0
    setIdx(0);
    setDisplayText(stepsRef.current[0]?.mode === "VERIFY" ? (stepsRef.current[0].target || "") : (stepsRef.current[0]?.prompt || ""));
    runStep(0);
  };

  const stopSession = () => {
    setIsRunning(false);
    stopChrono();
    clearStepTimers();
    stopAV();
    setLevelPct(0);
  };

  /* ---- 6) Render ---- */
  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(1, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <main className="prompter-full">
      <header className="topbar topbar--dense">
        <nav className="tabs">
          <a className="tab active" href="/day" aria-current="page">Prompter</a>
          <span className="tab disabled" aria-disabled="true" title="Wkrótce">Rysownik</span>
        </nav>
        <div className="top-info compact">
          <span className="meta"><b>Użytkownik:</b> {USER_NAME}</span>
          <span className="dot">•</span>
          <span className="meta"><b>Dzień programu:</b> {DAY_LABEL}</span>
        </div>
        <div className="controls-top">
          {!isRunning ? (
            <button className="btn" onClick={startSession}>Start</button>
          ) : (
            <button className="btn" onClick={stopSession}>Stop</button>
          )}
        </div>
      </header>

      <div className="timer-top timer-top--strong">{fmt(remaining)}</div>

      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {!isRunning && (
          <div className="overlay center">
            <div className="intro">
              <h2>Teleprompter</h2>
              <p>
                Kliknij <b>Start</b> i udziel dostępu do <b>kamery i mikrofonu</b> (HTTPS wymagany).
                Kroki <b>VERIFY</b> stoją w miejscu; gdy usłyszymy Twój głos, po <b>4 sekundach</b> przejdziemy dalej.
                W ciszy pokażemy prośbę o powtórzenie <b>po 7 sekundach</b>.
              </p>
              {micError && (
                <p style={{ marginTop: 12, color: "#ffb3b3" }}>{micError}</p>
              )}
            </div>
          </div>
        )}

        {isRunning && (
          <div className="overlay center">
            <div className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
              {displayText}
            </div>

            {/* HINT POD TEKSTEM */}
            {showSilenceHint && (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 72,
                  padding: "0 24px",
                  textAlign: "center",
                  fontSize: 16,
                  lineHeight: 1.35,
                  color: "rgba(255,255,255,0.95)",
                  textShadow: "0 1px 2px rgba(0,0,0,0.6)",
                  pointerEvents: "none",
                }}
              >
                Czy możesz powtórzyć na głos?
              </div>
            )}
          </div>
        )}

        {/* VU-meter */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
          {speakingBlink && (
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 4, textAlign: "center", fontSize: 10, opacity: 0.7 }}>
              ●
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
