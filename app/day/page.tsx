"use client";

import { useEffect, useRef, useState } from "react";

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [text, setText] = useState("Ładowanie tekstu…");
  const [isRunning, setIsRunning] = useState(false);

  // czas
  const MAX_TIME = 6 * 60; // 6 minut
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<number | null>(null);
  const rafScrollRef = useRef<number | null>(null);

  // przewijanie
  const [speed, setSpeed] = useState(1); // px/frame
  const [mirror, setMirror] = useState(true); // odbicie lustrzane

  // audio meter
  const [level, setLevel] = useState(0); // 0..1
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafMeterRef = useRef<number | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    fetch("/days/day01/prompter.txt")
      .then((r) => r.text())
      .then(setText)
      .catch(() => setText("Nie udało się wczytać tekstu."));
  }, []);

  const setupAudioMeter = (stream: MediaStream) => {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    audioCtxRef.current = ctx;
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.fftSize);
    const tickMeter = () => {
      analyser.getByteTimeDomainData(data);
      // RMS
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length); // ~0..1
      // wygładzenie i przycięcie
      setLevel((prev) => Math.max(rms, prev * 0.8));
      rafMeterRef.current = requestAnimationFrame(tickMeter);
    };
    rafMeterRef.current = requestAnimationFrame(tickMeter);
  };

  const startCamera = async () => {
    try {
      // poprosi o zgodę na KAMERĘ i MIKROFON
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      mediaStreamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setupAudioMeter(stream);
    } catch (e) {
      alert("Zezwól na dostęp do kamery i mikrofonu.");
      console.error(e);
    }
  };

  const tickScroll = () => {
    if (scrollRef.current) scrollRef.current.scrollTop += speed;
    rafScrollRef.current = requestAnimationFrame(tickScroll);
  };

  const startSession = () => {
    setIsRunning(true);
    startCamera();
    timerRef.current = window.setInterval(() => setElapsed((p) => p + 1), 1000);
    rafScrollRef.current = requestAnimationFrame(tickScroll);
  };

  const stopSession = () => {
    setIsRunning(false);
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (rafScrollRef.current) cancelAnimationFrame(rafScrollRef.current);
    if (rafMeterRef.current) cancelAnimationFrame(rafMeterRef.current);

    // zatrzymanie streamu
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;

    // zamknięcie audio
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;

    setLevel(0);
  };

  useEffect(() => {
    if (elapsed >= MAX_TIME && isRunning) {
      stopSession();
      alert("Czas sesji zakończony (6 minut).");
    }
  }, [elapsed, isRunning]);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const remaining = Math.max(0, MAX_TIME - elapsed);
  const progress = Math.min(100, (elapsed / MAX_TIME) * 100);

  return (
    <main className="prompter-full">
      <header className="topbar">
        <div className="left">adhered • Prompter</div>
        <div className="right">
          <div className="timewrap">
            <span className="timer">{isRunning ? fmt(elapsed) : "00:00"}</span>
            <span className="slash">/</span>
            <span className="timer">{fmt(remaining)}</span>
          </div>
          <button onClick={() => setMirror((m) => !m)} className="ghost">
            {mirror ? "Mirror: ON" : "Mirror: OFF"}
          </button>
        </div>
      </header>

      {/* Pasek postępu czasu */}
      <div className="timebar">
        <div className="timebar-fill" style={{ width: `${progress}%` }} />
      </div>

      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* OVERLAY z tekstem na kamerze */}
        <div className="overlay">
          <div className="mask top" />
          <div className="mask bottom" />
          <div className="scroll" ref={scrollRef}>
            <div className="script">
              {text.split("\n").map((line, i) => (
                <p key={i}>{line || " "}</p>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* VU-meter mikrofonu */}
      <div className="meter">
        <div className="meter-fill" style={{ width: `${Math.min(100, level * 140)}%` }} />
      </div>

      <footer className="controls">
        {!isRunning ? (
          <button onClick={startSession}>Start</button>
        ) : (
          <button onClick={stopSession}>Stop</button>
        )}
        <button
          onClick={() => {
            stopSession();
            alert("Zakończono sesję.");
          }}
        >
          Zrobione
        </button>

        <div className="speed">
          Prędkość:
          <input
            type="range"
            min={0}
            max={4}
            step={0.25}
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
          />
          <span>{speed.toFixed(2)} px/f</span>
        </div>
      </footer>
    </main>
  );
}

