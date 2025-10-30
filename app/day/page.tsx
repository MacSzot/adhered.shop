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
  // fallback: TXT -> każda linia = VERIFY
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

// --- Normalizacja i dopasowanie ---
function deburrPL(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[„”"’']/g, "").toLowerCase();
}
function normalize(s: string) {
  return deburrPL(s).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
const STOPWORDS = new Set([
  "i","oraz","a","o","u","w","we","z","ze","do","na","po","od","nad","pod","przy","za","to","że","czy","albo","lub",
  "nie","jest","jestem","mam","moje","mój","moja","moją","mnie","mi","się","sie","ten","ta","to","tę","te","tym","tą",
  "jestes","jesteś","twoje","twoja","twój","ty","ja"
]);
function keywordsOf(s: string) {
  return normalize(s)
    .split(" ")
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}
// dopasowanie na zbiorach słów-kluczy
function keywordMatch(transcript: string, target: string) {
  const T = Array.from(new Set(keywordsOf(target)));
  const W = new Set(keywordsOf(transcript));
  if (T.length === 0 || W.size === 0) return 0;
  let hit = 0;
  for (const w of T) if (W.has(w)) hit++;
  return hit / T.length; // 0..1
}

// podział na zdania (bez lookbehind)
function splitSentences(s: string) {
  return s.split(/[.!?]+\s+/g).map(x => x.trim()).filter(Boolean);
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // USTAWIENIA OGÓLNE
  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień " + (typeof window !== "undefined" ? getParam("day","01") : "01");
  const MAX_TIME = 6 * 60;

  // VERIFY – szybkie okna
  const VERIFY_WINDOW_MS = 3000;     // 3 s na próbę
  const VERIFY_MAX_ATTEMPTS = 2;     // 2 szybkie próby
  const VERIFY_OK_FLASH_MS = 600;    // „OK ✓” po zaliczeniu

  // WHISPER chunk
  const CHUNK_MS = 1000;             // 1 s

  // STANY
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [idx, setIdx] = useState(0);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);

  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [displayText, setDisplayText] = useState<string>("");
  type Phase = "prep" | "show";
  const [phase, setPhase] = useState<Phase>("show");

  // SAY: echo i licznik
  const [isSayCollect, setIsSayCollect] = useState(false);
  const [sayEcho, setSayEcho] = useState<string[]>([]);
  const [sayCount, setSayCount] = useState(0);

  // VERIFY: próby i czas
  const verifyAttemptsRef = useRef(0);
  const verifyDeadlineRef = useRef<number | null>(null);
  const verifyTickerRef = useRef<number | null>(null);
  const verifyPassedRef = useRef(false);

  // timery
  const timerRef = useRef<number | null>(null);
  const stepTimeoutRef = useRef<number | null>(null);

  // AUDIO/Whisper
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  async function startMic() {
    if (mediaRecorderRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    audioStreamRef.current = stream;
    if (videoRef.current) (videoRef.current as any).srcObject = stream;

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

  // Loader planu
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

  // VU-meter (tylko wizual)
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
      }
    };
    start();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      streamRef?.getTracks().forEach(t => t.stop());
      audioCtx?.close().catch(() => {});
    };
  }, [isRunning]);

  // Silnik kroków
  function clearStepTimeout() {
    if (stepTimeoutRef.current) {
      window.clearTimeout(stepTimeoutRef.current);
      stepTimeoutRef.current = null;
    }
  }
  function clearVerifyTicker() {
    if (verifyTickerRef.current) {
      window.clearInterval(verifyTickerRef.current);
      verifyTickerRef.current = null;
    }
    verifyDeadlineRef.current = null;
  }

  function startVerifyWindow(target: string) {
    verifyAttemptsRef.current = 0;
    verifyPassedRef.current = false;
    const runAttempt = () => {
      if (verifyPassedRef.current) return;
      verifyAttemptsRef.current += 1;
      verifyDeadlineRef.current = Date.now() + VERIFY_WINDOW_MS;

      // odświeżanie odliczania (lekki efekt)
      clearVerifyTicker();
      verifyTickerRef.current = window.setInterval(() => {
        if (!verifyDeadlineRef.current) return;
        if (Date.now() >= verifyDeadlineRef.current) {
          clearVerifyTicker();
          if (!verifyPassedRef.current) {
            // nieudana próba
            if (verifyAttemptsRef.current >= VERIFY_MAX_ATTEMPTS) {
              // auto-next po 2 próbach
              const next = (idx + 1) % steps.length;
              setIdx(next);
              runStep(next);
            } else {
              setDisplayText(`${target}\n\nPowtórz proszę głośno (${verifyAttemptsRef.current}/2)…`);
              // krótka pauza 400 ms i kolejna próba
              setTimeout(() => {
                setDisplayText(target);
                runAttempt();
              }, 400);
            }
          }
        }
      }, 100);
    };
    setDisplayText(target);
    runAttempt();
  }

  function runStep(i: number) {
    clearStepTimeout();
    clearVerifyTicker();
    verifyPassedRef.current = false;

    if (!steps.length) return;
    const s = steps[i];
    if (!s) return;

    if (s.mode === "VERIFY") {
      setPhase("show");
      setIsSayCollect(false);
      setSayEcho([]);
      setSayCount(0);
      startVerifyWindow(s.target || "");
      return;
    }

    if (s.mode === "SAY") {
      const prep = Number(s.prep_ms ?? 5000);
      setPhase("prep");
      setDisplayText(s.prompt || "");
      setIsSayCollect(false);
      setSayEcho([]);
      setSayCount(0);

      stepTimeoutRef.current = window.setTimeout(() => {
        setPhase("show");
        setDisplayText("");      // znika prompt
        setIsSayCollect(true);   // zbieramy 1/2/3
      }, prep);
    }
  }

  // Transkrypcja → logika VERIFY/SAY
  function handleTranscript(text: string) {
    const s = steps[idx];
    if (!s || !text) return;

    if (s.mode === "VERIFY") {
      // proste szybkie dopasowanie na słowach-kluczach
      const target = s.target || "";
      const score = keywordMatch(text, target);

      const keyT = keywordsOf(target);
      // reguła: krótkie frazy (≤2 słowa-klucze) → wymagamy obu; dłuższe → ≥60%
      const ok =
        (keyT.length <= 2 && score >= 1.0) ||
        (keyT.length >= 3 && score >= 0.6);

      if (ok && !verifyPassedRef.current) {
        verifyPassedRef.current = true;
        clearVerifyTicker();
        setDisplayText("OK ✓");
        setTimeout(() => {
          const next = (idx + 1) % steps.length;
          setIdx(next);
          runStep(next);
        }, VERIFY_OK_FLASH_MS);
      }
      return;
    }

    if (s.mode === "SAY" && isSayCollect) {
      const prev = sayEcho.join(" ");
      const merged = (prev + " " + text).trim();
      const all = splitSentences(merged);

      let filtered = all;
      if (s.starts_with?.length) {
        filtered = all.filter(t => s.starts_with!.some(sw => normalize(t).startsWith(normalize(sw))));
      } else if (s.starts_with_any?.length) {
        filtered = all.filter(t => s.starts_with_any!.some(sw => normalize(t).startsWith(normalize(sw))));
      }

      if (filtered.length !== sayCount) {
        setSayCount(filtered.length);
        setSayEcho(filtered.slice(0, 3));
      }

      const need = s.min_sentences ?? 3;
      if (filtered.length >= need) {
        setIsSayCollect(false);
        setSayEcho([]);
        setSayCount(0);
        const next = (idx + 1) % steps.length;
        setIdx(next);
        runStep(next);
      }
    }
  }

  // Start/Stop
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
    startMic();
  };

  const stopSession = () => {
    setIsRunning(false);
    if (timerRef.current) window.clearInterval(timerRef.current);
    clearStepTimeout();
    clearVerifyTicker();
    stopMic();
    setLevelPct(0);
    setIsSayCollect(false);
    setSayEcho([]);
    setSayCount(0);
    verifyPassedRef.current = false;
  };

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(1, "0")}:${String(s % 60).padStart(2, "0")}`;

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

      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {!isRunning && (
          <div className="overlay center">
            <div className="intro">
              <h2>Teleprompter</h2>
              <p>Kliknij <b>Start</b>. Mów głośno i wyraźnie — kroki są krótkie i szybkie.</p>
            </div>
          </div>
        )}

        {isRunning && (
          steps[idx]?.mode === "SAY" && isSayCollect ? (
            <div className="overlay center" style={{ textAlign: "center" }}>
              <div style={{ fontSize: "72px", fontWeight: 700, lineHeight: 1 }}>
                {Math.min(3, sayCount + 1)}
              </div>
              <div className="mt-4" style={{ whiteSpace: "pre-wrap" }}>
                {sayEcho.join("\n")}
              </div>
            </div>
          ) : (
            <div className="overlay center">
              <div key={idx} className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
                {displayText || ""}
              </div>
              {steps[idx]?.mode === "SAY" && phase === "show" && steps[idx]?.note && (
                <div className="mt-4 text-center opacity-70 text-sm">{steps[idx].note}</div>
              )}
            </div>
          )
        )}

        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}
