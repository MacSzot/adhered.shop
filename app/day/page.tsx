"use client";

import { useEffect, useRef, useState } from "react";

/* ---------- Typy i loader planu ---------- */
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;             // VERIFY: zdanie do powtórzenia
  prompt?: string;             // SAY: komenda wstępna
  min_sentences?: number;      // SAY: ile zdań
  starts_with?: string[];      // SAY: każde zdanie musi zaczynać się od...
  starts_with_any?: string[];  // SAY: ... albo od któregokolwiek z
  prep_ms?: number;            // SAY: czas wyświetlenia promptu
  dwell_ms?: number;           // SAY: sufit czasu na segment „talk”
  note?: string;               // SAY: delikatna wskazówka
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
  // Fallback TXT → każda linia = VERIFY
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

/* ---------- Normalizacja / scoring ---------- */
function deburrPL(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[„”"’']/g, "").toLowerCase();
}
function normalize(s: string) {
  return deburrPL(s).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
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
  return s.split(/[.!?]+\s+/g).map(x => x.trim()).filter(Boolean);
}

type Phase = "verify" | "prep" | "talk";

export default function PrompterPage() {
  /* ---------- Refs i stan ---------- */
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień " + (typeof window !== "undefined" ? getParam("day","01") : "01");
  const MAX_TIME = 6 * 60;

  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [idx, setIdx] = useState(0);
  const [mirror] = useState(true);

  // plan
  const [steps, setSteps] = useState<PlanStep[]>([]);

  // Overlay – rozdzielone warstwy
  const [displayMain, setDisplayMain]   = useState<string>(""); // prompt / verify target
  const [displayHint, setDisplayHint]   = useState<string>(""); // delikatna wskazówka
  const [displayEcho, setDisplayEcho]   = useState<string>(""); // to co user powiedział
  const [displayBadge, setDisplayBadge] = useState<string>(""); // np. "1/3"

  const [phase, setPhase] = useState<Phase>("verify");
  const [levelPct, setLevelPct] = useState(0);

  // Timery
  const timerRef           = useRef<number | null>(null);
  const verifyNudgeRef     = useRef<number | null>(null);

  // VERIFY retry licznik
  const verifyRetriesRef   = useRef<number>(0);

  // SAY bufory/liczniki
  const sayBufferRef       = useRef<string>("");
  const sayCountRef        = useRef<number>(0);

  // Audio / mic
  const mediaRecorderRef   = useRef<MediaRecorder | null>(null);
  const audioStreamRef     = useRef<MediaStream | null>(null);
  const chunksRef          = useRef<BlobPart[]>([]);
  const CHUNK_MS           = 1500; // szybciej, sprawniej

  /* ---------- Mikrofon + Whisper ---------- */
  async function startMic() {
    if (mediaRecorderRef.current) return;

    // (Safari/Chrome) aktywacja kontekstu audio po kliknięciu
    try {
      const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new AC();
      await ac.resume();
      // nie przechowujemy – tylko wyzwolenie user-gesture
    } catch {}

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    audioStreamRef.current = stream;

    // kamera do <video>
    if (videoRef.current) (videoRef.current as any).srcObject = stream;

    const mime =
      MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" :
      MediaRecorder.isTypeSupported("audio/webm")              ? "audio/webm" :
      MediaRecorder.isTypeSupported("audio/mp4")               ? "audio/mp4" : "";

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
        if (data?.text) handleTranscript(data.text as string);
      } catch {
        // cicho w MVP
      }

      const rec = mediaRecorderRef.current;
      if (rec && rec.state !== "recording") {
        rec.start();
        setTimeout(() => rec.stop(), CHUNK_MS);
      }
    };

    mr.start();
    setTimeout(() => mr.stop(), CHUNK_MS);

    // Start VU – z istniejącego streamu
    startVU();
  }

  function stopMic() {
    mediaRecorderRef.current?.state === "recording" && mediaRecorderRef.current.stop();
    mediaRecorderRef.current = null;
    audioStreamRef.current?.getTracks().forEach(t => t.stop());
    audioStreamRef.current = null;
  }

  /* ---------- VU-meter (korzysta ze streamu, jeśli jest) ---------- */
  const vuRAF = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  function startVU() {
    cancelVU();
    if (!audioStreamRef.current) return;
    try {
      const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new AC();
      audioCtxRef.current = ac;
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      ac.createMediaStreamSource(audioStreamRef.current).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs((data[i] - 128) / 128);
          if (v > peak) peak = v;
        }
        const target = Math.min(100, peak * 380);
        setLevelPct(prev => Math.max(target, prev * 0.85));
        vuRAF.current = requestAnimationFrame(tick);
      };
      vuRAF.current = requestAnimationFrame(tick);
    } catch {}
  }
  function cancelVU() {
    if (vuRAF.current) cancelAnimationFrame(vuRAF.current);
    vuRAF.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }

  /* ---------- Loader planu ---------- */
  useEffect(() => {
    const day = getParam("day","01");
    (async () => {
      try {
        const { source, steps } = await loadDayPlanOrTxt(day);
        setSteps(steps);
        setIdx(0);
        // wstępny napis
        const first = steps[0];
        if (first?.mode === "VERIFY") {
          setDisplayMain(first.target || "");
          setPhase("verify");
        } else {
          setDisplayMain(first?.prompt || "");
          setPhase("prep");
        }
        setDisplayHint("");
        setDisplayEcho("");
        setDisplayBadge("");
        // eslint-disable-next-line no-console
        console.log(`[DAY ${day}] source:`, source, `steps: ${steps.length}`);
      } catch (e) {
        setSteps([{ mode: "VERIFY", target: "Brak treści dla tego dnia." }]);
        setDisplayMain("Brak treści dla tego dnia.");
      }
    })();
  }, []);

  /* ---------- Silnik kroków ---------- */
  function clearVerifyNudge() {
    if (verifyNudgeRef.current) {
      window.clearTimeout(verifyNudgeRef.current);
      verifyNudgeRef.current = null;
    }
  }

  function scheduleVerifyNudge(i: number) {
    clearVerifyNudge();
    verifyNudgeRef.current = window.setTimeout(() => {
      if (idx !== i) return;
      const s = steps[i];
      if (!s || s.mode !== "VERIFY") return;
      verifyRetriesRef.current += 1;
      if (verifyRetriesRef.current >= 3) {
        // fail-open po 3 próbach
        goNext();
      } else {
        setDisplayHint("Spróbuj powiedzieć to głośniej lub wyraźniej…");
        // Zaplanuj kolejną próbę
        scheduleVerifyNudge(i);
      }
    }, 8000);
  }

  function runStep(i: number) {
    clearVerifyNudge();
    setDisplayHint("");
    setDisplayEcho("");
    setDisplayBadge("");

    const s = steps[i];
    if (!s) return;

    if (s.mode === "VERIFY") {
      // Stój, dopóki nie zaliczymy (albo po 3 nudge'ach)
      verifyRetriesRef.current = 0;
      setPhase("verify");
      setDisplayMain(s.target || "");
      scheduleVerifyNudge(i);
      return;
    }

    // SAY: 1) prep (prompt) -> 2) talk (echo-only, badge)
    const prep = Number(s.prep_ms ?? 5000);
    setPhase("prep");
    setDisplayMain(s.prompt || "");
    setDisplayHint(s.note || "");
    setDisplayEcho("");
    setDisplayBadge("");

    window.setTimeout(() => {
      if (idx !== i) return; // użytkownik mógł już przejść dalej
      sayBufferRef.current = "";
      sayCountRef.current = 0;
      setPhase("talk");
      setDisplayMain(""); // ukryj prompt – echo-only
      setDisplayHint("");
      setDisplayEcho("");
      setDisplayBadge(`${Math.min(1, (s.min_sentences ?? 3))}/${s.min_sentences ?? 3}`);

      // awaryjny sufit czasu
      const dwell = Number(s.dwell_ms ?? 45000);
      window.setTimeout(() => {
        if (idx === i) goNext(); // jeśli wciąż jesteśmy w tym kroku – przejdź
      }, dwell);
    }, prep);
  }

  function goNext() {
    clearVerifyNudge();
    setDisplayHint("");
    setDisplayEcho("");
    setDisplayBadge("");
    const next = (idx + 1) % steps.length;
    setIdx(next);
    runStep(next);
  }

  /* ---------- Obsługa transkrypcji ---------- */
  function handleTranscript(text: string) {
    const s = steps[idx];
    if (!s || !text) return;

    if (s.mode === "VERIFY") {
      const score = coverage(text, s.target || "");
      const ok = score >= 0.8 && normalize(text).split(" ").length >= 3;
      if (ok) {
        goNext();
      }
      return;
    }

    // SAY
    if (phase !== "talk") return; // interesuje nas tylko echo faza
    sayBufferRef.current = (sayBufferRef.current + " " + text).trim();
    setDisplayEcho(sayBufferRef.current);

    const sentences = splitSentences(sayBufferRef.current);

    // policz poprawne zdania
    let count = 0;
    if (s.starts_with?.length) {
      count = sentences.filter(t => s.starts_with!.some(sw => normalize(t).startsWith(normalize(sw)))).length;
    } else if (s.starts_with_any?.length) {
      count = sentences.filter(t => s.starts_with_any!.some(sw => normalize(t).startsWith(normalize(sw)))).length;
    } else {
      count = sentences.length;
    }

    if (count !== sayCountRef.current) {
      sayCountRef.current = count;
      const need = s.min_sentences ?? 3;
      if (count >= need) {
        goNext();
      } else {
        setDisplayBadge(`${Math.min(count + 1, need)}/${need}`);
      }
    }
  }

  /* ---------- Start / Stop ---------- */
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

    runStep(0);
    startMic();
  };

  const stopSession = () => {
    setIsRunning(false);
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    clearVerifyNudge();
    stopMic();
    cancelVU();
    setLevelPct(0);
  };

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(1,"0")}:${String(s % 60).padStart(2,"0")}`;

  /* ---------- JSX ---------- */
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

      {/* Timer */}
      <div className="timer-top timer-top--strong">{fmt(remaining)}</div>

      {/* Kamera + overlay */}
      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* Overlay */}
        <div className="overlay center">
          {displayBadge && <div className="badge">{displayBadge}</div>}
          {(!isRunning) && (
            <div className="intro">
              <h2>Teleprompter</h2>
              <p>Kliknij <b>Start</b>, by rozpocząć dzień — mikrofon i kamera włączą się po Twojej zgodzie.</p>
            </div>
          )}
          {isRunning && (
            <>
              {displayMain && (
                <div key={`main-${idx}-${phase}`} className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
                  {displayMain}
                </div>
              )}
              {displayHint && (
                <div className="mt-4 text-center opacity-70 text-sm">{displayHint}</div>
              )}
              {displayEcho && (
                <div className="echo-text" style={{ whiteSpace: "pre-wrap", marginTop: "1rem" }}>
                  {displayEcho}
                </div>
              )}
            </>
          )}
        </div>

        {/* VU-meter */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}
