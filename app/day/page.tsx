"use client";

import { useEffect, useRef, useState } from "react";

// --- PLAN DNIA: typy + loader z priorytetem JSON -> TXT ---
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;             // dla VERIFY
  prompt?: string;             // dla SAY
  min_sentences?: number;
  starts_with?: string[];
  starts_with_any?: string[];
  prep_ms?: number;            // meta: czas przygotowania (SAY)
  dwell_ms?: number;           // meta: czas wyświetlenia kroku
  note?: string;               // meta: delikatna wskazówka w SAY
};

async function loadDayPlanOrTxt(day: string): Promise<{ source: "json" | "txt"; steps: PlanStep[] }> {
  // 1) spróbuj JSON
  try {
    const r = await fetch(`/days/${day}.plan.json`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const steps = Array.isArray(j?.steps) ? (j.steps as PlanStep[]) : [];
      if (steps.length) return { source: "json", steps };
    }
  } catch { /* ign */ }

  // 2) fallback TXT → każda linia = VERIFY
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

// pobierz parametr z URL (np. ?day=03)
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

// --- Normalizacja / dopasowanie do VERIFY ---
function deburrPL(s: string) {
  return s
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[„”"’']/g, "")
    .toLowerCase();
}
function normalize(s: string) {
  // bez Unicode property escapes – zgodne z domyślnym targetem TS/Next
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
  // bez lookbehind – kompatybilny podział po . ! ?
  return s
    .split(/[.!?]+\s+/g)
    .map(x => x.trim())
    .filter(Boolean);
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // --- USTAWIENIA ---
  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień " + (typeof window !== "undefined" ? (getParam("day","01")) : "01");
  const MAX_TIME = 6 * 60; // 6 minut

  // --- STANY ---
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [idx, setIdx] = useState(0);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);

  // plan / kroki
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [displayText, setDisplayText] = useState<string>("");
  type Phase = "prep" | "show";
  const [phase, setPhase] = useState<Phase>("show");

  // timery
  const timerRef = useRef<number | null>(null);
  const stepTimeoutRef = useRef<number | null>(null);

  // bufor SAY (echo wypowiedzi)
  const sayBufferRef = useRef<string>("");

  // --- AUDIO: mikrofon + Whisper nasłuch co 3s ---
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef   = useRef<MediaStream | null>(null);
  const chunksRef        = useRef<BlobPart[]>([]);
  const CHUNK_MS = 3000; // 3 sekundy

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

    mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };

    mr.onstop = async () => {
      if (!chunksRef.current.length) return;
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
      chunksRef.current = [];
      const file = new File([blob], `clip.${(mr.mimeType || "").includes("mp4") ? "m4a" : "webm"}`, { type: blob.type });

      const fd = new FormData();
      fd.append("file", file);

      try {
        const res = await fetch("/api/whisper", { method: "POST", body: fd });
        const data = await res.json();
        if (data?.text) handleTranscript(data.text);
      } catch {
        // cicho w MVP
      }

      const rec = mediaRecorderRef.current;
if (rec && rec.state !== "recording") {
  rec.start();
  setTimeout(() => rec.stop(), CHUNK_MS);
}


    mr.start();
    setTimeout(() => mr.stop(), CHUNK_MS);
  }

  function stopMic() {
    mediaRecorderRef.current?.state === "recording" && mediaRecorderRef.current.stop();
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
        // wstępny napis
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

  // --- VU-meter (wizualizacja – niezależnie od Whispera) ---
  useEffect(() => {
    if (!isRunning) return;

    let raf: number | null = null;
    let analyser: AnalyserNode | null = null;
    let audioCtx: AudioContext | null = null;
    let streamRef: MediaStream | null = null;

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
          let peak = 0;
          for (let i = 0; i < data.length; i++) {
            const v = Math.abs((data[i] - 128) / 128);
            if (v > peak) peak = v;
          }
          const target = Math.min(100, peak * 380);
          setLevelPct(prev => Math.max(target, prev * 0.85));
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
      // SAY
      const prep = Number(s.prep_ms ?? 5000);
      const dwell = Number(s.dwell_ms ?? 45000);

      sayBufferRef.current = ""; // reset echa
      setPhase("prep");
      setDisplayText(s.prompt || "");

      clearStepTimeout();
      stepTimeoutRef.current = window.setTimeout(() => {
        setPhase("show"); // okno mówienia
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

  // --- Obsługa transkrypcji (VERIFY → auto-next, SAY → echo i wczesne zakończenie) ---
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

  // --- start/stop sesji ---
  const startSession = () => {
    if (!steps.length) return;
    setIsRunning(true);
    setRemaining(MAX_TIME);
    setIdx(0);

    // licznik czasu
    timerRef.current = window.setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) { stopSession(); return 0; }
        return prev - 1;
      });
    }, 1000);

    // silnik kroków
    runStep(0);

    // audio → Whisper
    startMic();
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
      {/* Topbar (większy, zbity) */}
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

      {/* Timer pod panelem */}
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
                Kamera i mikrofon włączą się, a kroki będą prowadzić Cię w spokojnym tempie.
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

            {/* delikatna wskazówka dla SAY */}
            {steps[idx]?.mode === "SAY" && phase === "show" && steps[idx]?.note && (
              <div className="mt-4 text-center opacity-70 text-sm">
                {steps[idx].note}
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








