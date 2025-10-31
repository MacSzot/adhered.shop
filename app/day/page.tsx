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

async function loadDayPlanOrTxt(dayFileParam: string): Promise<{ source: "json" | "txt"; steps: PlanStep[] }> {
  try {
    const r = await fetch(`/days/${dayFileParam}.plan.json`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const steps = Array.isArray(j?.steps) ? (j.steps as PlanStep[]) : [];
      if (steps.length) return { source: "json", steps };
    }
  } catch {}
  const r2 = await fetch(`/days/${dayFileParam}.txt`, { cache: "no-store" });
  if (!r2.ok) throw new Error(`Brak pliku dnia: ${dayFileParam}.plan.json i ${dayFileParam}.txt`);
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
  const dayRaw = typeof window !== "undefined" ? getParam("day", "01") : "01";
  const dayFileParam = dayRaw.padStart(2, "0"); // zawsze 01..11 do wczytywania plików
  const DAY_LABEL = (() => {
    const n = parseInt(dayRaw, 10);
    return Number.isNaN(n) ? dayRaw : String(n); // UI: bez zera wiodącego
  })();

  const MAX_TIME = 6 * 60; // 6 minut

  // Progi/czasy
  const SPEAKING_FRAMES_REQUIRED = 2;
  const SILENCE_HINT_MS = 7000;   // hint po 7 s ciszy (powracający)
  const HARD_CAP_MS = 12000;      // VERIFY: auto-next po 12 s
  const ADVANCE_AFTER_SPEAK_MS = 4000; // VERIFY: 4 s po mowie

  // Stany
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);
  const [micError, setMicError] = useState<string | null>(null);
  const [showSilenceHint, _setShowSilenceHint] = useState(false);
  const showSilenceHintRef = useRef(false);
  const setShowSilenceHint = (v: boolean) => { showSilenceHintRef.current = v; _setShowSilenceHint(v); };
  const [speakingBlink, setSpeakingBlink] = useState(false);

  // SAY – transkrypt pod pytaniem
  const [sayTranscript, setSayTranscript] = useState<string>("");
  const sayActiveRef = useRef(false);

  // Web Speech API – instancja
  const recognitionRef = useRef<any>(null);

  // Refy aktualnych wartości
  const isRunningRef = useRef(isRunning);
  const idxRef = useRef(idx);
  const stepsRef = useRef<PlanStep[]>([]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  // ===== TIMER SESJI =====
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
    if (countdownIdRef.current) {
      window.clearInterval(countdownIdRef.current);
      countdownIdRef.current = null;
    }
    endAtRef.current = null;
  }

  // Timery/RAF
  const stepTimerRef = useRef<number | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  const hardCapTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // *** WIELOKROTNY DETEKTOR CISZY ***
  const silenceWatchIdRef = useRef<number | null>(null);
  const lastSoundAtRef = useRef<number>(Date.now());

  function startSilenceWatch() {
    stopSilenceWatch();
    // start od „teraz” – jeśli nic nie mówisz, hint pojawi się po SILENCE_HINT_MS
    lastSoundAtRef.current = Date.now();
    silenceWatchIdRef.current = window.setInterval(() => {
      const dt = Date.now() - lastSoundAtRef.current;
      // jeśli nie ma analizera (np. brak zgody) — nadal licz czas i pokazuj hint
      if (dt >= SILENCE_HINT_MS) {
        if (!showSilenceHintRef.current) setShowSilenceHint(true);
      } else {
        if (showSilenceHintRef.current) setShowSilenceHint(false);
      }
    }, 300);
  }
  function stopSilenceWatch() {
    if (silenceWatchIdRef.current) {
      window.clearInterval(silenceWatchIdRef.current);
      silenceWatchIdRef.current = null;
    }
  }

  // AV
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const heardThisStepRef = useRef(false);
  const speakingFramesRef = useRef(0);

  /* ---- 1) Wczytaj plan ---- */
  useEffect(() => {
    (async () => {
      try {
        const { source, steps } = await loadDayPlanOrTxt(dayFileParam);
        setSteps(steps);
        setIdx(0);
        setDisplayText(steps[0]?.mode === "VERIFY" ? (steps[0].target || "") : (steps[0]?.prompt || ""));
        console.log(`[DAY ${dayFileParam}] source:`, source, `steps: ${steps.length}`);
      } catch (e) {
        console.error(e);
        const fallback = [{ mode: "VERIFY" as const, target: "Brak treści dla tego dnia." }];
        setSteps(fallback);
        setDisplayText(fallback[0].target!);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- 2) Start/Stop AV + VAD ---- */
  async function startAV(): Promise<boolean> {
    stopAV();
    setMicError(null);
    speakingFramesRef.current = 0;

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

        const speakingNow = (rms > 0.017) || (peak > 0.040) || (vu > 7);
        if (speakingNow) {
          speakingFramesRef.current += 1;
          lastSoundAtRef.current = Date.now();   // reset licznika ciszy
          if (showSilenceHintRef.current) setShowSilenceHint(false);

          if (speakingFramesRef.current >= SPEAKING_FRAMES_REQUIRED) {
            setSpeakingBlink(true);
            const s = stepsRef.current[idxRef.current];

            // VERIFY: przy pierwszym głosie uruchom 4s do next
            if (s?.mode === "VERIFY" && !heardThisStepRef.current) {
              heardThisStepRef.current = true;
              if (hardCapTimerRef.current) window.clearTimeout(hardCapTimerRef.current);
              const thisIdx = idxRef.current;
              if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
              advanceTimerRef.current = window.setTimeout(() => {
                if (idxRef.current === thisIdx) gotoNext(thisIdx);
              }, ADVANCE_AFTER_SPEAK_MS);
            }
          }
        } else {
          speakingFramesRef.current = 0;
          // dalszą logikę ciszy obsługuje watcher
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

  /* ===== SAY: Web Speech API (natychmiastowy transcript) ===== */
  function startSayCapture() {
    sayActiveRef.current = true;
    setSayTranscript("");
    stopSayCapture(); // safety

    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!SR) {
      console.warn("Web Speech API niedostępne w tej przeglądarce.");
      return;
    }

    const rec = new SR();
    recognitionRef.current = rec;

    rec.lang = "pl-PL";       // zmień wg potrzeby
    rec.continuous = true;
    rec.interimResults = true;

    let buffer = "";

    rec.onresult = (e: any) => {
      let interim = "";
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          finalText += res[0].transcript;
        } else {
          interim += res[0].transcript;
        }
      }
      const composed = (buffer + finalText + interim).trim();
      setSayTranscript(composed);
      if (finalText) buffer += finalText + " ";
      lastSoundAtRef.current = Date.now(); // mowa → reset ciszy
      if (showSilenceHintRef.current) setShowSilenceHint(false);
    };

    rec.onerror = (err: any) => {
      console.warn("SpeechRecognition error:", err?.error || err);
    };

    rec.onend = () => {
      if (sayActiveRef.current) {
        try { rec.start(); } catch {}
      }
    };

    try {
      rec.start();
    } catch (e) {
      console.warn("SpeechRecognition start error:", e);
    }
  }

  function stopSayCapture() {
    sayActiveRef.current = false;
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.onend = null; rec.stop(); } catch {}
    }
    recognitionRef.current = null;
  }

  /* ---- 3) Timery + kroki ---- */
  function clearStepTimers() {
    [stepTimerRef, advanceTimerRef, hardCapTimerRef].forEach(ref => {
      if (ref.current) window.clearTimeout(ref.current);
      ref.current = null;
    });
    stopSilenceWatch();
    setShowSilenceHint(false);
  }

  function runStep(i: number) {
    if (!stepsRef.current.length) return;
    const s = stepsRef.current[i];
    if (!s) return;

    clearStepTimers();
    heardThisStepRef.current = false;
    speakingFramesRef.current = 0;
    lastSoundAtRef.current = Date.now();

    // uruchom watcher ciszy *na każdym kroku*
    startSilenceWatch();

    if (s.mode === "VERIFY") {
      stopSayCapture();
      setDisplayText(s.target || "");

      // awaryjny cap, by nie utknąć
      hardCapTimerRef.current = window.setTimeout(() => {
        if (idxRef.current === i) gotoNext(i);
      }, HARD_CAP_MS);

    } else {
      const prep = Number(s.prep_ms ?? 2000);
      const dwell = Number(s.dwell_ms ?? 12000);

      stopSayCapture();
      setDisplayText(s.prompt || "");
      setSayTranscript("");

      // po prep_ms start transkrypcji
      stepTimerRef.current = window.setTimeout(() => {
        if (idxRef.current !== i) return;
        startSayCapture();

        // po dwell_ms kończymy SAY i przechodzimy dalej
        stepTimerRef.current = window.setTimeout(() => {
          if (idxRef.current !== i) return;
          stopSayCapture();
          gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearStepTimers();
    const next = (i + 1) % stepsRef.current.length;
    setIdx(next);
    const n = stepsRef.current[next];
    setDisplayText(n?.mode === "VERIFY" ? (n?.target || "") : (n?.prompt || ""));
    runStep(next);
  }

  /* ---- 4) Start/Stop sesji ---- */
  const startSession = async () => {
    if (!stepsRef.current.length) return;
    const ok = await startAV();
    // niezależnie od powodzenia audio — watcher ciszy ma działać (fail-safe)
    startSilenceWatch();

    if (!ok) { setIsRunning(false); return; }
    setIsRunning(true);
    startCountdown(MAX_TIME);
    setIdx(0);
    setDisplayText(stepsRef.current[0]?.mode === "VERIFY" ? (stepsRef.current[0].target || "") : (stepsRef.current[0]?.prompt || ""));
    runStep(0);
  };

  const stopSession = () => {
    setIsRunning(false);
    stopCountdown();
    clearStepTimers();
    stopSayCapture();
    stopAV();
    setLevelPct(0);
  };

  /* ---- 5) Render ---- */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // Styl pytania i transcriptu (czytelnie, ale nie „super grubo”)
  const questionStyle: React.CSSProperties = {
    fontSize: "clamp(18px, 3.6vw, 22px)",
    lineHeight: 1.5,
    maxWidth: 820,
    margin: "0 auto",
    textShadow: "0 1px 2px rgba(0,0,0,0.35)",
  };
  const transcriptStyle: React.CSSProperties = {
    marginTop: 14,
    fontSize: "clamp(18px, 4.2vw, 24px)",
    lineHeight: 1.35,
    fontWeight: 500,
    letterSpacing: "0.2px",
    opacity: 0.98,
    minHeight: 32,
    textAlign: "center",
    padding: "10px 12px",
    background: "rgba(0,0,0,0.22)",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    textShadow: "0 1px 2px rgba(0,0,0,0.40)",
    boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
    maxWidth: 820,
    marginLeft: "auto",
    marginRight: "auto",
    backdropFilter: "blur(2px)",
  };
  const hintStyle: React.CSSProperties = {
    marginTop: 10,
    textAlign: "center",
    fontSize: 15,
    lineHeight: 1.35,
    color: "rgba(255,255,255,0.94)",
    textShadow: "0 1px 2px rgba(0,0,0,0.55)",
    opacity: showSilenceHint ? 0.98 : 0,
    transition: "opacity 180ms ease",
    pointerEvents: "none",
  };

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

        {/* OVERLAY START */}
        {!isRunning && (
          <div className="overlay center">
            <div className="intro" style={{ textAlign: "center", maxWidth: 520, lineHeight: 1.6 }}>
              <p style={{ fontSize: 16, opacity: 0.9, lineHeight: 1.6 }}>
                Twoja sesja potrwa około <b>6 minut</b>.<br />
                Prosimy o <b>wyraźne powtarzanie</b> pojawiających się wyrazów.
              </p>

              <p style={{ marginTop: 10, fontSize: 15, opacity: 0.85 }}>
                Aktywowano system analizy dźwięku <b>MeRoar™</b>
              </p>

              {micError && (
                <p style={{ marginTop: 16, color: "#ffb3b3", fontSize: 14 }}>
                  {micError} — upewnij się, że przeglądarka ma dostęp do mikrofonu i kamery.
                </p>
              )}
            </div>
          </div>
        )}

        {/* OVERLAY SESJI */}
        {isRunning && (
          <div className="overlay center" style={{ paddingBottom: 64 }}>
            {/* VERIFY = tekst do powtórzenia */}
            {steps[idx]?.mode === "VERIFY" && (
              <div className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
                {displayText}
              </div>
            )}

            {/* SAY = pytanie + transkrypt + hint inline (zawsze w kadrze) */}
            {steps[idx]?.mode === "SAY" && (
              <div className="center-text fade" style={{ whiteSpace: "pre-wrap", position: "relative", maxWidth: 900, margin: "0 auto" }}>
                <div style={questionStyle}>{displayText}</div>
                <div style={transcriptStyle}>{sayTranscript}</div>
                <div style={hintStyle}>Czy możesz powiedzieć coś na głos?</div>
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

