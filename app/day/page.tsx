"use client";

import { useEffect, useRef, useState } from "react";

// --- Typy i ładowanie planu dnia ---
type PlanStep = {
  mode: "VERIFY" | "SAY";
  prompt?: string;
  dwell_ms?: number;
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
  const steps: PlanStep[] = txt.split(/\r?\n/).map(s => ({ mode: "VERIFY", prompt: s.trim(), dwell_ms: 5000 }));
  return { source: "txt", steps };
}

function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const USER_NAME = "demo";
  const DAY = typeof window !== "undefined" ? getParam("day", "01") : "01";
  const DAY_LABEL = "Dzień " + DAY;

  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [displayText, setDisplayText] = useState("");
  const [feedback, setFeedback] = useState("");
  const [mirror] = useState(true);
  const [levelPct, setLevelPct] = useState(0);

  const sayBufferRef = useRef<string>("");
  const retryRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const CHUNK_MS = 2000; // nasłuch co 2 s
  const TIMEOUT_MS = 8000; // max czas na odpowiedź

  // --- MIC + WHISPER ---
  async function startMic() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    if (videoRef.current) (videoRef.current as any).srcObject = stream;

    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mediaRecorderRef.current = mr;

    mr.ondataavailable = e => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    mr.onstop = async () => {
      if (!chunksRef.current.length) return;
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      chunksRef.current = [];
      const fd = new FormData();
      fd.append("file", new File([blob], "clip.webm", { type: "audio/webm" }));

      try {
        const res = await fetch("/api/whisper", { method: "POST", body: fd });
        const data = await res.json();
        if (data?.text) handleTranscript(data.text);
      } catch {}
      setTimeout(() => mr.start(), 0);
      setTimeout(() => mr.stop(), CHUNK_MS);
    };

    mr.start();
    setTimeout(() => mr.stop(), CHUNK_MS);
  }

  function stopMic() {
    const rec = mediaRecorderRef.current;
    if (rec?.state === "recording") rec.stop();
    mediaRecorderRef.current = null;
  }

  // --- GŁÓWNA LOGIKA ---
  useEffect(() => {
    (async () => {
      const { steps } = await loadDayPlanOrTxt(DAY);
      setSteps(steps);
      setDisplayText(steps[0]?.prompt || "");
    })();
  }, []);

  function runStep(i: number) {
    if (!steps[i]) return stopSession();
    setIdx(i);
    setDisplayText(steps[i].prompt || "");
    setFeedback("");

    retryRef.current = 0;
    sayBufferRef.current = "";

    if (steps[i].mode === "SAY") {
      const timeout = setTimeout(() => handleTimeout(i), TIMEOUT_MS);
      timerRef.current = timeout as any;
    }
  }

  function handleTranscript(text: string) {
    if (!isRunning) return;
    const words = text.trim().split(/\s+/).length;
    sayBufferRef.current += "\n" + text.trim();
    setDisplayText(`${steps[idx].prompt}\n\n${sayBufferRef.current.trim()}`);

    if (words >= 5) {
      clearTimeout(timerRef.current!);
      nextStep();
    }
  }

  function handleTimeout(i: number) {
    retryRef.current++;
    if (retryRef.current < 3) {
      setFeedback("Spróbuj powiedzieć to głośniej lub wyraźniej...");
      const timeout = setTimeout(() => handleTimeout(i), TIMEOUT_MS);
      timerRef.current = timeout as any;
    } else {
      nextStep();
    }
  }

  function nextStep() {
    const next = idx + 1;
    if (next < steps.length) runStep(next);
    else stopSession();
  }

  // --- START / STOP ---
  const startSession = () => {
    setIsRunning(true);
    runStep(0);
    startMic();
  };

  const stopSession = () => {
    setIsRunning(false);
    clearTimeout(timerRef.current!);
    stopMic();
  };

  return (
    <main className="prompter-full">
      <header className="topbar topbar--dense">
        <nav className="tabs">
          <a className="tab active" href="/day" aria-current="page">Prompter</a>
          <span className="tab disabled" aria-disabled="true">Rysownik</span>
        </nav>
        <div className="top-info compact">
          <span className="meta"><b>Użytkownik:</b> {USER_NAME}</span>
          <span className="dot">•</span>
          <span className="meta"><b>{DAY_LABEL}</b></span>
        </div>
        <div className="controls-top">
          {!isRunning ? (
            <button className="btn" onClick={startSession}>Start</button>
          ) : (
            <button className="btn" onClick={stopSession}>Stop</button>
          )}
        </div>
      </header>

      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />
        {!isRunning && (
          <div className="overlay center">
            <h2>Teleprompter</h2>
            <p>Kliknij <b>Start</b>, by rozpocząć dzień 08 – Głos własny.</p>
          </div>
        )}
        {isRunning && (
          <div className="overlay center">
            <div className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
              {displayText}
            </div>
            {feedback && (
              <div className="mt-4 text-center text-sm opacity-70">{feedback}</div>
            )}
          </div>
        )}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}
