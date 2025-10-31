"use client";

import { useEffect, useRef, useState } from "react";

// --- Typ planu dnia ---
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

// --- Loader planu (JSON -> TXT fallback) ---
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

function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // USTAWIENIA
  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień " + (typeof window !== "undefined" ? getParam("day", "01") : "01");
  const MAX_TIME = 6 * 60; // 6:00

  // STANY UI
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [planReady, setPlanReady] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  const runningRef = useRef(false);

  const [remaining, setRemaining] = useState(MAX_TIME);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [showSilenceHint, setShowSilenceHint] = useState(false);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);

  // CZAS
  const endAtRef = useRef<number | null>(null);
  const intervalIdRef = useRef<number | null>(null);

  // AUDIO/VIDEO
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // VERIFY – kontrola kroku
  const stepEnterMsRef = useRef<number>(0);
  const lastSpeechMsRef = useRef<number | null>(null);
  const advancedThisStepRef = useRef<boolean>(false);

  // --- Load plan ---
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

  // --- Start/Stop AV + VAD ---
  async function startAV(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (videoRef.current) (videoRef.current as any).srcObject = stream;

      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new Ctx();
      audioCtxRef.current = ac;

      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      const src = ac.createMediaStreamSource(stream);
      src.connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.fftSize);

      const tick = () => {
        if (!runningRef.current || !analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(data);

        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs((data[i] - 128) / 128);
          if (v > peak) peak = v;
        }

        // VU
        const target = Math.min(100, peak * 420);
        setLevelPct(prev => Math.max(target, prev * 0.85));

        // VAD
        const speaking = peak > 0.10; // delikatnie czulszy próg
        const now = performance.now();

        // VERIFY – logika kroku: nie przeskakuj od razu, dopiero gdy minęły >=4s OD WEJŚCIA i był głos
        const s = steps[idx];
        if (s?.mode === "VERIFY") {
          const elapsedFromEnter = now - stepEnterMsRef.current;

          if (speaking) {
            lastSpeechMsRef.current = now;
          }

          // Pokaż hint dopiero po 7s ciszy od wejścia (brak lastSpeech)
          if (!lastSpeechMsRef.current && elapsedFromEnter >= 7000) {
            setShowSilenceHint(true);
          }

          // Przejście dalej: minęły >=4s od wejścia ORAZ zarejestrowano głos (kiedykolwiek w tym kroku)
          if (!advancedThisStepRef.current && elapsedFromEnter >= 4000 && lastSpeechMsRef.current) {
            advancedThisStepRef.current = true;
            setShowSilenceHint(false);
            // krótka pauza dla płynności
            window.setTimeout(() => gotoNext(idx), 250);
          }
        } else {
          // SAY – bez rozpoznawania treści w tej fazie (MVP)
        }

        rafIdRef.current = requestAnimationFrame(tick);
      };

      rafIdRef.current = requestAnimationFrame(tick);
      return true;
    } catch (e) {
      console.error(e);
      alert("Zezwól na dostęp do kamery i mikrofonu.");
      return false;
    }
  }

  function stopAV() {
    if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    try { audioCtxRef.current?.close(); } catch {}
    audioCtxRef.current = null;
    analyserRef.current = null;
  }

  // --- Timer (start PO zgodzie na media) ---
  function startCountdown(seconds: number) {
    const endAt = Date.now() + seconds * 1000;
    endAtRef.current = endAt;

    if (intervalIdRef.current) {
      window.clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    }

    intervalIdRef.current = window.setInterval(() => {
      if (!runningRef.current || !endAtRef.current) return;
      const secsLeft = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
      setRemaining(secsLeft);
      if (secsLeft <= 0) {
        stopSession();
      }
    }, 250); // częstsze odświeżanie, ale liczba wyświetlana to pełne sekundy
  }

  function stopCountdown() {
    if (intervalIdRef.current) {
      window.clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    }
    endAtRef.current = null;
  }

  // --- Silnik kroków ---
  function runStep(i: number) {
    if (!steps.length) return;
    const s = steps[i];
    if (!s) return;

    // reset kontroli kroku
    advancedThisStepRef.current = false;
    lastSpeechMsRef.current = null;
    setShowSilenceHint(false);
    stepEnterMsRef.current = performance.now();

    if (s.mode === "VERIFY") {
      setDisplayText(s.target || "");

      // twardy cap 12s — żeby nie utknąć nawet przy braku głosu
      window.setTimeout(() => {
        if (!advancedThisStepRef.current && runningRef.current && idx === i) {
          setShowSilenceHint(false);
          gotoNext(i);
        }
      }, 12000);
    } else {
      const prep = Number(s.prep_ms ?? 5000);
      const dwell = Number(s.dwell_ms ?? 45000);

      setDisplayText(s.prompt || "");
      // po PREP -> SHOW (w tym MVP pokazujemy ten sam tekst)
      window.setTimeout(() => {
        if (!runningRef.current || idx !== i) return;
        setDisplayText(s.prompt || "");
        // po DWELL -> next
        window.setTimeout(() => {
          if (!runningRef.current || idx !== i) return;
          gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    const next = (i + 1) % steps.length;
    setIdx(next);
    const s = steps[next];
    setDisplayText(s?.mode === "VERIFY" ? (s.target || "") : (s?.prompt || ""));
    // reset warunków następnego kroku
    advancedThisStepRef.current = false;
    lastSpeechMsRef.current = null;
    setShowSilenceHint(false);
    stepEnterMsRef.current = performance.now();
  }

  // --- Start/Stop sesji (kolejność: media -> timer -> kroki) ---
  const startSession = async () => {
    if (!planReady || !steps.length) return;

    // 1) Zapytaj o media — dopiero po pozwoleniu uruchamiamy licznik i kroki
    const ok = await startAV();
    if (!ok) return;

    // 2) Start stanu „running”
    runningRef.current = true;
    setIsRunning(true);

    // 3) Timer
    setRemaining(MAX_TIME);
    startCountdown(MAX_TIME);

    // 4) Kroki od zera
    setIdx(0);
    runStep(0);
  };

  const stopSession = () => {
    runningRef.current = false;
    setIsRunning(false);
    stopCountdown();
    stopAV();
    setLevelPct(0);
  };

  useEffect(() => {
    return () => {
      // cleanup na unmount
      stopSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(1, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <main className="prompter-full">
      {/* Topbar */}
      <header className="topbar topbar--dense">
        <nav className="tabs">
          <a className="tab active" href="/day" aria-current="page">Prompter</a>
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

        {/* Intro */}
        {!isRunning && (
          <div className="overlay center">
            <div className="intro">
              <h2>Teleprompter</h2>
              <p>
                Kliknij <b>Start</b>. Najpierw poprosimy o dostęp do kamery i mikrofonu.
                Zegar zacznie odliczać dopiero po wyrażeniu zgody.
                Kroki <b>VERIFY</b> zmieniają się, gdy naprawdę usłyszymy Twój głos;
                jeśli jest cisza, po 7 s pokażemy delikatną podpowiedź.
              </p>
            </div>
          </div>
        )}

        {/* Overlay z tekstem */}
        {isRunning && (
          <div className="overlay center">
            <div key={idx} className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
              {displayText || ""}
            </div>

            {/* Podpowiedź (zawsze POD tekstem) */}
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
