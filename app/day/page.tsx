"use client";

import { useEffect, useRef, useState } from "react";

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState<string>("Ładowanie tekstu...");
  const [isRunning, setIsRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<number | null>(null); // przeglądarka: number

  const MAX_TIME = 6 * 60; // 6 minut

  useEffect(() => {
    fetch("/days/day01/prompter.txt")
      .then((r) => r.text())
      .then((t) => setText(t))
      .catch(() => setText("Nie udało się wczytać tekstu."));
  }, []);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch (err) {
      alert("Zezwól na dostęp do kamery i mikrofonu.");
      console.error(err);
    }
  };

  const startSession = () => {
    setIsRunning(true);
    startCamera();
    timerRef.current = window.setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
  };

  const stopSession = () => {
    setIsRunning(false);
    if (timerRef.current) window.clearInterval(timerRef.current);
    const stream = videoRef.current?.srcObject as MediaStream | undefined;
    stream?.getTracks().forEach((t) => t.stop());
  };

  // auto-scroll
  useEffect(() => {
    if (!isRunning || !textRef.current) return;
    const id = window.setInterval(() => {
      if (textRef.current) textRef.current.scrollTop += 1;
    }, 50);
    return () => window.clearInterval(id);
  }, [isRunning]);

  // auto-stop po 6 minutach
  useEffect(() => {
    if (elapsed >= MAX_TIME && isRunning) {
      stopSession();
      alert("Czas sesji zakończony (6 minut).");
    }
  }, [elapsed, isRunning]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = (s % 60).toString().padStart(2, "0");
    return `${m}:${ss}`;
  };

  return (
    <main className="prompter-container">
      <header className="header">
        <h1 className="title">adhered • Prompter</h1>
        <div className="timer">{isRunning ? fmt(elapsed) : "00:00"}</div>
      </header>

      <div className="grid">
        <div className="video-box">
          <video ref={videoRef} autoPlay playsInline muted className="video" />
        </div>
        <div className="text-box" ref={textRef}>
          <pre>{text}</pre>
        </div>
      </div>

      <div className="controls">
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
      </div>
    </main>
  );
}
