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

// --- komponent ---
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // --- USTAWIENIA ---
  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień " + (typeof window !== "undefined" ? getParam("day", "01") : "01");
  const MAX_TIME = 6 * 60; // 6 minut

  // --- STANY ---
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [planReady, setPlanReady] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);

  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [phase, setPhase] = useState<"prep" | "show">("show");

  // podpowiedź przy ciszy
  const [showSilenceHint, setShowSilenceHint] = useState(false);

  // timery/RAF
  const rafTimerRef = useRef<number | null>(null);
  const stepTimerRef = useRef<number | null>(null);
  const silenceHintTimerRef = useRef<number | null>(null);
  const hardCapTimerRef = useRef<number | null>(null);

  // zegar oparty o czas docelowy
  const endEpochRef = useRef<number | null>(null);

  // audio / video
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const speakingNowRef = useRef<boolean>(false);
  const stepEnterEpochRef = useRef<number>(0);
  const haveSpokenThisStepRef = useRef<boolean>(false);

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
        setPlanReady(true);
        console.log(`[DAY ${day}] source:`, source, `steps: ${steps.length}`);
      } catch (e) {
        console.error(e);
        setSteps([{ mode: "VERIFY", target: "Brak treści dla tego dnia." }]);
        setDisplayText("Brak treści dla tego dnia.");
        setPlanReady(true);
      }
    })();
  }, []);

  // --- AV + VAD ---
  async function startAV(): Promise<boolean> {
    try {
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
      const tickVU = () => {
        if (!isRunning || !analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(data);

        // prosty peak (0..1)
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs((data[i] - 128) / 128);
          if (v > peak) peak = v;
        }

        // VU
        const target = Math.min(100, peak * 420); // delikatnie „czulszy”
        setLevelPct(prev => Math.max(target, prev * 0.85));

        // VAD (próg mówienia ~0.10)
        speakingNowRef.current = peak > 0.10;

        // VERIFY: logika przejścia – po min. 4s od wejścia kroku, jeśli „był głos”
        const s = steps[idx];
        if (s?.mode === "VERIFY") {
          const now = performance.now();
          const elapsed = now - stepEnterEpochRef.current;

          // po 7s ciszy pokaż hint
          if (elapsed >= 7000 && !speakingNowRef.current) {
            setShowSilenceHint(true);
          }
          // jeśli wykryto głos i minęło >= 4s od wejścia – przejdź dalej raz
          if (speakingNowRef.current && elapsed >= 4000 && !haveSpokenThisStepRef.current) {
            haveSpokenThisStepRef.current = true;
            // mała pauza 250ms dla płynności
            window.setTimeout(() => gotoNext(idx), 250);
          }
        }

        requestAnimationFrame(tickVU);
      };
      requestAnimationFrame(tickVU);

      return true;
    } catch (e) {
      console.error(e);
      alert("Zezwól na dostęp do kamery i mikrofonu.");
      return false;
    }
  }

  function stopAV() {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }

  // --- narzędzia timerów ---
  function clearTimers() {
    if (rafTimerRef.current) { cancelAnimationFrame(rafTimerRef.current); rafTimerRef.current = null; }
    if (stepTimerRef.current) { window.clearTimeout(stepTimerRef.current); stepTimerRef.current = null; }
    if (silenceHintTimerRef.current) { window.clearTimeout(silenceHintTimerRef.current); silenceHintTimerRef.current = null; }
    if (hardCapTimerRef.current) { window.clearTimeout(hardCapTimerRef.current); hardCapTimerRef.current = null; }
  }

  function startCountdownRaf(seconds: number) {
    const endAt = performance.now() + seconds * 1000;
    endEpochRef.current = endAt;

    const tick = () => {
      if (!isRunning) return;
      const now = performance.now();
      const left = Math.max(0, Math.round((endAt - now) / 1000));
      setRemaining(left);
      if (left <= 0) {
        stopSession();
        return;
      }
      rafTimerRef.current = requestAnimationFrame(tick);
    };
    rafTimerRef.current = requestAnimationFrame(tick);
  }

  // --- silnik kroków ---
  function runStep(i: number) {
    if (!steps.length) return;
    const s = steps[i];
    if (!s) return;

    // reset UI/Timery dla kroku
    clearTimers();
    setShowSilenceHint(false);
    haveSpokenThisStepRef.current = false;
    stepEnterEpochRef.current = performance.now();

    if (s.mode === "VERIFY") {
      // Pokaż zdanie i czekaj na głos (bez Whispera)
      setPhase("show");
      setDisplayText(s.target || "");

      // Twardy limit 12s – przejdź dalej, żeby nie utknąć
      hardCapTimerRef.current = window.setTimeout(() => {
        gotoNext(i);
      }, 12000);
    } else {
      // SAY – MVP: intro (prep), potem okno mówienia, potem kolejny krok
      const prep = Number(s.prep_ms ?? 5000);
      const dwell = Number(s.dwell_ms ?? 45000);

      setPhase("prep");
      setDisplayText(s.prompt || "");

      stepTimerRef.current = window.setTimeout(() => {
        setPhase("show");
        setDisplayText(s.prompt || "");
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
    haveSpokenThisStepRef.current = false;
    stepEnterEpochRef.current = performance.now();
    runStep(next);
  }

  // --- start/stop sesji ---
  const startSession = async () => {
    // 1) Plan musi być gotowy
    if (!planReady || !steps.length) return;

    // 2) Najpierw prosimy o media; timer rusza dopiero gdy mamy stream
    const okAV = await startAV();
    if (!okAV) return;

    // 3) Uruchamiamy sesję i licznik (RAF)
    setIsRunning(true);
    setRemaining(MAX_TIME);
    startCountdownRaf(MAX_TIME);

    // 4) Jedziemy z krokami
    setIdx(0);
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
            <button className="btn" onClick={startSession} disabled={!planReady}>
              {planReady ? "Start" : "Ładowanie…"}
            </button>
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
                Kliknij <b>Start</b>. Najpierw poprosimy o dostęp do kamery i mikrofonu.
                Zegar ruszy dopiero po wyrażeniu zgody. Kroki <b>VERIFY</b> idą dalej,
                gdy wykryjemy głos (bez rozpoznawania treści). Gdy jest cisza, po 7 sekundach
                pojawi się delikatna podpowiedź.
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

            {/* delikatna wskazówka (pod tekstem, po 7s ciszy) */}
            {showSilenceHint && (
              <div className="mt-4 text-center opacity-70 text-sm">
                Czy możesz powtórzyć na głos?
              </div>
            )}
          </div>
        )}

        {/* pionowy VU-meter */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}
