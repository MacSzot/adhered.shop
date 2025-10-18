"use client";

import { useEffect, useRef, useState } from "react";

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState<string>("Ładowanie tekstu...");
  const [isRunning, setIsRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

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
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      alert("Zezwól na dostęp do kamery i mikrofonu.");
      console.error(err);
    }
  };

  const startSession = () => {
    setIsRunning(true);
    startCamera();
    timerRef.current = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
  };

  const stopSession = () => {
    setIsRunning(false);
    if (timerRef.current) clearInterval(timerRef.current);
    const stream = videoRef.current?.srcObject as MediaStream;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
  };

  useEffect(() => {
    if (!isRunning || !textRef.current) return;
    const interval = setInterval(() => {
      if (textRef.current) textRef.current.scrollTop += 1;
    }, 50);
    return () => clearInterval(interval);
  }, [isRunning]);

  useEffect(() => {
    if (elapsed >= MAX_TIME && isRunning) {
      stopSession();
      alert("Czas sesji zakończony (6 minut).");
    }
  }, [elapsed, isRunning]);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60).toString().padStart(2, "0");
    const s = (sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  return (
    <main className="prompter-container">
      <header className="header">
        <h1 className="title">adhered • Prompter</h1>
        <div className="timer">{isRunning ? formatTime(elapsed) : "00:00"}</div>
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
