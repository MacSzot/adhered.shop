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

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Ustawienia
  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień " + ((typeof window !== "undefined") ? getParam("day", "01") : "01");
  const MAX_TIME = 6 * 60; // 6 minut

  // Tuning VAD / czasów
  const SPEAKING_FRAMES_REQUIRED = 2;
  const HINT_AFTER_MS = 7000;               // pokaż przypomnienie po 7 s ciszy
  const HARD_CAP_MS   = 12000;              // auto advance po 12 s ciszy
  const ADV_AFTER_SPEAK_MS = 4000;          // 4 s po pierwszym głosie

  // Stany UI
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);
  const [micError, setMicError] = useState<string | null>(null);

  // Hint (sterowany bez wyścigów)
  const [showSilenceHint, _setShowSilenceHint] = useState(false);
  const showSilenceHintRef = useRef(false);
  const setShowSilenceHint = (v: boolean) => { showSilenceHintRef.current = v; _setShowSilenceHint(v); };

  const [speakingBlink, setSpeakingBlink] = useState(false);

  // Refy „świeżych” wartości
  const idxRef = useRef(idx);
  const stepsRef = useRef<PlanStep[]>([]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  /* ---------- TIMER stabilny (odlicza tylko po zgodzie na media) ---------- */
  const endAtRef = useRef<number | null>(null);
  const countdownIdRef = useRef<number | null>(null);
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
    if (countdownIdRef.current) { window.clearInterval(countdownIdRef.current); countdownIdRef.current = null; }
    endAtRef.current = null;
  }

  /* ---------- Timery kroku / VAD ---------- */
  const stepTokenRef      = useRef<number>(0);      // unieważnia timery przy zmianie kroku
  const speakAdvTimerRef  = useRef<number | null>(null); // 4 s po głosie
  const hintTimerRef      = useRef<number | null>(null); // 7 s ciszy
  const hardCapTimerRef   = useRef<number | null>(null); // 12 s ciszy
  const rafRef            = useRef<number | null>(null);

  // AV
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);

  // VAD pomocnicze
  const heardThisStepRef   = useRef(false);
  const speakingFramesRef  = useRef(0);

  // Kalibracja tła
  const noiseRmsRef   = useRef(0.0);
  const noisePeakRef  = useRef(0.0);
  const calibratingRef = useRef(true);
  const calibUntilRef  = useRef<number>(0);
  const calibAccRmsRef = useRef(0.0);
  const calibAccPeakRef= useRef(0.0);
  const calibNRef      = useRef(0);

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

    // reset kalibracji
    calibratingRef.current = true;
    calibUntilRef.current = performance.now() + 1500; // 1.5 s
    calibAccRmsRef.current = 0;
    calibAccPeakRef.current = 0;
    calibNRef.current = 0;
    noiseRmsRef.current = 0.0;
    noisePeakRef.current = 0.0;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
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
      analyser.smoothingTimeConstant = 0.72; // szybciej reaguje
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

        const now = performance.now();

        // --- KALIBRACJA TŁA (pierwsze ~1.5 s) ---
        if (calibratingRef.current) {
          calibAccRmsRef.current  += rms;
          calibAccPeakRef.current += peak;
          calibNRef.current       += 1;
          if (now >= calibUntilRef.current) {
            const n = Math.max(1, calibNRef.current);
            noiseRmsRef.current  = Math.min(0.02, (calibAccRmsRef.current  / n) || 0.0);
            noisePeakRef.current = Math.min(0.04, (calibAccPeakRef.current / n) || 0.0);
            calibratingRef.current = false;
          }
          rafRef.current = requestAnimationFrame(loop);
          return;
        }

        // --- DETEKCJA MÓWIENIA względem tła ---
        const speakingNow =
          (rms  > noiseRmsRef.current  * 1.6 + 0.004) ||
          (peak > noisePeakRef.current * 1.45 + 0.018) ||
          (vu   > 6);

        if (speakingNow) {
          speakingFramesRef.current += 1;
          if (speakingFramesRef.current >= SPEAKING_FRAMES_REQUIRED) {
            setSpeakingBlink(true);
            window.setTimeout(() => setSpeakingBlink(false), 120);

            const s = stepsRef.current[idxRef.current];
            // tylko w VERIFY reagujemy na głos logiką przejścia
            if (s?.mode === "VERIFY" && !heardThisStepRef.current) {
              heardThisStepRef.current = true;
              setShowSilenceHint(false);

              // zatrzymaj liczniki ciszy (7s / 12s)
              if (hintTimerRef.current)   { window.clearTimeout(hintTimerRef.current); hintTimerRef.current = null; }
              if (hardCapTimerRef.current){ window.clearTimeout(hardCapTimerRef.current); hardCapTimerRef.current = null; }

              // ustaw 4 s do przejścia (token, by uniknąć wyścigów)
              const token = stepTokenRef.current;
              if (speakAdvTimerRef.current) { window.clearTimeout(speakAdvTimerRef.current); speakAdvTimerRef.current = null; }
              speakAdvTimerRef.current = window.setTimeout(() => {
                if (token === stepTokenRef.current) gotoNext(idxRef.current);
              }, ADV_AFTER_SPEAK_MS);
            }
          }
        } else {
          speakingFramesRef.current = 0;
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
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
  }

  /* ---- 3) Timery kroków ---- */
  function clearStepTimers() {
    if (speakAdvTimerRef.current) { window.clearTimeout(speakAdvTimerRef.current); speakAdvTimerRef.current = null; }
    if (hintTimerRef.current)     { window.clearTimeout(hintTimerRef.current); hintTimerRef.current = null; }
    if (hardCapTimerRef.current)  { window.clearTimeout(hardCapTimerRef.current); hardCapTimerRef.current = null; }
  }

  function runStep(i: number) {
    if (!stepsRef.current.length) return;
    const s = stepsRef.current[i];
    if (!s) return;

    // nowy krok
    stepTokenRef.current++;
    clearStepTimers();
    heardThisStepRef.current = false;
    speakingFramesRef.current = 0;
    setShowSilenceHint(false);

    if (s.mode === "VERIFY") {
      setDisplayText(s.target || "");

      // ustaw timery ciszy (nie czekamy na VAD w pętli, tylko pewny zegar)
      const token = stepTokenRef.current;
      hintTimerRef.current = window.setTimeout(() => {
        if (token === stepTokenRef.current && !heardThisStepRef.current) {
          setShowSilenceHint(true); // po 7s ciszy
        }
      }, HINT_AFTER_MS);

      hardCapTimerRef.current = window.setTimeout(() => {
        if (token === stepTokenRef.current && !heardThisStepRef.current) {
          setShowSilenceHint(false);
          gotoNext(i); // po 12s ciszy wymuś przejście
        }
      }, HARD_CAP_MS);

      // uwaga: przejście po głosie obsługuje pętla VAD (4 s po mówieniu)
    } else {
      // SAY – bez zmian w tym trybie (okna czasowe)
      const prep = Number(s.prep_ms ?? 5000);
      const dwell = Number(s.dwell_ms ?? 45000);
      setDisplayText(s.prompt || "");
      const token = stepTokenRef.current;
      window.setTimeout(() => {
        if (token !== stepTokenRef.current) return;
        setDisplayText(s.prompt || "");
        window.setTimeout(() => {
          if (token !== stepTokenRef.current) return;
          gotoNext(i);
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

  /* ---- 4) Start/Stop sesji ---- */
  const startSession = async () => {
    if (!stepsRef.current.length) return;

    // 1) Permission + AV (timer startuje dopiero po zgodzie)
    const ok = await startAV();
    if (!ok) { setIsRunning(false); return; }

    // 2) Start sesji i TIMERA
    setIsRunning(true);
    startCountdown(MAX_TIME);

    // 3) Start kroków
    setIdx(0);
    runStep(0);
  };

  const stopSession = () => {
    setIsRunning(false);
    stopCountdown();
    clearStepTimers();
    stopAV();
    setLevelPct(0);
  };

  /* ---- 5) Render ---- */
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
                Kliknij <b>Start</b> i udziel dostępu do <b>kamery i mikrofonu</b>.<br/>
                W trybie VERIFY: jeśli mówisz — przejdziemy dalej po <b>4 s</b>.  
                Jeśli cisza — przypomnienie po <b>7 s</b>, a auto-przejście po <b>12 s</b>.
              </p>
              {micError && (
                <p style={{ marginTop: 12, color: "#ffb3b3" }}>{micError} — sprawdź uprawnienia przeglądarki.</p>
              )}
            </div>
          </div>
        )}

        {isRunning && (
          <div className="overlay center">
            <div className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
              {displayText}
            </div>

            {/* HINT POD TEKSTEM (na środku, poniżej zdania) */}
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
