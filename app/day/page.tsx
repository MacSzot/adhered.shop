"use client";
import { useEffect, useRef, useState } from "react";

export default function DayPage() {
  const [running, setRunning] = useState(false);
  const [timeLeft, setTimeLeft] = useState(360);
  const [line, setLine] = useState(0);
  const [vu, setVu] = useState(0);
  const [hint, setHint] = useState(false);

  const LINES = [
    "Jestem w bardzo dobrym miejscu.",
    "Szacunek do siebie staje się naturalny.",
    "Popatrz na siebie i podziękuj sobie.",
    "Popatrz na siebie i przyznaj sobie rację.",
    "Popatrz na siebie i pogratuluj sobie.",
  ];

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Float32Array | null>(null);

  async function start() {
    setRunning(true);
    setHint(false);
    setLine(0);
    setTimeLeft(360);

    // uruchom mikrofon
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => {});
    }

    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    analyserRef.current = analyser;
    dataRef.current = new Float32Array(analyser.fftSize);
    listen();

    // zmiana tekstów
    const slide = setInterval(() => {
      setLine((i) => (i + 1) % LINES.length);
      setHint(false);
    }, 7000);

    // zegar
    const timer = setInterval(() => setTimeLeft((t) => (t > 0 ? t - 1 : 0)), 1000);

    // przypominajka
    const silence = setInterval(() => setHint(true), 10000);

    return () => {
      clearInterval(slide);
      clearInterval(timer);
      clearInterval(silence);
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
    };
  }

  function listen() {
    const analyser = analyserRef.current;
    const data = dataRef.current;
    if (!analyser || !data) return;
    analyser.getFloatTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
    setVu(Math.min(100, Math.round(rms * 1000)));
    requestAnimationFrame(listen);
  }

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          padding: "12px 16px",
          background: "rgba(0,0,0,.4)",
        }}
      >
        <div>
          <b>Użytkownik:</b> demo &nbsp; <b>Dzień programu:</b> 1
        </div>
        <div style={{ fontSize: 28, fontWeight: 700 }}>{`${Math.floor(timeLeft / 60)}:${String(
          timeLeft % 60
        ).padStart(2, "0")}`}</div>
        <button onClick={() => start()} style={{ padding: "4px 12px", borderRadius: 8 }}>
          Start
        </button>
      </header>

      {/* kamera */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: "scaleX(-1)", // tylko kamera, nie tekst!
          filter: "brightness(0.95)",
          zIndex: 0,
        }}
      />

      {/* tekst na środku */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "0 24px",
          zIndex: 2,
          fontSize: 28,
          lineHeight: 1.5,
        }}
      >
        {LINES[line]}
      </div>

      {/* przypominajka */}
      {hint && (
        <div
          style={{
            position: "absolute",
            bottom: "10%",
            left: 0,
            right: 0,
            textAlign: "center",
            fontSize: 16,
            opacity: 0.9,
          }}
        >
          Jeśli możesz, postaraj się przeczytać na głos.
        </div>
      )}
    </main>
  );
}
