"use client";

import { useEffect, useRef, useState } from "react";

function splitIntoSentences(input: string): string[] {
  const raw = input.replace(/\r/g, " ").replace(/\n+/g, "\n").trim();
  const lines = raw.split("\n").map(s => s.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  return raw.split(/(?<=[\.\?\!])\s+/g).map(s => s.trim()).filter(Boolean);
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień 1";
  const MAX_TIME = 6 * 60;
  const SENTENCE_INTERVAL_MS = 5000;

  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [sentences, setSentences] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);

  const timerRef = useRef<number | null>(null);
  const sentenceRef = useRef<number | null>(null);

  useEffect(() => {
    fetch("/days/day01/prompter.txt")
      .then(r => r.text())
      .then(t => {
        const segs = splitIntoSentences(t);
        setSentences(segs.length ? segs : ["Brak treści."]);
        setIdx(0);
      })
      .catch(() => setSentences(["Nie udało się wczytać tekstu."]));
  }, []);

  useEffect(() => {
    if (!isRunning) return;

    let raf: number | null = null;
    let analyser: AnalyserNode | null = null;
    let audioCtx: AudioContext | null = null;
    let streamRef: MediaStream | null = null;

    const start = async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;

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
    };

    start().catch(() => alert("Zezwól na dostęp do kamery i mikrofonu."));

    return () => {
      if (raf) cancelAnimationFrame(raf);
      streamRef?.getTracks().forEach(t => t.stop());
      audioCtx?.close().catch(() => {});
    };
  }, [isRunning]);

  const clearAll = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (sentenceRef.current) window.clearInterval(sentenceRef.current);
  };

  const startSession = () => {
    if (!sentences.length) return;
    setIsRunning(true);
    setRemaining(MAX_TIME);
    setIdx(0);

    timerRef.current = window.setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) { stopSession(); return 0; }
        return prev - 1;
      });
    }, 1000);

    sentenceRef.current = window.setInterval(() => {
      setIdx(prev => (prev + 1) % Math.max(1, sentences.length));
    }, SENTENCE_INTERVAL_MS);
  };

  const stopSession = () => {
    setIsRunning(false);
    clearAll();
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

      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {!isRunning && (
          <div className="overlay center">
            <div className="intro">
              <h2>Teleprompter</h2>
              <p>
                Gdy będziesz gotowy, kliknij <b>Start</b> w panelu u góry.
                Kamera i mikrofon włączą się, a zdania będą zmieniać się co 5 sekund.
              </p>
            </div>
          </div>
        )}

        {isRunning && (
          <div className="overlay center">
            <div key={idx} className="center-text fade">
              {sentences[idx] || ""}
            </div>
          </div>
        )}

        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}


