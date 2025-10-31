"use client";
import { useEffect, useRef, useState } from "react";

/* === Typ kroku === */
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

/* === Fallback dla dnia 3 === */
const FALLBACK_DAY3: PlanStep[] = [
  { mode: "VERIFY", target: "Jestem w bardzo dobrym miejscu." },
  { mode: "VERIFY", target: "Szacunek do siebie staje się naturalny." },
  { mode: "VERIFY", target: "W moim wnętrzu dojrzewa spokój i zgoda." },
  { mode: "SAY", prompt: "Spójrz na siebie i podziękuj sobie. Powiedz to spokojnie — Twoje słowa pokażą się na ekranie.", prep_ms: 1000, dwell_ms: 12000 },
  { mode: "VERIFY", target: "Doceniam to, jak wiele już zostało zrobione." },
  { mode: "SAY", prompt: "Spójrz na siebie i przyznaj sobie rację. Powiedz to z przekonaniem — Twoje słowa pokażą się na ekranie.", prep_ms: 1000, dwell_ms: 12000 },
  { mode: "VERIFY", target: "Moje tempo jest wystarczające." },
  { mode: "SAY", prompt: "Spójrz na siebie i pogratuluj sobie. Z radością — Twoje słowa pokażą się na ekranie.", prep_ms: 1000, dwell_ms: 12000 },
  { mode: "VERIFY", target: "To, że trwam, jest już dowodem siły." },
  { mode: "VERIFY", target: "Każdy dzień przybliża mnie do siebie." },
];

/* === Ładowanie pliku dnia lub fallback === */
async function loadDayPlanOrTxt(dayFileParam: string): Promise<{ source: string; steps: PlanStep[] }> {
  try {
    const r = await fetch(`/days/${dayFileParam}.plan.json`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const steps = Array.isArray(j?.steps) ? (j.steps as PlanStep[]) : [];
      if (steps.length) return { source: "json", steps };
    }
  } catch {}
  try {
    const r2 = await fetch(`/days/${dayFileParam}.txt`, { cache: "no-store" });
    if (r2.ok) {
      const txt = await r2.text();
      const steps: PlanStep[] = txt
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(line => ({ mode: "VERIFY" as const, target: line }));
      if (steps.length) return { source: "txt", steps };
    }
  } catch {}
  if (dayFileParam === "03") return { source: "fallback", steps: FALLBACK_DAY3 };
  return { source: "fallback", steps: [{ mode: "VERIFY", target: "Brak treści dla tego dnia." }] };
}

/* === Pomocnicze === */
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

/* === Strona === */
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "01") : "01";
  const dayFileParam = dayRaw.padStart(2, "0");
  const DAY_LABEL = parseInt(dayRaw, 10).toString();
  const MAX_TIME = 6 * 60; // 6 minut

  const SPEAKING_FRAMES_REQUIRED = 2;
  const SILENCE_HINT_MS = 7000;
  const HARD_CAP_MS = 12000;
  const ADVANCE_AFTER_SPEAK_MS = 4000;

  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);
  const [micError, setMicError] = useState<string | null>(null);

  const [hintVisible, _setHintVisible] = useState(false);
  const hintVisibleRef = useRef(false);
  const setHintVisible = (v: boolean) => { hintVisibleRef.current = v; _setHintVisible(v); };

  const [hintStep, setHintStep] = useState(0);
  const hintTexts = [
    "Czy możesz powiedzieć coś na głos?",
    "Pamiętaj, to przestrzeń pełna szacunku do Ciebie.",
    "Jeśli potrzebujesz chwili dla siebie, możesz wrócić później. Jeśli chcesz kontynuować, dotknij ekranu.",
  ];
  const currentHintText = hintTexts[hintStep] ?? hintTexts[2];

  const [sayTranscript, setSayTranscript] = useState<string>("");

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const heardThisStepRef = useRef(false);
  const speakingFramesRef = useRef(0);
  const idxRef = useRef(idx);
  useEffect(() => { idxRef.current = idx; }, [idx]);

  /* === Wczytanie planu === */
  useEffect(() => {
    (async () => {
      const { steps } = await loadDayPlanOrTxt(dayFileParam);
      setSteps(steps);
      setIdx(0);
      setDisplayText(steps[0]?.target || steps[0]?.prompt || "");
    })();
  }, []);

  /* === Mikrofon + detekcja głosu === */
  async function startAV(): Promise<boolean> {
    stopAV();
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (videoRef.current) (videoRef.current as any).srcObject = stream;
      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new Ctx();
      audioCtxRef.current = ac;
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      ac.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.fftSize);

      const loop = () => {
        if (!analyserRef.current) return;
        analyser.getByteTimeDomainData(data);
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const x = (data[i] - 128) / 128;
          sumSq += x * x;
        }
        const rms = Math.sqrt(sumSq / data.length);
        const speakingNow = rms > 0.02;
        if (speakingNow) {
          if (hintVisibleRef.current) setHintVisible(false);
          heardThisStepRef.current = true;
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      return true;
    } catch (err: any) {
      setMicError("Brak dostępu do mikrofonu/kamery.");
      return false;
    }
  }
  function stopAV() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
  }

  /* === Przypomnienie 3-stopniowe === */
  function scheduleSilence(i: number) {
    window.setTimeout(() => {
      if (idxRef.current === i) {
        setHintVisible(true);
        setHintStep(prev => Math.min(prev + 1, 2));
      }
    }, SILENCE_HINT_MS);
  }

  /* === Kroki === */
  function runStep(i: number) {
    if (!steps[i]) return;
    setDisplayText(steps[i].target || steps[i].prompt || "");
    setHintVisible(false);
    scheduleSilence(i);
  }

  /* === Sesja === */
  const startSession = async () => {
    const ok = await startAV();
    if (!ok) return;
    setIsRunning(true);
    setIdx(0);
    runStep(0);
  };
  const stopSession = () => {
    setIsRunning(false);
    stopAV();
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const timerCenteredStyle: React.CSSProperties = {
    position: "fixed",
    top: 96,
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: 48,
    fontWeight: 800,
    textShadow: "0 2px 8px rgba(0,0,0,.45)",
    zIndex: 40,
    color: "#fff",
  };

  const questionStyle: React.CSSProperties = { fontSize: 20, textAlign: "center" };
  const transcriptStyle: React.CSSProperties = { marginTop: 10, fontSize: 18, textAlign: "center" };
  const hintStyle: React.CSSProperties = {
    position: "absolute",
    left: 0, right: 0, bottom: 56,
    textAlign: "center",
    color: "#fff",
    opacity: hintVisible ? 1 : 0,
    transition: "opacity 0.3s",
  };

  return (
    <main className="prompter-full">
      <header className="topbar topbar--dense">
        <nav className="tabs">
          <a className="tab active" href="/day">Prompter</a>
          <span className="tab disabled">Rysownik</span>
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

      <div style={timerCenteredStyle}>{fmt(remaining)}</div>

      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" style={{ zIndex: 0 }} />

        {!isRunning && (
          <div className="overlay center" style={{ textAlign: "center", maxWidth: 520, margin: "0 auto", color: "#fff", position: "relative" }}>
            <p style={{ fontSize: 16, opacity: 0.9, lineHeight: 1.6 }}>
              Twoja sesja potrwa około <b>6 minut</b>.<br />
              <b>Postaraj się wyraźnie powtarzać wyświetlane treści.</b>
            </p>
            {micError && <p style={{ marginTop: 16, color: "#ffb3b3", fontSize: 14 }}>{micError}</p>}
            <img
              src="/assets/meroar-supervised.png"
              alt="Super-vised by MeRoar / supervised by adhered."
              style={{
                position: "absolute",
                left: "50%",
                bottom: -80,
                transform: "translateX(-50%)",
                width: "80%",
                maxWidth: 420,
                opacity: 0.9,
                pointerEvents: "none",
              }}
            />
          </div>
        )}

        {isRunning && (
          <div className="overlay center" style={{ position: "absolute", inset: 0, zIndex: 10 }}>
            {steps[idx]?.mode === "VERIFY" && (
              <div style={{ whiteSpace: "pre-wrap", textAlign: "center", color: "#fff", textShadow: "0 2px 8px rgba(0,0,0,.6)" }}>
                {displayText}
              </div>
            )}
            {steps[idx]?.mode === "SAY" && (
              <div style={{ textAlign: "center", color: "#fff" }}>
                <div style={questionStyle}>{displayText}</div>
                <div style={transcriptStyle}>{sayTranscript}</div>
              </div>
            )}
            <div style={hintStyle}>{currentHintText}</div>
          </div>
        )}
      </div>
    </main>
  );
}

