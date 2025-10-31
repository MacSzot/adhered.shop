"use client";

import { useEffect, useRef, useState } from "react";

/* =========================
   TYPY i PLAN DNIA
========================= */
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;          // VERIFY: tekst do powtórzenia
  prompt?: string;          // SAY: pytanie / komenda
  min_sentences?: number;
  starts_with?: string[];
  starts_with_any?: string[];
  prep_ms?: number;         // opóźnienie przed startem SAY (ms)
  dwell_ms?: number;        // czas na SAY (ms)
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

/* =========================
   POMOCNICZE
========================= */
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

/* =========================
   STRONA
========================= */
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // USTAWIENIA UI
  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "01") : "01";
  const dayFileParam = dayRaw.padStart(2, "0");
  const DAY_LABEL = (() => {
    const n = parseInt(dayRaw, 10);
    return Number.isNaN(n) ? dayRaw : String(n);
  })();

  // CZASY / PROGI
  const MAX_TIME = 6 * 60;               // 6 minut
  const SILENCE_HINT_MS = 7000;          // po 7 s ciszy wyświetl hint
  const HARD_CAP_MS = 12000;             // twardy limit kroku
  const ADVANCE_AFTER_SPEAK_MS = 4000;   // VERIFY: 4 s po wykryciu mowy → dalej
  const SPEAKING_FRAMES_REQUIRED = 2;    // ile kolejnych ramek RMS aby uznać „mówi”

  // STANY
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [levelPct, setLevelPct] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);

  // HINTY (3-etapowe, po 3-cim już nigdy ich nie pokazujemy w tej sesji)
  const HINTS: Record<1 | 2 | 3, string> = {
    1: "Jeśli możesz, postaraj się przeczytać na głos.",
    2: "Pamiętaj — to przestrzeń pełna szacunku do Ciebie.",
    3: "Jeśli chcesz kontynuować, dotknij ekranu.",
  };
  const [hintStage, setHintStage] = useState<0 | 1 | 2 | 3>(0);
  const [hintsLocked, setHintsLocked] = useState(false); // po 3-cim i dotknięciu blokujemy na resztę sesji
  const hintVisibleRef = useRef(false);

  // SAY – transkrypt (zawsze na dole, wyśrodkowany)
  const [sayTranscript, setSayTranscript] = useState<string>("");
  const sayActiveRef = useRef(false);
  const recognitionRef = useRef<any>(null);

  // Referencje aktualnych wartości
  const isRunningRef = useRef(isRunning);
  const idxRef = useRef(idx);
  const stepsRef = useRef<PlanStep[]>([]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  // TIMER SESJI
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

  // Timery/RAF dla kroków
  const stepTimerRef = useRef<number | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  const silenceHintTimerRef = useRef<number | null>(null);
  const hardCapTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // AUDIO/VIDEO
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const speakingFramesRef = useRef(0);
  const heardThisStepRef = useRef(false);

  /* =========================
     1) Wczytanie planu
  ========================= */
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

  /* =========================
     2) AV + VAD
  ========================= */
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
          // mówimy → chowamy hint
          if (hintVisibleRef.current) hideHint();
          if (speakingFramesRef.current >= SPEAKING_FRAMES_REQUIRED) {
            const s = stepsRef.current[idxRef.current];
            if (s?.mode === "VERIFY" && !heardThisStepRef.current) {
              heardThisStepRef.current = true;
              clearOnly(["silence", "hard"]);
              const thisIdx = idxRef.current;
              if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
              advanceTimerRef.current = window.setTimeout(() => {
                if (idxRef.current === thisIdx) gotoNext(thisIdx);
              }, ADVANCE_AFTER_SPEAK_MS);
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

  /* =========================
     SAY: Web Speech API
  ========================= */
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
      if (composed) hideHint();
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

  /* =========================
     Timery pomocnicze
  ========================= */
  function clearOnly(which: Array<"step"|"advance"|"silence"|"hard">) {
    for (const w of which) {
      if (w === "step" && stepTimerRef.current) { window.clearTimeout(stepTimerRef.current); stepTimerRef.current = null; }
      if (w === "advance" && advanceTimerRef.current) { window.clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null; }
      if (w === "silence" && silenceHintTimerRef.current) { window.clearTimeout(silenceHintTimerRef.current); silenceHintTimerRef.current = null; }
      if (w === "hard" && hardCapTimerRef.current) { window.clearTimeout(hardCapTimerRef.current); hardCapTimerRef.current = null; }
    }
  }
  function clearStepTimers() { clearOnly(["step","advance","silence","hard"]); }

  function showHintStage(iWanted: 1 | 2 | 3) {
    if (hintsLocked) return;
    setHintStage(iWanted);
    hintVisibleRef.current = true;
  }
  function hideHint() {
    hintVisibleRef.current = false;
  }

  function scheduleSilence(i: number) {
    if (hintsLocked) return;
    clearOnly(["silence"]);
    silenceHintTimerRef.current = window.setTimeout(() => {
      if (idxRef.current !== i || hintsLocked) return;
      // 1 → 2 → 3
      setHintStage(prev => {
        const next = (prev === 0 ? 1 : prev === 1 ? 2 : 3) as 1 | 2 | 3;
        if (next === 3) {
          // po 3-cim czekamy na tapnięcie – w onClick overlayu zamkniemy przypominajki na stałe
        }
        showHintStage(next);
        return next;
      });
    }, SILENCE_HINT_MS);
  }
  function scheduleHardCap(i: number) {
    clearOnly(["hard"]);
    hardCapTimerRef.current = window.setTimeout(() => {
      if (idxRef.current === i) {
        hideHint();
        stopSayCapture();
        gotoNext(i);
      }
    }, HARD_CAP_MS);
  }

  /* =========================
     3) Kroki
  ========================= */
  function runStep(i: number) {
    if (!stepsRef.current.length) return;
    const s = stepsRef.current[i];
    if (!s) return;

    clearStepTimers();
    heardThisStepRef.current = false;
    speakingFramesRef.current = 0;
    hideHint();

    if (s.mode === "VERIFY") {
      stopSayCapture();
      setSayTranscript("");
      setDisplayText(s.target || "");
      if (!hintsLocked) scheduleSilence(i);
      scheduleHardCap(i);
    } else {
      const prep = Number(s.prep_ms ?? 1000);
      const dwell = Number(s.dwell_ms ?? 12000);

      stopSayCapture();
      setSayTranscript("");
      setDisplayText(s.prompt || "");
      if (!hintsLocked) scheduleSilence(i);
      scheduleHardCap(i);

      stepTimerRef.current = window.setTimeout(() => {
        if (idxRef.current !== i) return;
        startSayCapture();
        // zakończ SAY po „dwell”
        stepTimerRef.current = window.setTimeout(() => {
          if (idxRef.current !== i) return;
          stopSayCapture();
          hideHint();
          gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearStepTimers();
    hideHint();
    stopSayCapture();
    const next = (i + 1) % stepsRef.current.length;
    setIdx(next);
    const n = stepsRef.current[next];
    setDisplayText(n?.mode === "VERIFY" ? (n?.target || "") : (n?.prompt || ""));
    runStep(next);
  }

  /* =========================
     4) Start/Stop sesji
  ========================= */
  const startSession = async () => {
    if (!stepsRef.current.length) return;
    const ok = await startAV();
    if (!ok) { setIsRunning(false); return; }
    setIsRunning(true);
    startCountdown(MAX_TIME);
    setIdx(0);
    setDisplayText(stepsRef.current[0]?.mode === "VERIFY" ? (stepsRef.current[0].target || "") : (stepsRef.current[0]?.prompt || ""));
    // reset hintów na początek sesji
    setHintStage(0);
    setHintsLocked(false);
    runStep(0);
  };

  const stopSession = () => {
    setIsRunning(false);
    stopCountdown();
    clearStepTimers();
    stopSayCapture();
    stopAV();
    setLevelPct(0);
    hideHint();
  };

  /* =========================
     RENDER
  ========================= */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const isSay = steps[idx]?.mode === "SAY";

  // Styl – intro, centralnie i wężej
  const introWrap: React.CSSProperties = {
    textAlign: "center",
    lineHeight: 1.55,
    maxWidth: 520,
    margin: "0 auto",
    padding: "0 24px",
  };

  // Komendy / pytania – większe i centralne
  const commandStyle: React.CSSProperties = {
    fontSize: 26,
    lineHeight: 1.5,
    maxWidth: 800,
    margin: "0 auto",
    textAlign: "center",
    whiteSpace: "pre-wrap",
  };

  // Transkrypt – bez tła, na dole, centralnie
  const transcriptWrap: React.CSSProperties = {
    position: "absolute",
    left: 0, right: 0,
    bottom: 90,                 // nad paskiem Safari
    padding: "0 24px",
    textAlign: "center",
    zIndex: 31,
    pointerEvents: "none",
  };
  const transcriptText: React.CSSProperties = {
    display: "inline-block",
    fontSize: 18,
    lineHeight: 1.4,
    maxWidth: 820,
    color: "rgba(255,255,255,0.98)",
    textShadow: "0 1px 2px rgba(0,0,0,0.65)",
  };

  // Hint – ~70% wysokości
  const hintStyle: React.CSSProperties = {
    position: "absolute",
    left: 0, right: 0,
    top: "68vh",
    padding: "0 24px",
    textAlign: "center",
    fontSize: 16,
    lineHeight: 1.35,
    color: "rgba(255,255,255,0.95)",
    textShadow: "0 1px 2px rgba(0,0,0,0.6)",
    transition: "opacity 160ms ease",
    zIndex: 30,
    opacity: hintStage > 0 ? 1 : 0,
    pointerEvents: hintStage > 0 ? "auto" : "none",
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
          <span className="dot" aria-hidden="true">•</span>
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

      {/* ZEGAR – zawsze na górze, wyśrodkowany */}
      <div className="timer-top timer-top--strong">{fmt(remaining)}</div>

      <div className="stage mirrored">
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* OVERLAY: INTRO */}
        {!isRunning && (
          <div className="overlay center">
            <div style={introWrap}>
              <p style={{ fontSize: 18 }}>
                Twoja sesja potrwa około <b>6 minut</b>.<br />
                Postaraj się <b>wyraźnie powtarzać</b> wyświetlane treści.
              </p>
              {micError && (
                <p style={{ marginTop: 16, color: "#ffb3b3", fontSize: 14 }}>
                  {micError} — sprawdź dostęp do mikrofonu i kamery.
                </p>
              )}
              {/* logo z /assets/supervised.png powinno być w public/assets */}
              <div style={{ marginTop: 36 }}>
                <img
                  src="/assets/supervised.png"
                  alt="Super-vised by MeRoar™ — Supervised by adhered."
                  style={{ width: 280, maxWidth: "70%", height: "auto", margin: "0 auto", display: "block" }}
                />
              </div>
            </div>
          </div>
        )}

        {/* OVERLAY SESJI */}
        {isRunning && (
          <div
            className="overlay center"
            style={{ position: "relative" }}
            onClick={() => {
              // Jeśli jest wyświetlona 3. przypominajka i użytkownik dotknie ekranu – blokujemy dalsze hinty
              if (hintStage === 3 && !hintsLocked) {
                setHintsLocked(true);
                setHintStage(0);
              }
            }}
          >
            {/* Tekst kroku centralnie */}
            <div className="center-text fade" style={commandStyle}>
              {displayText}
            </div>

            {/* SAY – transkrypt na dole, centralnie */}
            {isSay && (
              <div style={transcriptWrap}>
                <span style={transcriptText}>{sayTranscript}</span>
              </div>
            )}

            {/* PRZYPOMINAJKA (1→2→3; po 3-cim i tapnięciu – nigdy więcej) */}
            {hintStage > 0 && (
              <div style={hintStyle}>
                {HINTS[hintStage as 1 | 2 | 3]}
              </div>
            )}
          </div>
        )}

        {/* PIONOWY „VU” – po prawej, jako żywy wskaźnik dźwięku */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}


