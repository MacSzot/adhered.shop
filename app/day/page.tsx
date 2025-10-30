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

  // timery: SESJA vs. KROK
  const sessionTimerRef = useRef<number | null>(null);      // ⏱️ globalny zegar (nie kasujemy go w runStep)
  const stepTimerRef = useRef<number | null>(null);
  const silenceHintTimerRef = useRef<number | null>(null);
  const hardCapTimerRef = useRef<number | null>(null);

  // audio / video
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  // SAY echo (na później – gdy włączysz Whisper)
  const sayBufferRef = useRef<string>("");

  // flaga: czy już padło „mówienie” w tym kroku VERIFY
  const spokeThisStepRef = useRef(false);

  // --- start/stop strumienia AV + VU/VAD ---
  async function startAV() {
    if (streamRef.current) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    streamRef.current = stream;

    // Kamera
    if (videoRef.current) (videoRef.current as any).srcObject = stream;

    // Audio VU/VAD
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ac = new Ctx();
    if (ac.state === "suspended") {
      try { await ac.resume(); } catch {}
    }
    audioCtxRef.current = ac;

    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    ac.createMediaStreamSource(stream).connect(analyser);
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs((data[i] - 128) / 128);
        if (v > peak) peak = v;
      }
      // VU
      const target = Math.min(100, peak * 380);
      setLevelPct(prev => Math.max(target, prev * 0.85));

      // VAD – próg mówienia
      if (peak > 0.12) {
        setSpeakingBlink(true);
        const s = steps[idx];
        if (isRunning && s?.mode === "VERIFY") {
          advanceAfterSpeak(); // jednokrotne przejście
        }
        window.setTimeout(() => setSpeakingBlink(false), 200);
      }

      if (isRunning) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  function stopAV() {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
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
  function clearStepTimers() {
    if (stepTimerRef.current) { window.clearTimeout(stepTimerRef.current); stepTimerRef.current = null; }
    if (silenceHintTimerRef.current) { window.clearTimeout(silenceHintTimerRef.current); silenceHintTimerRef.current = null; }
    if (hardCapTimerRef.current) { window.clearTimeout(hardCapTimerRef.current); hardCapTimerRef.current = null; }
  }
  function clearAllTimers() {
    if (sessionTimerRef.current) { window.clearInterval(sessionTimerRef.current); sessionTimerRef.current = null; }
    clearStepTimers();
  }

  // --- silnik kroków (VAD dla VERIFY) ---
  function runStep(i: number) {
    if (!steps.length) return;
    const s = steps[i];
    if (!s) return;

    // reset TYLKO timerów krokowych + UI
    clearStepTimers();
    setShowSilenceHint(false);

    if (s.mode === "VERIFY") {
      // reset flagi „mówił” – tylko przy nowym kroku VERIFY
      spokeThisStepRef.current = false;

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
      // SAY – zostawiamy MVP okno mówienia (bez rozpoznawania treści)
      const prep = Number(s.prep_ms ?? 5000);
      const dwell = Number(s.dwell_ms ?? 45000);
      setPhase("prep");
      setDisplayText(s.prompt || "");
      sayBufferRef.current = "";

      // po PREP -> SHOW
      stepTimerRef.current = window.setTimeout(() => {
        setPhase("show");
        setDisplayText(s.prompt || "");

        // po DWELL -> next
        stepTimerRef.current = window.setTimeout(() => {
          gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearStepTimers();
    const next = (i + 1) % steps.length;
    setIdx(next);
    setShowSilenceHint(false);
    runStep(next);
  }

  function advanceAfterSpeak() {
    // zadziała tylko raz na krok VERIFY
    if (spokeThisStepRef.current) return;
    spokeThisStepRef.current = true;

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

    // globalny timer czasu sesji (nie czyścimy go w runStep)
    sessionTimerRef.current = window.setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) { stopSession(); return 0; }
        return prev - 1;
      });
    }, 1000);

    await startAV();
    if (audioCtxRef.current?.state === "suspended") {
      try { await audioCtxRef.current.resume(); } catch {}
    }
    runStep(0);
  };

  const stopSession = () => {
    setIsRunning(false);
    clearAllTimers();
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
                Kamera i mikrofon włączą się. W trybie testowym <b>kroki VERIFY</b> przechodzą dalej,
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

            {/* delikatna wskazówka (gdy cisza) — niżej, nie nachodzi */}
            {showSilenceHint && (
              <div
                className="text-center opacity-80"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: "calc(50% + 90px)",
                  padding: "0 16px",
                  fontSize: "16px",
                  lineHeight: 1.35,
                  textShadow: "0 1px 2px rgba(0,0,0,0.6)"
                }}
              >
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
