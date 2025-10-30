"use client";

import { useEffect, useRef, useState } from "react";

// --- PLAN DNIA: typy + loader z priorytetem JSON -> TXT ---
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
    .map(line => ({ mode: "VERIFY" as const, target: line, dwell_ms: 5000 }));

  return { source: "txt", steps };
}

function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

// --- Normalizacja (do VERIFY/porównań, jeśli użyjesz Whispera) ---
function deburrPL(s: string) {
  return s
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[„”"’']/g, "")
    .toLowerCase();
}
function normalize(s: string) {
  return deburrPL(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function coverage(transcript: string, target: string) {
  const T = normalize(target).split(" ").filter(Boolean);
  const W = normalize(transcript).split(" ").filter(Boolean);
  if (!T.length || !W.length) return 0;
  let hit = 0;
  const used = new Set<number>();
  for (const w of T) {
    const idx = W.findIndex((x, i) => !used.has(i) && x === w);
    if (idx !== -1) { used.add(idx); hit++; }
  }
  return hit / T.length;
}
function splitSentences(s: string) {
  return s
    .split(/[.!?]+\s+/g)
    .map(x => x.trim())
    .filter(Boolean);
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // --- USTAWIENIA ---
  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień " + (typeof window !== "undefined" ? getParam("day", "01") : "01");
  const MAX_TIME = 6 * 60;

  // --- STANY ---
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [idx, setIdx] = useState(0);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);

  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [displayText, setDisplayText] = useState<string>("");
  type Phase = "prep" | "show";
  const [phase, setPhase] = useState<Phase>("show");

  // VAD feedback:
  const [speaking, setSpeaking] = useState(false);
  const [justCaptured, setJustCaptured] = useState(false);

  // timery
  const timerRef = useRef<number | null>(null);
  const stepTimeoutRef = useRef<number | null>(null);

  // bufor SAY (gdy używasz Whispera)
  const sayBufferRef = useRef<string>("");

  // --- MediaRecorder (Whisper) – zostawiamy, ale nie wymagane do VAD feedbacku ---
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const CHUNK_MS = 3000;

  async function startMic() {
    if (mediaRecorderRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioStreamRef.current = stream;

    const mime = MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : "";

    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mediaRecorderRef.current = mr;

    mr.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    mr.onstop = async () => {
      if (!chunksRef.current.length) return;
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
      chunksRef.current = [];
      const file = new File(
        [blob],
        `clip.${(mr.mimeType || "").includes("mp4") ? "m4a" : "webm"}`,
        { type: blob.type }
      );

      const fd = new FormData();
      fd.append("file", file);

      try {
        const res = await fetch("/api/whisper", { method: "POST", body: fd });
        const data = await res.json();
        if (data?.text) handleTranscript(data.text);
      } catch {}

      const rec = mediaRecorderRef.current;
      if (rec && rec.state !== "recording") {
        rec.start();
        setTimeout(() => rec.stop(), CHUNK_MS);
      }
    };

    mr.start();
    setTimeout(() => mr.stop(), CHUNK_MS);
  }

  function stopMic() {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state === "recording") rec.stop();
    mediaRecorderRef.current = null;
    audioStreamRef.current?.getTracks().forEach(t => t.stop());
    audioStreamRef.current = null;
  }

  // --- Loader planu dnia ---
  useEffect(() => {
    const day = getParam("day", "01");
    (async () => {
      try {
        const { source, steps } = await loadDayPlanOrTxt(day);
        setSteps(steps);
        setIdx(0);
        const first = steps[0];
        setDisplayText(first?.mode === "VERIFY" ? first.target || "" : first?.prompt || "");
        console.log(`[DAY ${day}] source:`, source, `steps: ${steps.length}`);
      } catch (e) {
        console.error(e);
        setSteps([{ mode: "VERIFY", target: "Brak treści dla tego dnia." }]);
        setDisplayText("Brak treści dla tego dnia.");
      }
    })();
  }, []);

  // --- VU-meter + VAD (detekcja głosu) ---
  useEffect(() => {
    if (!isRunning) return;

    let raf: number | null = null;
    let analyser: AnalyserNode | null = null;
    let audioCtx: AudioContext | null = null;
    let streamRef: MediaStream | null = null;

    // progi / czasy dla VAD
    const VOICE_THRESHOLD = 0.04; // ~4% amplitudy
    const ATTACK_MS = 200;        // jak szybko uznać „mówienie zaczęło się”
    const RELEASE_MS = 400;       // jak szybko uznać „mówienie się skończyło”
    const MIN_SPEECH_MS = 1200;   // minimalna długość segmentu mowy
    const MIN_SILENCE_MS = 800;   // cisza zamykająca segment

    let speakingLocal = false;
    let lastAbove = 0;
    let lastBelow = 0;
    let segmentStart = 0;
    let lastSpeechEnd = 0;

    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        streamRef = stream;
        if (videoRef.current) (videoRef.current as any).srcObject = stream;

        const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
        audioCtx = new Ctx();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        audioCtx.createMediaStreamSource(stream).connect(analyser);

        const data = new Uint8Array(analyser.fftSize);

        const tick = () => {
          analyser!.getByteTimeDomainData(data);

          // poziom sygnału (peak)
          let peak = 0;
          for (let i = 0; i < data.length; i++) {
            const v = Math.abs((data[i] - 128) / 128);
            if (v > peak) peak = v;
          }

          // lekki smoothing dla VU
          const target = Math.min(100, peak * 380);
          setLevelPct(prev => Math.max(target, prev * 0.85));

          const now = performance.now();
          const above = peak > VOICE_THRESHOLD;

          if (above) lastAbove = now; else lastBelow = now;

          // Attack: uznaj „speaking”
          if (!speakingLocal && above && (now - lastBelow) > ATTACK_MS) {
            speakingLocal = true;
            segmentStart = now;
            setSpeaking(true);
          }

          // Release: uznaj, że mówienie się skończyło
          if (speakingLocal && !above && (now - lastAbove) > RELEASE_MS) {
            speakingLocal = false;
            setSpeaking(false);
            lastSpeechEnd = now;
            const segLen = lastSpeechEnd - segmentStart;
            const silenceLen = now - lastAbove;
            if (segLen >= MIN_SPEECH_MS && silenceLen >= MIN_SILENCE_MS) {
              setJustCaptured(true);
              setTimeout(() => setJustCaptured(false), 1500);
            }
          }

          raf = requestAnimationFrame(tick);
        };

        raf = requestAnimationFrame(tick);
      } catch (e) {
        console.error(e);
        alert("Zezwól na dostęp do kamery i mikrofonu.");
      }
    };

    start();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      streamRef?.getTracks().forEach(t => t.stop());
      audioCtx?.close().catch(() => {});
      setSpeaking(false);
      setJustCaptured(false);
    };
  }, [isRunning]);

  // --- Silnik kroków (prep_ms/dwell_ms, VERIFY/SAY) ---
  function clearStepTimeout() {
    if (stepTimeoutRef.current) {
      window.clearTimeout(stepTimeoutRef.current);
      stepTimeoutRef.current = null;
    }
  }

  function runStep(i: number) {
    if (!steps.length) return;
    const s = steps[i];
    if (!s) return;

    if (s.mode === "VERIFY") {
      setPhase("show");
      setDisplayText(s.target || "");
      const dwell = Number(s.dwell_ms ?? 5000);

      clearStepTimeout();
      stepTimeoutRef.current = window.setTimeout(() => {
        const next = (i + 1) % steps.length;
        setIdx(next);
        runStep(next);
      }, dwell);
    } else {
      // SAY (pozostawiamy bez zmian logiki; VAD daje tylko feedback wizualny)
      const prep = Number(s.prep_ms ?? 5000);
      const dwell = Number(s.dwell_ms ?? 45000);

      sayBufferRef.current = "";
      setPhase("prep");
      setDisplayText(s.prompt || "");

      clearStepTimeout();
      stepTimeoutRef.current = window.setTimeout(() => {
        setPhase("show");
        setDisplayText(s.prompt || "");

        clearStepTimeout();
        stepTimeoutRef.current = window.setTimeout(() => {
          const next = (i + 1) % steps.length;
          setIdx(next);
          sayBufferRef.current = "";
          runStep(next);
        }, dwell);
      }, prep);
    }
  }

  // --- Obsługa transkrypcji (gdy korzystasz z Whispera) ---
  function handleTranscript(text: string) {
    const s = steps[idx];
    if (!s || !text) return;

    if (s.mode === "VERIFY") {
      const score = coverage(text, s.target || "");
      const ok = score >= 0.8 && normalize(text).split(" ").length >= 3;
      if (ok) {
        clearStepTimeout();
        const next = (idx + 1) % steps.length;
        setIdx(next);
        runStep(next);
      }
      return;
    }

    if (s.mode === "SAY") {
      sayBufferRef.current = (sayBufferRef.current + " " + text).trim();
      setDisplayText(`${s.prompt || ""}\n\n${sayBufferRef.current}`);

      const sentences = splitSentences(sayBufferRef.current);
      let count = sentences.length;

      if (s.starts_with?.length) {
        count = sentences.filter(t => s.starts_with!.some(sw => normalize(t).startsWith(normalize(sw)))).length;
      } else if (s.starts_with_any?.length) {
        count = sentences.filter(t => s.starts_with_any!.some(sw => normalize(t).startsWith(normalize(sw)))).length;
      }

      if ((s.min_sentences ?? 3) <= count) {
        clearStepTimeout();
        const next = (idx + 1) % steps.length;
        setIdx(next);
        sayBufferRef.current = "";
        runStep(next);
      }
    }
  }

  // --- Start / Stop sesji ---
  const startSession = () => {
    if (!steps.length) return;
    setIsRunning(true);
    setRemaining(MAX_TIME);
    setIdx(0);

    timerRef.current = window.setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) { stopSession(); return 0; }
        return prev - 1;
      });
    }, 1000);

    runStep(0);

    // Jeśli chcesz mieć równolegle transkrypcję – zostaw:
    // startMic();
  };

  const stopSession = () => {
    setIsRunning(false);
    if (timerRef.current) window.clearInterval(timerRef.current);
    clearStepTimeout();
    stopMic();
    setLevelPct(0);
  };

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(1, "0")}:${String(s % 60).padStart(2, "0")}`;

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

      <div
        className={`stage ${mirror ? "mirrored" : ""}`}
        style={speaking ? { boxShadow: "0 0 0 2px rgba(0,0,0,0.15), 0 0 28px rgba(0, 180, 90, 0.35)" } : undefined}
      >
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {!isRunning && (
          <div className="overlay center">
            <div className="intro">
              <h2>Teleprompter</h2>
              <p>
                Gdy będziesz gotowy, kliknij <b>Start</b> w panelu u góry.
                Kamera i mikrofon włączą się, a kroki będą prowadzić Cię w spokojnym tempie.
              </p>
            </div>
          </div>
        )}

        {isRunning && (
          <div className="overlay center">
            <div key={idx} className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
              {displayText || ""}
            </div>

            {/* Delikatna wskazówka w SAY (jak było) */}
            {steps[idx]?.mode === "SAY" && phase === "show" && steps[idx]?.note && (
              <div className="mt-4 text-center opacity-70 text-sm">
                {steps[idx].note}
              </div>
            )}

            {/* Badge „Słyszę Cię” – pojawia się wyłącznie gdy jest mowa */}
            {speaking && (
              <div
                style={{
                  position: "absolute",
                  right: "16px",
                  top: "16px",
                  padding: "6px 10px",
                  background: "rgba(0,0,0,0.65)",
                  color: "#fff",
                  borderRadius: "999px",
                  fontSize: 12,
                  letterSpacing: 0.2,
                  backdropFilter: "blur(2px)",
                  userSelect: "none"
                }}
              >
                Słyszę Cię
              </div>
            )}

            {/* Krótki toast „Zarejestrowano” po zakończonej wypowiedzi */}
            {justCaptured && (
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  transform: "translateX(-50%)",
                  bottom: "24px",
                  padding: "8px 12px",
                  background: "rgba(0,0,0,0.70)",
                  color: "#fff",
                  borderRadius: 8,
                  fontSize: 13,
                  boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
                  userSelect: "none"
                }}
              >
                Zarejestrowano
              </div>
            )}
          </div>
        )}

        {/* pionowy VU-meter – jak było */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}
