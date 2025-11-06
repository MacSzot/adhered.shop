// app/day/page.tsx
"use client";

import { useEffect, useRef, useState } from "react";

/* =============== PLAN DNIA =============== */
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;
  prompt?: string;
  prep_ms?: number;   // opóźnienie przed startem kroku
  dwell_ms?: number;  // okno SAY (tu nie używamy do VERIFY – mamy stałe reguły)
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

/* =============== WEB SPEECH (opcjonalnie) =============== */
type SpeechRecType = any;
function getSpeechRecognition(): SpeechRecType | null {
  if (typeof window === "undefined") return null;
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  return SR ? new SR() : null;
}

/* =============== PAGE =============== */
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Ustawienia stałe
  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "01") : "01";
  const dayFileParam = dayRaw.padStart(2, "0");
  const DAY_LABEL = (() => {
    const n = parseInt(dayRaw, 10);
    return Number.isNaN(n) ? dayRaw : String(n);
  })();

  const MAX_TIME = 6 * 60;       // 6 minut sesji
  const VERIFY_SPEAK_TIME = 5000; // 5s od pierwszego głosu → zielony
  const VERIFY_FLASH_TIME = 1000; // zielony flash 1s
  const SAY_TOTAL_LIMIT = 12000;  // twarde 12s od startu SAY
  const SAY_GREEN_AT = 11000;     // 11s = zielony flash 1s
  const SILENCE_TIMEOUT = 10000;  // 10s ciszy → pauza/overlay

  // VAD progi
  const SPEAKING_FRAMES_REQUIRED = 2;

  // Stany UI
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>(""); // aktualny prompt / verify sentence
  const [sayTranscript, setSayTranscript] = useState<string>(""); // tekst użytkownika (SAY)
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);   // ręczna pauza (nie używamy tutaj – mamy pauzę ciszy)
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);
  const [micError, setMicError] = useState<string | null>(null);
  const [hasStream, setHasStream] = useState(false);

  // Pauza ciszy
  const [silencePause, setSilencePause] = useState(false);

  // Zielony flash
  const [flashGreen, setFlashGreen] = useState(false);

  // Refs dla aktualnych wartości
  const isRunningRef = useRef(isRunning);
  const idxRef = useRef(idx);
  const stepsRef = useRef<PlanStep[]>([]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  // Licznik sesji
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

  // Timery kroków
  const stepTimerRef = useRef<number | null>(null);     // uniwersalne timery
  const verifyTimerRef = useRef<number | null>(null);   // 5s od pierwszego głosu
  const sayLimitTimerRef = useRef<number | null>(null); // 12s twardy limit
  const sayGreenTimerRef = useRef<number | null>(null); // 11s zielony flash
  const silenceTimerRef = useRef<number | null>(null);  // 10s ciszy – overlay

  // AV
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const speakingFramesRef = useRef(0);
  const heardThisStepRef = useRef(false);
  const lastVoiceAtRef = useRef<number>(Date.now());

  // Web Speech (opcjonalnie – tylko SAY)
  const speechRecRef = useRef<SpeechRecType | null>(null);
  const speechActiveRef = useRef(false);

  // Pauza: ile czasu zostało, gdy zatrzymamy licznik
  const pausedRemainingRef = useRef<number | null>(null);

  /* ---- 1) Wczytaj plan ---- */
  useEffect(() => {
    (async () => {
      try {
        const { source, steps } = await loadDayPlanOrTxt(dayFileParam);
        setSteps(steps);
        setIdx(0);
        setDisplayText(steps[0]?.mode === "VERIFY" ? (steps[0].target || "") : (steps[0]?.prompt || ""));
        // eslint-disable-next-line no-console
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

  /* ---- 2) Start/Stop AV + VU + watchdog ciszy ---- */
  async function startAV(): Promise<boolean> {
    setMicError(null);
    speakingFramesRef.current = 0;
    lastVoiceAtRef.current = Date.now();

    try {
      if (!streamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        streamRef.current = stream;
        if (videoRef.current) (videoRef.current as any).srcObject = stream;
      }
      setHasStream(true);

      if (!audioCtxRef.current) {
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
        analyser.smoothingTimeConstant = 0.75; // szybsza reaktywność
        ac.createMediaStreamSource(streamRef.current!).connect(analyser);
        analyserRef.current = analyser;

        const data = new Uint8Array(analyser.fftSize);
        const loop = () => {
          if (!analyserRef.current) return;
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

          // VU paskek
          setLevelPct(prev => Math.max(vu, prev * 0.82));

          const speakingNow = (rms > 0.017) || (peak > 0.040) || (vu > 7);
          const now = Date.now();

          if (isRunningRef.current) {
            if (speakingNow) {
              speakingFramesRef.current += 1;
              if (speakingFramesRef.current >= SPEAKING_FRAMES_REQUIRED) {
                // Zarejestrowaliśmy głos
                if (!heardThisStepRef.current) {
                  heardThisStepRef.current = true;
                  onFirstVoiceHeard(); // reakcja zależna od typu kroku
                }
                lastVoiceAtRef.current = now;
              }
            } else {
              speakingFramesRef.current = 0;
            }

            // Pauza ciszy – jeśli nie było głosu przez 10s od ostatniego realnego głosu
            if (!silencePause) {
              const delta = now - lastVoiceAtRef.current;
              if (delta >= SILENCE_TIMEOUT) {
                triggerSilencePause();
              }
            }
          }

          rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);
      }

      return true;
    } catch (err: any) {
      console.error("getUserMedia error:", err);
      setMicError(err?.name === "NotAllowedError" ? "Brak zgody na mikrofon/kamerę." : "Nie udało się uruchomić mikrofonu/kamery.");
      return false;
    }
  }

  function stopAV() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    setHasStream(false);
  }

  /* ---- 3) Obsługa kroków i reguł (VERIFY/SAY) ---- */
  function clearAllStepTimers() {
    [stepTimerRef, verifyTimerRef, sayLimitTimerRef, sayGreenTimerRef, silenceTimerRef].forEach(ref => {
      if (ref.current) { window.clearTimeout(ref.current); ref.current = null; }
    });
  }

  function onFirstVoiceHeard() {
    // reset zegara ciszy
    lastVoiceAtRef.current = Date.now();

    const s = stepsRef.current[idxRef.current];
    if (!s) return;

    if (s.mode === "VERIFY") {
      // Startujemy 5s licznik → flash 1s → NEXT
      if (verifyTimerRef.current) { clearTimeout(verifyTimerRef.current); }
      verifyTimerRef.current = window.setTimeout(() => {
        // 5 sekund mówienia minęło – flash na zielono 1s
        setFlashGreen(true);
        const t = window.setTimeout(() => {
          setFlashGreen(false);
          gotoNext(idxRef.current);
        }, VERIFY_FLASH_TIME);
        stepTimerRef.current = t;
      }, VERIFY_SPEAK_TIME);
    }

    // W SAY nie zmieniamy czasu – działa twardy limit od startu kroku.
  }

  function triggerSilencePause() {
    // Zatrzymaj licznik sesji
    let secsLeft = remaining;
    if (endAtRef.current != null) {
      secsLeft = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
    }
    pausedRemainingRef.current = secsLeft;
    stopCountdown();

    // Wstrzymaj wszystko i pokaż overlay
    setSilencePause(true);
    setIsRunning(false);

    // Zatrzymaj ewentualne timery kroku
    clearAllStepTimers();
  }

  function clickSilenceOverlayGoNext() {
    // Przejście do następnego zdania (tak jak ustaliliśmy)
    setSilencePause(false);
    setFlashGreen(false);
    gotoNext(idxRef.current);

    // Wznów licznik od miejsca zatrzymania
    const secs = pausedRemainingRef.current ?? remaining;
    startCountdown(secs);
    setIsRunning(true);
    lastVoiceAtRef.current = Date.now();
  }

  function runStep(i: number) {
    clearAllStepTimers();
    setFlashGreen(false);
    heardThisStepRef.current = false;
    setSayTranscript("");
    lastVoiceAtRef.current = Date.now(); // start liczenia ciszy dla kroku

    const s = stepsRef.current[i];
    if (!s) return;

    // Ustaw tekst
    if (s.mode === "VERIFY") {
      setDisplayText(s.target || "");
    } else {
      setDisplayText(s.prompt || "");
    }

    // Ewentualne opóźnienie startu kroku
    const prep = Number(s.prep_ms ?? 0);

    if (s.mode === "SAY") {
      // Twardy limit: 12s od startu kroku
      sayGreenTimerRef.current = window.setTimeout(() => setFlashGreen(true), prep + SAY_GREEN_AT);
      sayLimitTimerRef.current = window.setTimeout(() => {
        setFlashGreen(false);
        gotoNext(i);
      }, prep + SAY_TOTAL_LIMIT);

      // Opcjonalna transkrypcja przez Web Speech (jeśli dostępna w przeglądarce)
      const rec = getSpeechRecognition();
      if (rec) {
        try {
          rec.lang = "pl-PL";
          rec.continuous = true;
          rec.interimResults = true;
          rec.onresult = (ev: any) => {
            let txt = "";
            for (let j = ev.resultIndex; j < ev.results.length; j++) {
              const res = ev.results[j];
              txt += res[0]?.transcript || "";
            }
            if (txt && isRunningRef.current) {
              setSayTranscript(txt.trim());
              lastVoiceAtRef.current = Date.now();
            }
          };
          rec.onerror = () => {};
          rec.onend = () => { speechActiveRef.current = false; };
          speechRecRef.current = rec;
          speechActiveRef.current = true;
          const startSpeech = () => { try { rec.start(); } catch {} };
          // start po ewentualnym prep
          stepTimerRef.current = window.setTimeout(startSpeech, prep);
        } catch {}
      } else {
        // Brak Web Speech – pokaż wskaźnik „żyje” po starcie
        stepTimerRef.current = window.setTimeout(() => setSayTranscript("…"), prep + 200);
      }
    }

    if (s.mode === "VERIFY") {
      // W VERIFY nic nie liczymy „z góry” – czekamy na pierwszą mowę (onFirstVoiceHeard)
      // Dodatkowo: jeśli przez 10s ciszy od startu kroku – overlay (obsługa w pętli VAD)
    }
  }

  function gotoNext(i: number) {
    clearAllStepTimers();
    setFlashGreen(false);

    // Zatrzymaj Web Speech jeśli działał
    if (speechActiveRef.current && speechRecRef.current) {
      try { speechRecRef.current.stop(); } catch {}
      speechActiveRef.current = false;
      speechRecRef.current = null;
    }

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
    if (!ok) { setIsRunning(false); return; }
    setIsRunning(true);
    setSilencePause(false);
    pausedRemainingRef.current = null;
    startCountdown(MAX_TIME);
    setIdx(0);
    const first = stepsRef.current[0];
    setDisplayText(first?.mode === "VERIFY" ? (first?.target || "") : (first?.prompt || ""));
    runStep(0);
  };

  const stopSession = () => {
    setIsRunning(false);
    setSilencePause(false);
    stopCountdown();
    clearAllStepTimers();

    if (speechActiveRef.current && speechRecRef.current) {
      try { speechRecRef.current.stop(); } catch {}
      speechActiveRef.current = false;
      speechRecRef.current = null;
    }

    stopAV();
    setLevelPct(0);
    setSayTranscript("");
    setFlashGreen(false);
    pausedRemainingRef.current = null;
    setRemaining(MAX_TIME);
  };

  /* ---- 5) Render ---- */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // Style środkowe (większe komendy) oraz wyróżnienie SAY
  const questionStyle: React.CSSProperties = {
    fontSize: "clamp(18px, 1.8vw, 22px)",
    lineHeight: 1.55,
    maxWidth: 720,
    margin: "0 auto",
    textAlign: "center",
    opacity: 0.65,
  };
  const transcriptStyle: React.CSSProperties = {
    marginTop: 16,
    fontSize: "clamp(28px, 3.2vw, 48px)",
    fontWeight: 800,
    textAlign: "center",
    textShadow: "0 0 22px rgba(0,0,0,.95)",
    letterSpacing: "0.01em",
    wordSpacing: "0.06em",
    opacity: 0.98,
    transition: "color .25s ease, opacity .25s ease",
    color: flashGreen ? "#35ff7a" : "#ffffff",
    minHeight: 36
  };
  const verifyStyle: React.CSSProperties = {
    whiteSpace: "pre-wrap",
    textAlign: "center",
    fontSize: "clamp(20px, 3vw, 38px)", // lekko większe
    lineHeight: 1.45,
    maxWidth: 760,
    margin: "0 auto",
    color: flashGreen ? "#35ff7a" : "rgba(255,255,255,.85)",
    textShadow: "0 0 18px rgba(0,0,0,.9)",
    transition: "color .25s ease"
  };

  return (
    <main className="prompter-full">
      {/* GÓRNY PANEL – BEZ ZMIAN */}
      <header className="topbar topbar--dense topbar--tall">
        <div className="top-sides">
          <div className="top-left">
            <div className="line"><b>Użytkownik:</b> {USER_NAME}</div>
            <div className="line"><b>Dzień programu:</b> {DAY_LABEL}</div>
          </div>
          <div className="controls-vert">
            {isRunning ? (
              <>
                <button className="btn-ghost" onClick={() => triggerSilencePause()}>Pause</button>
                <button className="btn-ghost" onClick={stopSession}>Stop</button>
              </>
            ) : (
              <button className="btn-ghost" onClick={startSession}>{isPaused ? "Wznów" : "Start"}</button>
            )}
          </div>
        </div>
      </header>

      <div className="timer-top timer-top--strong" style={{ textAlign: "center" }}>{fmt(remaining)}</div>

      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`cam ${!hasStream ? "video-hidden" : ""}`}
        />

        {/* EKRAN STARTOWY */}
        {!isRunning && !silencePause && (
          <>
            <div className="overlay center">
              <div className="intro" style={{ textAlign: "center", maxWidth: 520, lineHeight: 1.6, margin: "0 auto" }}>
                <p style={{ fontSize: 15.5, opacity: 0.92 }}>
                  Twoja sesja potrwa około <b>6 minut</b>.<br />
                  Prosimy o powtarzanie na głos wyświetlanych treści.
                </p>
                {micError && (
                  <p style={{ marginTop: 12, color: "#ffb3b3", fontSize: 14 }}>
                    {micError} — sprawdź dostęp do mikrofonu i kamery.
                  </p>
                )}
              </div>
            </div>
            <button className="start-floating" onClick={startSession}>{isPaused ? "WZNÓW" : "START"}</button>
          </>
        )}

        {/* SESJA */}
        {isRunning && (
          <div className="overlay center" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: "100%", padding: "0 16px" }}>
              {/* VERIFY */}
              {steps[idx]?.mode === "VERIFY" && (
                <div className="center-text fade" style={verifyStyle}>
                  {displayText}
                </div>
              )}

              {/* SAY */}
              {steps[idx]?.mode === "SAY" && (
                <div className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
                  <div style={questionStyle}>{displayText}</div>
                  <div style={transcriptStyle}>{sayTranscript || "…"}</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ⏸️ Overlay pauzy po 10 s ciszy – na dole; TAP = NEXT */}
        {silencePause && (
          <div
            className="pause-overlay"
            onClick={clickSilenceOverlayGoNext}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
              padding: 24,
              textAlign: "center",
              background: "rgba(0,0,0,0.35)",
              cursor: "pointer",
              zIndex: 50
            }}
          >
            <div style={{ maxWidth: 680, lineHeight: 1.5, marginBottom: 28 }}>
              <div style={{ fontSize: 18, marginBottom: 10 }}>
                Jeśli nie czujesz, że to dobry moment, zawsze możesz wrócić później.
              </div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>
                Jeśli chcesz kontynuować, dotknij ekranu.
              </div>
            </div>
          </div>
        )}

        {/* VU-meter */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}

