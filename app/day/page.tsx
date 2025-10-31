"use client";

import { useEffect, useRef, useState } from "react";

/* ================== TYPY ================== */
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;  // VERIFY — tekst do powtórzenia
  prompt?: string;  // SAY — komenda/otwarte pytanie
  prep_ms?: number; // opóźnienie przed startem recognition
  dwell_ms?: number;// ile trwa okno SAY (mówienie + transkrypt)
};

/* ================== STAŁE ================== */
const USER_NAME = "demo";
const MAX_TIME_SEC = 6 * 60;         // 6 minut „cut-off” sesji
const SILENCE_HINT_MS = 7000;        // po tylu ms ciszy pokaż hint
const HARD_CAP_MS = 12000;           // maks. czas jednego kroku
const ADVANCE_AFTER_SPEAK_MS = 4000; // VERIFY: po wykryciu głosu ile czekamy do NEXT

// 1→2→3 i KONIEC (potem już nie przypominamy)
const HINTS: string[] = [
  "",
  "Jeśli możesz, postaraj się przeczytać na głos.",
  "Pamiętaj — to przestrzeń pełna szacunku do Ciebie.",
  "Jeśli chcesz kontynuować, dotknij ekranu.",
];

/* ================== PLAN DNIA ================== */
async function loadDayPlanOrTxt(dayFileParam: string): Promise<PlanStep[]> {
  try {
    const r = await fetch(`/days/${dayFileParam}.plan.json`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const steps = Array.isArray(j?.steps) ? (j.steps as PlanStep[]) : [];
      if (steps.length) return steps;
    }
  } catch {}
  try {
    const r2 = await fetch(`/days/${dayFileParam}.txt`, { cache: "no-store" });
    if (r2.ok) {
      const txt = await r2.text();
      return txt
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(line => ({ mode: "VERIFY" as const, target: line }));
    }
  } catch {}

  // ——— Fallback (Dzień 3 z trzema otwartymi) ———
  const fallback: PlanStep[] = [
    { mode: "VERIFY", target: "Jestem w bardzo dobrym miejscu." },
    { mode: "VERIFY", target: "Szacunek do siebie staje się naturalny." },
    { mode: "VERIFY", target: "W moim wnętrzu dojrzewa spokój i zgoda." },

    { mode: "SAY", prompt: "Popatrz na siebie i podziękuj sobie. Zrób to ze spokojem — Twoje słowa wyświetlą się na ekranie.", prep_ms: 800, dwell_ms: 12000 },

    { mode: "VERIFY", target: "Doceniam to, jak wiele już zostało zrobione." },
    { mode: "VERIFY", target: "Moje tempo jest wystarczające." },

    { mode: "SAY", prompt: "Popatrz na siebie i przyznaj sobie rację. Zrób to z przekonaniem — Twoje słowa wyświetlą się na ekranie.", prep_ms: 800, dwell_ms: 12000 },

    { mode: "VERIFY", target: "Uznaję swoją historię taką, jaka jest." },
    { mode: "VERIFY", target: "Podziwiam sposób przetrwania trudnych chwil." },

    { mode: "SAY", prompt: "Popatrz na siebie i pogratuluj sobie. Zrób to z radością — Twoje słowa wyświetlą się na ekranie.", prep_ms: 800, dwell_ms: 12000 },

    { mode: "VERIFY", target: "Szanuję wysiłek, który doprowadził mnie tutaj." },
    { mode: "VERIFY", target: "Dobre słowo o sobie zaczyna brzmieć naturalnie." },
  ];
  return fallback;
}

/* ================== POMOCNICZE ================== */
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

/* ================== KOMPONENT ================== */
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const dayRaw = typeof window !== "undefined" ? getParam("day", "03") : "03";
  const dayFileParam = dayRaw.padStart(2, "0");
  const DAY_LABEL = (() => {
    const n = parseInt(dayRaw, 10);
    return Number.isNaN(n) ? dayRaw : String(n);
  })();

  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);

  /* ----- ZEGAR SESJI ----- */
  const [remaining, setRemaining] = useState(MAX_TIME_SEC);
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

  /* ----- AUDIO/VIDEO + VAD ----- */
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const [levelPct, setLevelPct] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);

  async function startAV(): Promise<boolean> {
    stopAV();
    setMicError(null);

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
      if (videoRef.current) (videoRef.current as any).srcObject = stream;

      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new Ctx();
      audioCtxRef.current = ac;

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

        // prosty VAD → zapamiętujemy czy ktoś mówił (do timingu VERIFY / hintów)
        const speakingNow = (rms > 0.017) || (peak > 0.040) || (vu > 7);
        onVadFrame(speakingNow);

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

  /* ----- SAY: Web Speech API (transkrypt na GÓRZE) ----- */
  const recognitionRef = useRef<any>(null);
  const [sayTranscript, setSayTranscript] = useState("");
  const sayActiveRef = useRef(false);

  function startSayCapture() {
    sayActiveRef.current = true;
    setSayTranscript("");
    stopSayCapture(); // safety

    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!SR) {
      console.warn("Web Speech API niedostępne.");
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
      if (finalText) buffer += finalText + " ";

      // mówimy → wyłącz pierwszy hint (jeśli był)
      if (hintStageRef.current === 1) setHintStage(0);
    };
    rec.onerror = (err: any) => console.warn("SpeechRecognition error:", err?.error || err);
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

  /* ----- REFERENCJE BIEŻĄCYCH WARTOŚCI ----- */
  const isRunningRef = useRef(isRunning);
  const idxRef = useRef(idx);
  const stepsRef = useRef<PlanStep[]>([]);
  const heardThisStepRef = useRef(false);        // czy w VERIFY padł głos (do 4s auto-next)
  const silenceTimerRef = useRef<number | null>(null);
  const hardCapTimerRef = useRef<number | null>(null);
  const advanceTimerRef = useRef<number | null>(null);

  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  /* ----- HINTY: 1→2→3, a po 3 tap → wyłączamy już NA ZAWSZE ----- */
  const [hintStage, _setHintStage] = useState<0 | 1 | 2 | 3>(0);
  const hintStageRef = useRef<0 | 1 | 2 | 3>(0);
  function setHintStage(v: 0 | 1 | 2 | 3) { hintStageRef.current = v; _setHintStage(v); }
  const [hintsDisabledForever, setHintsDisabledForever] = useState(false);

  function scheduleSilenceHint(i: number) {
    if (hintsDisabledForever) return;
    clearSilenceHint();
    silenceTimerRef.current = window.setTimeout(() => {
      if (idxRef.current !== i || hintsDisabledForever) return;
      setHintStage(hintStageRef.current < 3 ? ((hintStageRef.current + 1) as 1 | 2 | 3) : 3);
    }, SILENCE_HINT_MS);
  }
  function clearSilenceHint() {
    if (silenceTimerRef.current) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }
  function onUserTapAfterHint() {
    if (hintStageRef.current === 3) {
      setHintsDisabledForever(true);
      setHintStage(0);
    }
  }

  /* ----- VAD → zdarzenie ramki ----- */
  const speakingFramesRef = useRef(0);
  function onVadFrame(speakingNow: boolean) {
    if (!isRunningRef.current) return;

    if (speakingNow) {
      speakingFramesRef.current += 1;
      if (hintStageRef.current > 0) setHintStage(0);

      const s = stepsRef.current[idxRef.current];
      if (s?.mode === "VERIFY" && !heardThisStepRef.current && speakingFramesRef.current >= 2) {
        heardThisStepRef.current = true;
        clearTimeouts(["advance", "silence"]);
        const thisIdx = idxRef.current;
        advanceTimerRef.current = window.setTimeout(() => {
          if (idxRef.current === thisIdx) gotoNext(thisIdx);
        }, ADVANCE_AFTER_SPEAK_MS);
      }
    } else {
      speakingFramesRef.current = 0;
    }
  }

  function clearTimeouts(which: Array<"advance" | "silence" | "hard"> = ["advance", "silence", "hard"]) {
    if (which.includes("advance") && advanceTimerRef.current) { window.clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null; }
    if (which.includes("silence")) clearSilenceHint();
    if (which.includes("hard") && hardCapTimerRef.current) { window.clearTimeout(hardCapTimerRef.current); hardCapTimerRef.current = null; }
  }

  /* ----- KROKI ----- */
  function runStep(i: number) {
    if (!stepsRef.current.length) return;
    const s = stepsRef.current[i];
    if (!s) return;

    clearTimeouts();
    heardThisStepRef.current = false;
    speakingFramesRef.current = 0;
    setHintStage(0);

    if (s.mode === "VERIFY") {
      stopSayCapture();
      setSayTranscript("");
      setDisplayText(s.target || "");
      scheduleSilenceHint(i);

      hardCapTimerRef.current = window.setTimeout(() => {
        if (idxRef.current === i) gotoNext(i);
      }, HARD_CAP_MS);
    } else {
      stopSayCapture();
      setDisplayText(s.prompt || "");
      setSayTranscript("");
      scheduleSilenceHint(i);

      const prep = Number(s.prep_ms ?? 1000);
      const dwell = Number(s.dwell_ms ?? 12000);

      const thisIdx = i;
      window.setTimeout(() => {
        if (idxRef.current !== thisIdx) return;
        startSayCapture();
        hardCapTimerRef.current = window.setTimeout(() => {
          if (idxRef.current !== thisIdx) return;
          stopSayCapture();
          setHintStage(0);
          gotoNext(thisIdx);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearTimeouts();
    stopSayCapture();
    const next = (i + 1) % stepsRef.current.length;
    setIdx(next);
    const n = stepsRef.current[next];
    setDisplayText(n?.mode === "VERIFY" ? (n?.target || "") : (n?.prompt || ""));
    runStep(next);
  }

  /* ----- START/STOP SESJI ----- */
  const startSession = async () => {
    if (!stepsRef.current.length) return;
    const ok = await startAV();
    if (!ok) { setIsRunning(false); return; }
    setIsRunning(true);
    setHintsDisabledForever(false);
    setHintStage(0);
    startCountdown(MAX_TIME_SEC);
    setIdx(0);
    const first = stepsRef.current[0];
    setDisplayText(first?.mode === "VERIFY" ? (first?.target || "") : (first?.prompt || ""));
    runStep(0);
  };

  const stopSession = () => {
    setIsRunning(false);
    stopCountdown();
    clearTimeouts(["advance", "silence", "hard"]);
    stopSayCapture();
    stopAV();
    setLevelPct(0);
    setHintStage(0);
  };

  /* ----- INIT PLAN ----- */
  useEffect(() => {
    (async () => {
      const stepsLoaded = await loadDayPlanOrTxt(dayFileParam);
      setSteps(stepsLoaded);
      setIdx(0);
      setDisplayText(stepsLoaded[0]?.mode === "VERIFY" ? (stepsLoaded[0]?.target || "") : (stepsLoaded[0]?.prompt || ""));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ================== RENDER ================== */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const isSay = steps[idx]?.mode === "SAY";

  return (
    <main style={styles.root} onClick={() => onUserTapAfterHint()}>
      {/* TOP BAR */}
      <header style={styles.topbar}>
        <nav style={styles.tabs}>
          <a style={{ ...styles.tab, ...styles.tabActive }} href="/day" aria-current="page">Prompter</a>
          <span style={{ ...styles.tab, opacity: 0.35 }} aria-disabled="true" title="Wkrótce">Rysownik</span>
        </nav>
        <div style={styles.topInfo}>
          <span style={styles.meta}><b>Użytkownik:</b> {USER_NAME}</span>
          <span style={styles.dot}>•</span>
          <span style={styles.meta}><b>Dzień programu:</b> {DAY_LABEL}</span>
        </div>
        <div>
          {!isRunning ? (
            <button style={styles.btn} onClick={startSession}>Start</button>
          ) : (
            <button style={styles.btn} onClick={stopSession}>Stop</button>
          )}
        </div>
      </header>

      {/* TIMER */}
      <div style={styles.timer}>{fmt(remaining)}</div>

      {/* SCENA */}
      <div style={styles.stage}>
        {/* kamera */}
        <video ref={videoRef} autoPlay playsInline muted style={styles.video} />

        {/* gradient kosmetyczny (czytelność tekstu) */}
        <div style={styles.gradientTop} />
        <div style={styles.gradientBottom} />

        {/* INTRO (gdy nie uruchomiono) */}
        {!isRunning && (
          <div style={styles.overlayCenter}>
            <div style={styles.introWrap}>
              <p style={styles.introLine}>
                Prosimy o powtarzanie na głos wyświetlanych treści.
              </p>
              <p style={{ ...styles.introLine, marginTop: 10 }}>
                Aktywowano analizator dźwięku MeRoar™
              </p>
              {micError && (
                <p style={styles.micError}>{micError} — upewnij się, że przeglądarka ma dostęp do mikrofonu i kamery.</p>
              )}
            </div>
          </div>
        )}

        {/* SESJA */}
        {isRunning && (
          <>
            {/* Tekst główny (VERIFY/SAY) — ZAWSZE CENTRUM */}
            <div style={styles.centerWrap}>
              <div style={styles.centerText}>{displayText}</div>
            </div>

            {/* SAY — transkrypt NA GÓRZE (bez tła) */}
            {isSay && (
              <div style={styles.transcriptTop}>{sayTranscript}</div>
            )}

            {/* HINT: 1..3 — ~70% wysokości, jeden w danym momencie, po 3 tap → off forever */}
            {hintStage > 0 && !hintsDisabledForever && (
              <div style={styles.hint}>{HINTS[hintStage]}</div>
            )}
          </>
        )}

        {/* VU-Meter (pionowy, z prawej) */}
        <div style={styles.vu}>
          <div style={{ ...styles.vuFill, height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}

/* ================== STYLE (inline, bez klas CSS) ================== */
const styles: Record<string, React.CSSProperties> = {
  root: {
    position: "fixed",
    inset: 0,
    background: "#000",
    color: "#fff",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    userSelect: "none",
    WebkitUserSelect: "none",
  },

  topbar: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    height: 64,
    display: "grid",
    gridTemplateColumns: "1fr auto auto",
    gap: 16,
    alignItems: "center",
    padding: "10px 14px",
    background: "rgba(0,0,0,0.45)",
    WebkitBackdropFilter: "saturate(180%) blur(8px)" as any,
    backdropFilter: "saturate(180%) blur(8px)",
    zIndex: 50,
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  },

  tabs: { display: "flex", gap: 10 },
  tab: {
    display: "inline-flex",
    alignItems: "center",
    height: 34,
    padding: "0 16px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.08)",
    color: "#fff",
    textDecoration: "none",
    fontSize: 14,
  },
  tabActive: { background: "rgba(255,255,255,0.18)", fontWeight: 600 },

  topInfo: { display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.9)", fontSize: 15, fontWeight: 600 },
  meta: {},
  dot: { opacity: 0.6 },

  btn: {
    height: 34,
    padding: "0 18px",
    borderRadius: 12,
    background: "linear-gradient(90deg, rgba(255,255,255,0.18), rgba(255,255,255,0.28))",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.22)",
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 6px 18px rgba(0,0,0,0.28)",
  },

  timer: {
    position: "fixed",
    top: 72,
    left: 0,
    right: 0,
    textAlign: "center",
    fontSize: "clamp(28px, 4.2vw, 44px)",
    fontWeight: 900,
    letterSpacing: 0.5,
    textShadow: "0 2px 8px rgba(0,0,0,0.55)",
    zIndex: 40,
  },

  stage: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    overflow: "hidden",
  },

  video: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100svh",
    objectFit: "cover",
    transform: "scaleX(-1)", // lustro
    background: "#000",
  },

  gradientTop: {
    position: "absolute",
    top: 0, left: 0, right: 0, height: 160,
    background: "linear-gradient(180deg, rgba(0,0,0,0.72), rgba(0,0,0,0))",
    pointerEvents: "none",
    zIndex: 5,
  },
  gradientBottom: {
    position: "absolute",
    bottom: 0, left: 0, right: 0, height: 220,
    background: "linear-gradient(0deg, rgba(0,0,0,0.70), rgba(0,0,0,0))",
    pointerEvents: "none",
    zIndex: 5,
  },

  overlayCenter: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    padding: "0 24px",
    zIndex: 10,
  },

  introWrap: {
    maxWidth: 560,
    textAlign: "center",
    lineHeight: 1.45,
    background: "rgba(0,0,0,0.35)",
    padding: "16px 18px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.08)",
    boxShadow: "0 12px 36px rgba(0,0,0,0.35)",
  },
  introLine: { fontSize: 18, color: "rgba(255,255,255,0.95)" },
  micError: { marginTop: 14, color: "#ffb3b3", fontSize: 14 },

  centerWrap: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    padding: "0 24px",
    textAlign: "center",
    zIndex: 8,
  },
  centerText: {
    fontSize: "clamp(22px, 3.8vw, 34px)",
    lineHeight: 1.45,
    maxWidth: 760,
    whiteSpace: "pre-wrap",
    textShadow: "0 2px 10px rgba(0,0,0,0.55)",
    fontWeight: 700,
    letterSpacing: 0.2,
  },

  transcriptTop: {
    position: "absolute",
    top: 112,
    left: 16,
    right: 16,
    textAlign: "center",
    fontSize: "clamp(18px, 3.3vw, 24px)",
    lineHeight: 1.35,
    color: "rgba(255,255,255,0.98)",
    pointerEvents: "none",
    textShadow: "0 1px 6px rgba(0,0,0,0.65)",
    minHeight: 26,
    fontWeight: 600,
    zIndex: 9,
  },

  hint: {
    position: "absolute",
    left: 0, right: 0,
    top: "70%",
    padding: "0 24px",
    textAlign: "center",
    fontSize: 16,
    lineHeight: 1.35,
    color: "rgba(255,255,255,0.95)",
    textShadow: "0 2px 8px rgba(0,0,0,0.6)",
    pointerEvents: "none",
    zIndex: 12,
  },

  vu: {
    position: "absolute",
    right: 10,
    top: 82,
    bottom: 14,
    width: 7,
    borderRadius: 7,
    background: "rgba(255,255,255,0.08)",
    overflow: "hidden",
    zIndex: 12,
    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
  },
  vuFill: {
    position: "absolute",
    bottom: 0, left: 0, right: 0,
    background: "linear-gradient(180deg,#7cdcff 0%,#6aff93 52%,#ffbe5c 100%)",
    borderRadius: 7,
    transition: "height 110ms linear",
    boxShadow: "0 0 18px rgba(255,255,255,0.15)",
  },
};



}



