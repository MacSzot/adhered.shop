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
  const SILENCE_HINT_MS = 7000;        // 7 s ciszy → hint stage 1
  const SILENCE_HINT_MS_2 = 14000;     // 14 s od startu kroku → hint stage 2
  const SILENCE_HINT_MS_3 = 21000;     // 21 s od startu kroku → hint stage 3 (tap to continue)
  const HARD_CAP_MS = 12000;           // twardy limit pojedynczego kroku (VERIFY i SAY)
  const ADVANCE_AFTER_SPEAK_MS = 4000; // VERIFY: 4 s po wykryciu głosu
  const SAY_PREP_MS = 1200;            // czas na przeczytanie pytania
  const SAY_DWELL_MS = 12000;          // okno mówienia
  // Hints (PL ustalenia)
  const HINTS = [
    "", // off
    "Jeśli możesz, postaraj się przeczytać na głos.",
    "Pamiętaj, to przestrzeń pełna szacunku do Ciebie.",
    "Jeśli chcesz kontynuować, dotknij ekranu.",
  ];

  // Stany
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);
  const [micError, setMicError] = useState<string | null>(null);

  // Przypominajki — etap 0..3
  const [hintStage, _setHintStage] = useState<0 | 1 | 2 | 3>(0);
  const hintStageRef = useRef<0 | 1 | 2 | 3>(0);
  const setHintStage = (st: 0 | 1 | 2 | 3) => {
    hintStageRef.current = st;
    _setHintStage(st);
  };
  // Po dotknięciu przy 3 — wyłączamy aż do końca sesji
  const hintsDisabledRef = useRef(false);

  const [speakingBlink, setSpeakingBlink] = useState(false);

  // SAY – transkrypt (na żywo) pod komendą (środek ekranu)
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
      window.clearInterval(countdownIdRefRef.current!);
    }
    countdownIdRef.current = null;
    endAtRef.current = null;
  }

  // Timery/RAF
  const stepTimerRef = useRef<number | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  const hardCapTimerRef = useRef<number | null>(null);
  const firstHintTimerRef = useRef<number | null>(null);
  const secondHintTimerRef = useRef<number | null>(null);
  const thirdHintTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

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

          // mowa → chowamy hint (jeśli jeszcze aktywny) – ale nie resetujemy stage
          if (hintStageRef.current > 0 && hintStageRef.current < 3) {
            setHintStage(0);
          }

          if (speakingFramesRef.current >= SPEAKING_FRAMES_REQUIRED) {
            setSpeakingBlink(true);
            const s = stepsRef.current[idxRef.current];

            // VERIFY: przy pierwszym głosie uruchom 4s do next
            if (s?.mode === "VERIFY" && !heardThisStepRef.current) {
              heardThisStepRef.current = true;
              if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
              const thisIdx = idxRef.current;
              advanceTimerRef.current = window.setTimeout(() => {
                if (idxRef.current === thisIdx) gotoNext(thisIdx);
              }, ADVANCE_AFTER_SPEAK_MS);
            }
          }
        } else {
          speakingFramesRef.current = 0;
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

  /* ===== SAY: Web Speech API (natychmiastowy fallback) ===== */
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

    rec.lang = "pl-PL";
    rec.continuous = true;
    rec.interimResults = true;

    let buffer = "";

    rec.onresult = (e: any) => {
      let interim = "";
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      const composed = (buffer + finalText + interim).trim();
      setSayTranscript(composed);
      if (!hintsDisabledRef.current && hintStageRef.current > 0 && hintStageRef.current < 3) {
        setHintStage(0);
      }
      if (finalText) buffer += finalText + " ";
    };

    rec.onerror = (err: any) => {
      console.warn("SpeechRecognition error:", err?.error || err);
    };

    rec.onend = () => {
      if (sayActiveRef.current) {
        try { rec.start(); } catch {}
      }
    };

    try { rec.start(); } catch (e) { console.warn("SpeechRecognition start error:", e); }
  }

  function stopSayCapture() {
    sayActiveRef.current = false;
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.onend = null; rec.stop(); } catch {}
    }
    recognitionRef.current = null;
  }

  /* ---- Timery pomocnicze ---- */
  function clearStepTimers() {
    [stepTimerRef, advanceTimerRef, hardCapTimerRef, firstHintTimerRef, secondHintTimerRef, thirdHintTimerRef].forEach(ref => {
      if (ref.current) window.clearTimeout(ref.current);
      ref.current = null;
    });
  }

  function armHintsForStep(i: number) {
    if (hintsDisabledRef.current) { setHintStage(0); return; }

    // 7 s → hint 1
    firstHintTimerRef.current = window.setTimeout(() => {
      if (idxRef.current === i && !hintsDisabledRef.current) setHintStage(1);
    }, SILENCE_HINT_MS);

    // 14 s → hint 2
    secondHintTimerRef.current = window.setTimeout(() => {
      if (idxRef.current === i && !hintsDisabledRef.current) setHintStage(2);
    }, SILENCE_HINT_MS_2);

    // 21 s → hint 3 (tap to continue)
    thirdHintTimerRef.current = window.setTimeout(() => {
      if (idxRef.current === i && !hintsDisabledRef.current) {
        setHintStage(3);
        // w tym stanie jedno tapnięcie wyłącza przypominajki na resztę sesji
        const onTap = () => {
          hintsDisabledRef.current = true;
          setHintStage(0);
          document.removeEventListener("click", onTap);
        };
        document.addEventListener("click", onTap, { once: true });
      }
    }, SILENCE_HINT_MS_3);
  }

  /* ---- 3) Kroki ---- */
  function runStep(i: number) {
    if (!stepsRef.current.length) return;
    const s = stepsRef.current[i];
    if (!s) return;

    clearStepTimers();
    heardThisStepRef.current = false;
    speakingFramesRef.current = 0;
    setHintStage(0);

    if (s.mode === "VERIFY") {
      stopSayCapture();
      setDisplayText(s.target || "");
      // Hints dla ciszy (sekwencja 1→2→3)
      armHintsForStep(i);
      // Twardy limit kroku (ostatnia linia obrony)
      hardCapTimerRef.current = window.setTimeout(() => {
        if (idxRef.current === i) gotoNext(i);
      }, HARD_CAP_MS);
    } else {
      const prep = Number(s.prep_ms ?? SAY_PREP_MS);
      const dwell = Number(s.dwell_ms ?? SAY_DWELL_MS);

      stopSayCapture();
      setDisplayText(s.prompt || "");
      setSayTranscript("");

      armHintsForStep(i);

      stepTimerRef.current = window.setTimeout(() => {
        if (idxRef.current !== i) return;
        startSayCapture();

        // po dwell kończymy SAY i przechodzimy dalej
        stepTimerRef.current = window.setTimeout(() => {
          if (idxRef.current !== i) return;
          stopSayCapture();
          setHintStage(0);
          gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearStepTimers();
    setHintStage(0);
    stopSayCapture();
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
    hintsDisabledRef.current = false;
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
    setHintStage(0);
  };

  /* ---- 5) Render ---- */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // Style
  const headerStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between" };

  const questionStyle: React.CSSProperties = {
    fontSize: 22, // większa czcionka dla komend/poleceń
    lineHeight: 1.5,
    maxWidth: 780,
    margin: "0 auto",
    textAlign: "center",
    color: "#fff",
    textShadow: "0 2px 7px rgba(0,0,0,0.7)",
    whiteSpace: "pre-wrap",
  };

  const centerWrap: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    width: "min(92vw, 780px)",
    textAlign: "center",
    pointerEvents: "none",
  };

  const transcriptCenterStyle: React.CSSProperties = {
    marginTop: 18,
    fontSize: 18,
    fontWeight: 500,
    color: "#fff",
    textShadow: "0 2px 6px rgba(0,0,0,0.7)",
    lineHeight: 1.4,
    minHeight: 24,
  };

  const hintStyle: React.CSSProperties = {
    position: "absolute",
    left: 0, right: 0, bottom: 72,
    padding: "0 24px",
    textAlign: "center",
    fontSize: 15,
    lineHeight: 1.35,
    color: "rgba(255,255,255,0.96)",
    textShadow: "0 1px 2px rgba(0,0,0,0.6)",
    pointerEvents: "none",
  };

  return (
    <main className="prompter-full">
      <header className="topbar topbar--dense" style={headerStyle}>
        <nav className="tabs">
          <a className="tab active" href="/day" aria-current="page">Prompter</a>
          <span className="tab disabled" aria-disabled="true" title="Wkrótce">Rysownik</span>
        </nav>
        <div className="top-info compact">
          <span className="meta"><b>Użytkownik:</b> {USER_NAME}</span>
          {/* <span className="dot">•</span>  ← usunięta kropka/separator */}
          <span className="meta" style={{ marginLeft: 12 }}><b>Dzień programu:</b> {DAY_LABEL}</span>
        </div>
        <div className="controls-top">
          {!isRunning ? (
            <button className="btn" onClick={startSession}>Start</button>
          ) : (
            <button className="btn" onClick={stopSession}>Stop</button>
          )}
        </div>
      </header>

      {/* ZEGAR NA GÓRZE */}
      <div className="timer-top timer-top--strong">{fmt(remaining)}</div>

      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* OVERLAY START (intro) */}
        {!isRunning && (
          <div className="overlay center">
            <div
              style={{
                textAlign: "center",
                color: "white",
                textShadow: "0 2px 7px rgba(0,0,0,0.7)",
                maxWidth: 520,
                margin: "0 auto",
                padding: "0 20px",
                lineHeight: 1.6,
                fontSize: 18,
              }}
            >
              Twoja sesja potrwa około <b>6 minut</b>.<br />
              Postaraj się <b>wyraźnie powtarzać</b> wyświetlane treści.
            </div>

            <img
              src="/assets/meroar-supervised.png"
              alt="Supervised by MeRoar & adhered."
              style={{
                position: "fixed",
                bottom: 8,
                left: "50%",
                transform: "translateX(-50%)",
                width: "48%",
                maxWidth: 240,
                height: "auto",
                objectFit: "contain",
                opacity: 0.92,
                pointerEvents: "none",
              }}
            />

            {micError && (
              <p style={{ marginTop: 16, color: "#ffb3b3", fontSize: 14, textAlign: "center" }}>
                {micError} — sprawdź dostęp do mikrofonu i kamery.
              </p>
            )}
          </div>
        )}

        {/* OVERLAY SESJI */}
        {isRunning && (
          <div className="overlay center" style={{ position: "relative" }}>
            {/* CENTRALNY WRAP: pytanie/komenda + transkrypt */}
            <div style={centerWrap}>
              <div style={questionStyle}>
                {steps[idx]?.mode === "VERIFY" ? displayText : displayText}
              </div>
              {steps[idx]?.mode === "SAY" && (
                <div style={transcriptCenterStyle}>{sayTranscript}</div>
              )}
            </div>

            {/* HINTY */}
            {hintStage > 0 && (
              <div style={hintStyle}>
                {HINTS[hintStage]}
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




