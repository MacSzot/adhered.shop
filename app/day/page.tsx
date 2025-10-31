"use client";
import { useEffect, useRef, useState } from "react";

type PlanStep = { mode: "VERIFY" | "SAY"; target?: string; prompt?: string; prep_ms?: number; dwell_ms?: number; };

async function loadDayPlanOrTxt(day: string) {
  try {
    const r = await fetch(`/days/${day}.plan.json`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const steps = Array.isArray(j?.steps) ? (j.steps as PlanStep[]) : [];
      if (steps.length) return steps;
    }
  } catch {}
  const r2 = await fetch(`/days/${day}.txt`, { cache: "no-store" });
  const txt = await r2.text();
  return txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => ({ mode: "VERIFY" as const, target: line }));
}

function getParam(name: string, fb: string) {
  if (typeof window === "undefined") return fb;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fb;
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień " + (typeof window !== "undefined" ? getParam("day", "01") : "01");
  const MAX_TIME = 6 * 60;

  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [levelPct, setLevelPct] = useState(0);
  const [showHint, setShowHint] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  const stepToken = useRef(0);
  const heardRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const noiseRmsRef = useRef(0.0);
  const noisePeakRef = useRef(0.0);
  const calibratingRef = useRef(true);
  const calibUntilRef = useRef(0);
  const silence7Ref = useRef<number | null>(null);
  const silence12Ref = useRef<number | null>(null);
  const speakAdvRef = useRef<number | null>(null);
  const speakingDurRef = useRef(0); // trwałość głosu
  const speakingRef = useRef(false);

  // ---- LOAD ----
  useEffect(() => {
    (async () => {
      const day = getParam("day", "01");
      const s = await loadDayPlanOrTxt(day);
      setSteps(s);
      setIdx(0);
      setDisplayText(s[0]?.target || s[0]?.prompt || "Brak treści");
    })();
  }, []);

  // ---- TIMER ----
  const endAtRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  function startTimer() {
    stopTimer();
    endAtRef.current = Date.now() + MAX_TIME * 1000;
    intervalRef.current = window.setInterval(() => {
      if (!endAtRef.current) return;
      const s = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
      setRemaining(s);
      if (s <= 0) stopSession();
    }, 1000);
  }
  function stopTimer() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
  }

  // ---- AV ----
  async function startAV() {
    stopAV();
    setMicError(null);
    calibratingRef.current = true;
    calibUntilRef.current = performance.now() + 1500;
    noiseRmsRef.current = 0; noisePeakRef.current = 0;
    speakingDurRef.current = 0; speakingRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (videoRef.current) (videoRef.current as any).srcObject = stream;
      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new Ctx(); audioCtxRef.current = ac;
      const analyser = ac.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.75;
      ac.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.fftSize);

      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0, sum = 0;
        for (let i = 0; i < data.length; i++) {
          const x = (data[i] - 128) / 128; const a = Math.abs(x);
          if (a > peak) peak = a; sum += x * x;
        }
        const rms = Math.sqrt(sum / data.length);
        const vu = Math.min(100, peak * 460);
        setLevelPct(prev => Math.max(vu, prev * 0.8));

        const now = performance.now();
        if (calibratingRef.current) {
          noiseRmsRef.current += rms; noisePeakRef.current += peak;
          if (now > calibUntilRef.current) {
            noiseRmsRef.current /= 60; noisePeakRef.current /= 60; calibratingRef.current = false;
          }
          rafRef.current = requestAnimationFrame(loop); return;
        }

        const speakingNow = (rms > noiseRmsRef.current * 2.0 + 0.01) || (peak > noisePeakRef.current * 1.7 + 0.02);
        if (speakingNow) {
          speakingDurRef.current += 1 / 60;
          if (speakingDurRef.current > 0.4 && !speakingRef.current) {
            speakingRef.current = true;
            if (!heardRef.current) onHeard();
          }
        } else {
          speakingDurRef.current = 0;
          speakingRef.current = false;
        }

        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      return true;
    } catch (err: any) {
      console.error(err);
      setMicError("Brak dostępu do mikrofonu/kamery.");
      return false;
    }
  }

  function stopAV() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    analyserRef.current = null;
    audioCtxRef.current?.close();
  }

  // ---- KROKI ----
  function clearStepTimers() {
    [silence7Ref, silence12Ref, speakAdvRef].forEach(r => { if (r.current) clearTimeout(r.current); r.current = null; });
  }

  function runStep(i: number) {
    if (!steps.length) return;
    const s = steps[i]; if (!s) return;
    stepToken.current++; heardRef.current = false; setShowHint(false);
    clearStepTimers();
    setDisplayText(s.target || s.prompt || "");

    if (s.mode === "VERIFY") {
      const token = stepToken.current;
      silence7Ref.current = window.setTimeout(() => {
        if (token === stepToken.current && !heardRef.current) setShowHint(true);
      }, 7000);
      silence12Ref.current = window.setTimeout(() => {
        if (token === stepToken.current && !heardRef.current) {
          setShowHint(false);
          gotoNext(i);
        }
      }, 12000);
    } else {
      const dwell = s.dwell_ms ?? 5000;
      window.setTimeout(() => gotoNext(i), dwell);
    }
  }

  function onHeard() {
    heardRef.current = true; setShowHint(false);
    if (silence7Ref.current) clearTimeout(silence7Ref.current);
    if (silence12Ref.current) clearTimeout(silence12Ref.current);
    const token = stepToken.current;
    speakAdvRef.current = window.setTimeout(() => {
      if (token === stepToken.current) gotoNext(idx);
    }, 4000);
  }

  function gotoNext(i: number) {
    clearStepTimers(); setShowHint(false);
    const next = (i + 1) % steps.length;
    setIdx(next); runStep(next);
  }

  // ---- SESJA ----
  const startSession = async () => {
    const ok = await startAV();
    if (!ok) return;
    setIsRunning(true);
    startTimer();
    setIdx(0);
    runStep(0);
  };
  function stopSession() {
    setIsRunning(false); stopTimer(); stopAV(); clearStepTimers();
  }

  // ---- RENDER ----
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <main className="prompter-full">
      <header className="topbar topbar--dense">
        <nav className="tabs"><a className="tab active">Prompter</a></nav>
        <div className="top-info compact">
          <span className="meta"><b>Użytkownik:</b> {USER_NAME}</span> <span className="dot">•</span>
          <span className="meta"><b>Dzień:</b> {DAY_LABEL}</span>
        </div>
        <div className="controls-top">
          {!isRunning ? <button className="btn" onClick={startSession}>Start</button>
            : <button className="btn" onClick={stopSession}>Stop</button>}
        </div>
      </header>

      <div className="timer-top timer-top--strong">{fmt(remaining)}</div>

      <div className="stage mirrored">
        <video ref={videoRef} autoPlay playsInline muted className="cam" />
        {!isRunning &&
          <div className="overlay center">
            <div className="intro">
              <h2>Teleprompter</h2>
              <p>Kliknij <b>Start</b>, udziel dostępu do kamery i mikrofonu.<br />
                Po głosie: przejście po <b>4 s</b>. Po ciszy: przypomnienie po <b>7 s</b>,
                automatyczne przejście po <b>12 s</b>.
              </p>
              {micError && <p style={{ color: "#ffb3b3" }}>{micError}</p>}
            </div>
          </div>}

        {isRunning &&
          <div className="overlay center">
            <div className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>{displayText}</div>
            {showHint &&
              <div style={{
                position: "absolute", left: 0, right: 0, bottom: 72,
                textAlign: "center", fontSize: 16, color: "rgba(255,255,255,0.95)"
              }}>
                Czy możesz powtórzyć na głos?
              </div>}
          </div>}
        <div className="meter-vertical"><div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} /></div>
      </div>
    </main>
  );
}
