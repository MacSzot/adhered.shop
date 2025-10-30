"use client";

import { useEffect, useRef, useState } from "react";

// --- PLAN DNIA: typy + loader z priorytetem JSON -> TXT ---
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;             // VERIFY: zdanie do powtórzenia
  prompt?: string;             // SAY: instrukcja
  min_sentences?: number;
  starts_with?: string[];
  starts_with_any?: string[];
  prep_ms?: number;            // SAY: czas przygotowania (np. 5 s)
  dwell_ms?: number;           // SAY: czas okna mówienia (np. 45 s)
  note?: string;               // delikatna wskazówka
};

async function loadDayPlanOrTxt(day: string): Promise<{ source: "json" | "txt"; steps: PlanStep[] }> {
  try {
    const r = await fetch(`/days/${day}.plan.json`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const steps = Array.isArray(j?.steps) ? (j.steps as PlanStep[]) : [];
      if (steps.length) return { source: "json", steps };
    }
  } catch { /* ignore */ }

  // Fallback: /public/days/<day>.txt — każda linia = VERIFY
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

// --- helpers ---
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

function deburrPL(s: string) {
  return s
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[„”"’']/g, "")
    .toLowerCase();
}
function normalize(s: string) {
  // bez unicode-escape — maks. kompatybilność
  return deburrPL(s).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function splitSentences(s: string) {
  return s.split(/[.!?]+\s+/g).map(x => x.trim()).filter(Boolean);
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // --- USTAWIENIA ---
  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień " + (typeof window !== "undefined" ? getParam("day", "01") : "01");
  const MAX_TIME = 6 * 60; // 6 minut

  // --- STANY ---
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);

  // kroki
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);

  // UI tekst
  const [displayText, setDisplayText] = useState<string>("");
  const [phase, setPhase] = useState<"prep" | "show">("show");

  // podpowiedź przy ciszy
  const [showSilenceHint, setShowSilenceHint] = useState(false);
  const [speakingBlink, setSpeakingBlink] = useState(false); // malutki „blink” gdy wykrywa głos

  // timery
  const timerRef = useRef<number | null>(null);
  const stepTimerRef = useRef<number | null>(null);
  const silenceHintTimerRef = useRef<number | null>(null);
  const hardCapTimerRef = useRef<number | null>(null);

  // audio / video
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // SAY echo (zostawione na później – gdy włączysz Whisper)
  const sayBufferRef = useRef<string>("");

  // --- start/stop strumienia AV + VU/VAD ---
  async function startAV() {
    if (streamRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    streamRef.current = stream;

    // Kamera
    if (videoRef.current) (videoRef.current as any).srcObject = stream;

    // Audio VU/VAD
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ac = new Ctx();
    audioCtxRef.current = ac;
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    ac.createMediaStreamSource(stream).connect(analyser);
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      // prosty peak (0..1)
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs((data[i] - 128) / 128);
        if (v > peak) peak = v;
      }
      // VU
      const target = Math.min(100, peak * 380);
      setLevelPct(prev => Math.max(target, prev * 0.85));

      // VAD – próg mówienia (empirycznie ~0.12)
      if (peak > 0.12) {
        setSpeakingBlink(true);
        // jeżeli jesteśmy w VERIFY – i to jest pierwsze „odezwanie się” w tym kroku → przejdź dalej
        const s = steps[idx];
        if (isRunning && s?.mode === "VERIFY") {
          advanceAfterSpeak(); // jednokrotne przejście
        }
        // zgaś blink po 200ms
        window.setTimeout(() => setSpeakingBlink(false), 200);
      }

      if (isRunning) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function stopAV() {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }

  // --- loader planu dnia ---
  useEffect(() => {
    const day = getParam("day", "01");
    (async () => {
      try {
        const { source, steps } = await loadDayPlanOrTxt(day);
        setSteps(steps);
        setIdx(0);
        const first = steps[0];
        setDisplayText(first?.mode === "VERIFY" ? (first.target || "") : (first?.prompt || ""));
        console.log(`[DAY ${day}] source:`, source, `steps: ${steps.length}`);
      } catch (e) {
        console.error(e);
        setSteps([{ mode: "VERIFY", target: "Brak treści dla tego dnia." }]);
        setDisplayText("Brak treści dla tego dnia.");
      }
    })();
  }, []);

  // --- narzędzia timerów ---
  function clearTimers() {
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
    if (stepTimerRef.current) { window.clearTimeout(stepTimerRef.current); stepTimerRef.current = null; }
    if (silenceHintTimerRef.current) { window.clearTimeout(silenceHintTimerRef.current); silenceHintTimerRef.current = null; }
    if (hardCapTimerRef.current) { window.clearTimeout(hardCapTimerRef.current); hardCapTimerRef.current = null; }
  }

  // --- silnik kroków (VAD dla VERIFY) ---
  function runStep(i: number) {
    if (!steps.length) return;
    const s = steps[i];
    if (!s) return;

    // reset UI/Timery dla kroku
    clearTimers();
    setShowSilenceHint(false);

    if (s.mode === "VERIFY") {
      // Pokaż zdanie i czekaj na głos (bez Whispera)
      setPhase("show");
      setDisplayText(s.target || "");

      // Po 7s bez głosu – pokaż delikatny hint
      silenceHintTimerRef.current = window.setTimeout(() => {
        setShowSilenceHint(true);
      }, 7000);

      // Twardy limit 12s – przejdź dalej, żeby nie utknąć
      hardCapTimerRef.current = window.setTimeout(() => {
        gotoNext(i);
      }, 12000);
    } else {
      // SAY – zostawiamy dotychczasowe okno mówienia (jak w MVP)
      const prep = Number(s.prep_ms ?? 5000);
      const dwell = Number(s.dwell_ms ?? 45000);
      setPhase("prep");
      setDisplayText(s.prompt || "");
      sayBufferRef.current = "";

      // po PREP -> SHOW
      stepTimerRef.current = window.setTimeout(() => {
        setPhase("show");
        setDisplayText(s.prompt || "");

        // po DWELL -> next (bez rozpoznawania treści, na razie MVP)
        stepTimerRef.current = window.setTimeout(() => {
          gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearTimers();
    const next = (i + 1) % steps.length;
    setIdx(next);
    setShowSilenceHint(false);
    runStep(next);
  }

  let spokeThisStep = useRef(false);
  spokeThisStep.current = false;
  function advanceAfterSpeak() {
    // zadziała tylko raz na krok VERIFY
    if (spokeThisStep.current) return;
    spokeThisStep.current = true;

    // natychmiast schowaj hint, wyczyść timery i przejdź lekko po chwili
    setShowSilenceHint(false);
    if (silenceHintTimerRef.current) { window.clearTimeout(silenceHintTimerRef.current); silenceHintTimerRef.current = null; }
    if (hardCapTimerRef.current) { window.clearTimeout(hardCapTimerRef.current); hardCapTimerRef.current = null; }

    // krótka pauza 400 ms, by nie „skakało”
    stepTimerRef.current = window.setTimeout(() => {
      gotoNext(idx);
    }, 400);
  }

  // --- start/stop sesji ---
  const startSession = async () => {
    if (!steps.length) return;
    setIsRunning(true);
    setRemaining(MAX_TIME);
    setIdx(0);
    setShowSilenceHint(false);

    // globalny timer czasu sesji
    timerRef.current = window.setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) { stopSession(); return 0; }
        return prev - 1;
      });
    }, 1000);

    await startAV();
    runStep(0);
  };

  const stopSession = () => {
    setIsRunning(false);
    clearTimers();
    stopAV();
    setLevelPct(0);
  };

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(1, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <main className="prompter-full">
      {/* Topbar */}
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

      {/* Timer */}
      <div className="timer-top timer-top--strong">{fmt(remaining)}</div>

      {/* Kamera + overlay */}
      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* Intro przed startem */}
        {!isRunning && (
          <div className="overlay center">
            <div className="intro">
              <h2>Teleprompter</h2>
              <p>
                Gdy będziesz gotowy, kliknij <b>Start</b> w panelu u góry.
                Kamera i mikrofon włączą się. W trybie testowym <b>kroki VERIFY</b> przechodzą dalej dopiero,
                gdy <b>usłyszymy Twój głos</b> (bez sprawdzania treści).
              </p>
            </div>
          </div>
        )}

        {/* Tekst podczas sesji */}
        {isRunning && (
          <div className="overlay center">
            <div key={idx} className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
              {displayText || ""}
            </div>

            {/* delikatna wskazówka (gdy cisza) */}
            {showSilenceHint && (
              <div className="mt-4 text-center opacity-70 text-sm">
                Czy możesz powtórzyć na głos?
              </div>
            )}
          </div>
        )}

        {/* pionowy VU-meter + maleńki blink mówiącego */}
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
                opacity: 0.7,
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
