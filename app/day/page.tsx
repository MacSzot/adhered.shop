"use client";

import { useEffect, useRef, useState } from "react";

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [text, setText] = useState("Ładowanie tekstu…");
  const [isRunning, setIsRunning] = useState(false);

  const MAX_TIME = 6 * 60; // 6 minut
  const [remaining, setRemaining] = useState(MAX_TIME);
  const timerRef = useRef<number | null>(null);
  const [mirror, setMirror] = useState(true);

  // mikrofon
  const [level, setLevel] = useState(0);
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
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      setLevel((prev) => Math.max(rms, prev * 0.8));
      rafMeterRef.current = requestAnimationFrame(tick);
    };
    rafMeterRef.current = requestAnimationFrame(tick);
  };

  const startCamera = async () => {
    try {
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

  const startSession = () => {
    setIsRunning(true);
    startCamera();
    setRemaining(MAX_TIME);
    timerRef.current = window.setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          stopSession();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const stopSession = () => {
    setIsRunning(false);
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (rafMeterRef.current) cancelAnimationFrame(rafMeterRef.current);
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    setLevel(0);
  };

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(1, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <main className="prompter-full">
      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* overlay z tekstem i licznikiem */}
        <div className="overlay">
          {/* licznik czasu */}
          <div className="big-timer">{fmt(remaining)}</div>

          {/* tekst na środku */}
          <div className="center-text">
            {text.split("\n").map((line, i) => (
              <p key={i}>{line || " "}</p>
            ))}
          </div>
        </div>

        {/* pionowy mikrofon z boku */}
        <div className="meter-vertical">
          <div
            className="meter-vertical-fill"
            style={{ height: `${Math.min(100, level * 150)}%` }}
          />
        </div>
      </div>

      {/* kontrolki */}
      <footer className="controls">
        {!isRunning ? (
          <button onClick={startSession}>Start</button>
        ) : (
          <button onClick={stopSession}>Stop</button>
        )}
        <button onClick={() => setMirror((m) => !m)} className="ghost">
          {mirror ? "Mirror: ON" : "Mirror: OFF"}
        </button>
      </footer>
    </main>
  );
}

