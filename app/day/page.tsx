"use client";

import { useEffect, useRef, useState } from "react";

/* =============== TYP KROKU DNIA =============== */
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;     // dla VERIFY
  prompt?: string;     // dla SAY
  prep_ms?: number;    // czas na przeczytanie pytania
  dwell_ms?: number;   // czas aktywnego okna SAY
};

/* =============== ŁADOWANIE PLANU DNIA =============== */
async function loadDayPlanOrTxt(dayFileParam: string): Promise<PlanStep[]> {
  try {
    const r = await fetch(`/days/${dayFileParam}.plan.json`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j?.steps)) return j.steps as PlanStep[];
    }
  } catch {}
  const r2 = await fetch(`/days/${dayFileParam}.txt`, { cache: "no-store" });
  if (!r2.ok) return [{ mode: "VERIFY", target: "Brak treści dla tego dnia." }];
  const txt = await r2.text();
  return txt
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(line => ({ mode: "VERIFY" as const, target: line }));
}

/* =============== HELPERS =============== */
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

/* =============== KOMPONENT =============== */
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // USTAWIENIA UŻYTKOWNIKA/DNIA
  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "03") : "03";
  const dayFileParam = dayRaw.padStart(2, "0");
  const DAY_LABEL = (() => {
    const n = parseInt(dayRaw, 10);
    return Number.isNaN(n) ? dayRaw : String(n);
  })();

  // LIMIT SESJI
  const MAX_TIME = 6 * 60; // 6 minut łącznie

  // PROGI VAD (delikatne i stabilne)
  const SPEAK_FRAMES = 2;
  const RMS_TH = 0.017;
  const PEAK_TH = 0.040;
  const VU_TH   = 7;

  // STANY GŁÓWNE
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);

  // LICZNIK
  const [remaining, setRemaining] = useState(MAX_TIME);
  const endAtRef = useRef<number | null>(null);
  const countdownIdRef = useRef<number | null>(null);

  // AUDIO / VAD
  const [levelPct, setLevelPct] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const speakingFramesRef = useRef(0);
  const lastVoiceAtRef = useRef<number>(Date.now());
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // PRZYPOMINAJKA PAUZUJĄCA (jedyna)
  const [silencePause, setSilencePause] = useState(false);
  const pausedRemainingRef = useRef<number | null>(null);

  // VIZ
  const [speakingBlink, setSpeakingBlink] = useState(false);
  const [mirror] = useState(true);

  // SAY — transkrypt (na górze sekcji)
  const [sayTranscript, setSayTranscript] = useState("");
  const sayActiveRef = useRef(false);
  const recognitionRef = useRef<any>(null);

  // REFY AKTUALNYCH WARTOŚCI
  const isRunningRef = useRef(isRunning);
  const idxRef = useRef(idx);
  const stepsRef = useRef<PlanStep[]>([]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  /* =============== COUNTDOWN =============== */
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

  /* =============== START/STOP AV + VAD =============== */
  async function startAV(): Promise<boolean> {
    stopAV();
    setMicError(null);
    speakingFramesRef.current = 0;
    lastVoiceAtRef.current = Date.now();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
      });
      streamRef.current = stream;
      if (videoRef.current) (videoRef.current as any).srcObject = stream;

      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new Ctx();
      audioCtxRef.current = ac;

      if (ac.state === "suspended") {
        await ac.resume().catch(() => {});
        const onClick = () => ac.resume().catch(() => {});
        document.addEventListener("click", onClick, { once: true });
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

        let peak = 0, sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const x = (data[i] - 128) / 128;
          const a = Math.abs(x);
          if (a > peak) peak = a;
          sumSq += x * x;
        }
        const rms = Math.sqrt(sumSq / data.length);
        const vu = Math.min(100, peak * 480);
        setLevelPct(prev => Math.max(vu, prev * 0.85));

        const speakingNow = (rms > RMS_TH) || (peak > PEAK_TH) || (vu > VU_TH);

        if (speakingNow) {
          speakingFramesRef.current++;
          if (speakingFramesRef.current >= SPEAK_FRAMES) {
            setSpeakingBlink(true);
            lastVoiceAtRef.current = Date.now(); // ważne: reset licznika ciszy
          }
        } else {
          speakingFramesRef.current = 0;
        }

        // ---- Jedyna przypominajka po 10 s ciszy: pauzuje i czeka na tap ----
        if (isRunningRef.current && !silencePause) {
          const now = Date.now();
          if (now - lastVoiceAtRef.current >= 10_000) {
            // Zamrożenie licznika na aktualnej wartości
            let secsLeft = remaining;
            if (endAtRef.current != null) {
              secsLeft = Math.max(0, Math.ceil((endAtRef.current - now) / 1000));
            }
            pausedRemainingRef.current = secsLeft;
            stopCountdown();
            setRemaining(secsLeft);
            setSilencePause(true);
          }
        }

        window.setTimeout(() => setSpeakingBlink(false), 120);
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      return true;
    } catch (err: any) {
      console.error("getUserMedia error:", err);
      setMicError(err?.name === "NotAllowedError" ? "Brak zgody na mikrofon/kamerę." : "Nie udało się uruchomić mikrofonu/kamery.");
      return false;
    }
  }

  function stopAV() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
  }

  /* =============== SAY: Web Speech API (fallback) =============== */
  function startSayCapture() {
    sayActiveRef.current = true;
    setSayTranscript("");
    stopSayCapture(); // safety

    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!SR) return; // brak w przeglądarce → wtedy używamy tylko VAD (bez transkryptu)

    const rec = new SR();
    recognitionRef.current = rec;
    rec.lang = "pl-PL";
    rec.continuous = true;
    rec.interimResults = true;

    let buffer = "";
    rec.onresult = (e: any) => {
      let interim = "", finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      const composed = (buffer + finalText + interim).trim();
      setSayTranscript(composed);
      if (composed) lastVoiceAtRef.current = Date.now(); // mowa → wyzeruj licznik ciszy
      if (finalText) buffer += finalText + " ";
    };
    rec.onerror = () => {};
    rec.onend = () => {
      if (sayActiveRef.current) {
        try { rec.start(); } catch {}
      }
    };
    try { rec.start(); } catch {}
  }

  function stopSayCapture() {
    sayActiveRef.current = false;
    const rec = recognitionRef.current;
    if (rec) { try { rec.onend = null; rec.stop(); } catch {} }
    recognitionRef.current = null;
  }

  /* =============== KROKI =============== */
  const stepTimerRef = useRef<number | null>(null);

  function clearStepTimer() {
    if (stepTimerRef.current) {
      window.clearTimeout(stepTimerRef.current);
      stepTimerRef.current = null;
    }
  }

  function runStep(i: number) {
    if (!stepsRef.current.length) return;
    const s = stepsRef.current[i];
    if (!s) return;

    clearStepTimer();
    setSilencePause(false);
    lastVoiceAtRef.current = Date.now(); // start kroku → licz od zera

    if (s.mode === "VERIFY") {
      stopSayCapture();
      setDisplayText(s.target || "");
      // VERIFY leci dopóki krok nie zostanie zmieniony przez Twoją logikę (np. własny schedule)
    } else {
      const prep = Number(s.prep_ms ?? 1200);
      const dwell = Number(s.dwell_ms ?? 12000);

      stopSayCapture();
      setSayTranscript("");
      setDisplayText(s.prompt || "");

      // po krótkim wstępie włączamy nasłuch mowy
      stepTimerRef.current = window.setTimeout(() => {
        if (idxRef.current !== i) return;
        startSayCapture();

        // po „dwell” kończymy SAY i przechodzimy dalej
        stepTimerRef.current = window.setTimeout(() => {
          if (idxRef.current !== i) return;
          stopSayCapture();
          gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearStepTimer();
    stopSayCapture();
    const next = (i + 1) % stepsRef.current.length;
    setIdx(next);
    const n = stepsRef.current[next];
    setDisplayText(n?.mode === "VERIFY" ? (n?.target || "") : (n?.prompt || ""));
    runStep(next);
  }

  /* =============== START/STOP SESJI =============== */
  const startSession = async () => {
    if (!stepsRef.current.length) return;
    const ok = await startAV();
    if (!ok) { setIsRunning(false); return; }
    setIsRunning(true);
    startCountdown(MAX_TIME);
    setIdx(0);
    const s0 = stepsRef.current[0];
    setDisplayText(s0?.mode === "VERIFY" ? (s0.target || "") : (s0?.prompt || ""));
    runStep(0);
  };

  const stopSession = () => {
    setIsRunning(false);
    stopCountdown();
    clearStepTimer();
    stopSayCapture();
    stopAV();
    setLevelPct(0);
    setSilencePause(false);
  };

  /* =============== WZNOWIENIE PO PAUZIE CISZY =============== */
  function resumeFromPause() {
    if (!silencePause) return;
    const secs = pausedRemainingRef.current ?? remaining;
    startCountdown(secs);           // wznów od miejsca pauzy
    setSilencePause(false);
    lastVoiceAtRef.current = Date.now(); // wyzeruj licznik ciszy
  }

  /* =============== INIT PLANU =============== */
  useEffect(() => {
    (async () => {
      const loaded = await loadDayPlanOrTxt(dayFileParam);
      setSteps(loaded);
      setIdx(0);
      setDisplayText(
        loaded[0]?.mode === "VERIFY"
          ? (loaded[0]?.target || "")
          : (loaded[0]?.prompt || "")
      );
      // eslint-disable-next-line no-console
      console.log(`[DAY ${dayFileParam}] steps:`, loaded.length);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* =============== RENDER =============== */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const isSay = steps[idx]?.mode === "SAY";

  // Style wspólne
  const centerStack: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    textAlign: "center",
  };

  const centerTextStyle: React.CSSProperties = {
    whiteSpace: "pre-wrap",
    textAlign: "center",
    maxWidth: 800,
    margin: "0 auto",
  };

  const questionStyle: React.CSSProperties = {
    fontSize: 20,
    lineHeight: 1.5,
    maxWidth: 760,
    margin: "0 auto",
    textAlign: "center",
  };

  const transcriptStyleTop: React.CSSProperties = {
    marginTop: 8,
    fontSize: 18,
    lineHeight: 1.35,
    textAlign: "center",
    // celowo BEZ tła — czysty biały tekst
  };

  return (
    <main className="prompter-full">
      {/* TOP BAR */}
      <header className="topbar topbar--dense">
        <nav className="tabs">
          <a className="tab active" href="/day" aria-current="page">Prompter</a>
        </nav>
        <div className="top-info compact" style={{ display: "flex", alignItems: "center", gap: 8 }}>
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

      {/* TIMER (u góry) */}
      <div className="timer-top timer-top--strong">{fmt(remaining)}</div>

      {/* SCENA */}
      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* OVERLAY: INTRO */}
        {!isRunning && (
          <div className="overlay center">
            <div style={{ ...centerStack, maxWidth: 600 }}>
              <p style={{ fontSize: 16, opacity: 0.9 }}>
                Twoja sesja potrwa około <b>6 minut</b>.<br />
                <span>Postaraj się wyraźnie powtarzać wyświetlane treści.</span>
              </p>
              {micError && (
                <p style={{ marginTop: 8, color: "#ffb3b3", fontSize: 14 }}>
                  {micError} — sprawdź dostęp do mikrofonu i kamery.
                </p>
              )}
            </div>
          </div>
        )}

        {/* OVERLAY: SESJA */}
        {isRunning && (
          <div className="overlay center" style={{ position: "relative" }}>
            {/* VERIFY */}
            {steps[idx]?.mode === "VERIFY" && (
              <div className="center-text fade" style={centerTextStyle}>
                {displayText}
              </div>
            )}

            {/* SAY */}
            {isSay && (
              <div className="center-text fade" style={{ ...centerTextStyle }}>
                {/* transkrypt NA GÓRZE sekcji SAY */}
                <div style={transcriptStyleTop}>{sayTranscript}</div>
                {/* pytanie / komenda – większa czcionka, centralnie */}
                <div style={{ ...questionStyle, marginTop: 12 }}>{displayText}</div>
              </div>
            )}

            {/* Overlay pauzy ciszy – JEDYNA przypominajka */}
            {silencePause && (
              <div
                onClick={resumeFromPause}
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(0,0,0,0.35)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  padding: 24,
                  cursor: "pointer",
                  zIndex: 50,
                }}
              >
                <div style={{ maxWidth: 720, lineHeight: 1.5 }}>
                  <div style={{ fontSize: 18, marginBottom: 12 }}>
                    Jeśli nie czujesz, że to dobry moment, zawsze możesz wrócić później.
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 600 }}>
                    Jeśli chcesz kontynuować, dotknij ekranu.
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* VU-meter po prawej */}
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
