"use client";

import { useEffect, useRef, useState } from "react";

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [text, setText] = useState("Ładowanie tekstu…");
  const [isRunning, setIsRunning] = useState(false);

  // --- USTAWIENIA / placeholdery (później podmienimy z tokena / query) ---
  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień 1";
  const MAX_TIME = 6 * 60; // 6 minut
  const MIC_GAIN = 320; // ↑ czułość mikrofonu (im wyżej, tym żywiej)

  // --- czas ---
  const [remaining, setRemaining] = useState(MAX_TIME);
  const timerRef = useRef<number | null>(null);

  // --- mirror ---
  const [mirror, setMirror] = useState(true);

  // --- mikrofon (VU) ---
  const [levelPct, setLevelPct] = useState(0); // 0..100%
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
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    audioCtxRef.current = ctx;
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);

      // Peak z ostatniej ramki (bardziej "żywy" niż RMS)
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs((data[i] - 128) / 128); // 0..1
        if (v > peak) peak = v;
      }

      // wzmocnienie + lekkie wygładzenie
      const target = Math.min(100, peak * MIC_GAIN);
      setLevelPct((prev) => Math.max(target, prev * 0.85));

      rafMeterRef.current = requestAnimationFrame(tick);
    };
    rafMeterRef.current = requestAnimationFrame(tick);
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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
    setLevelPct(0);
  };

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(1, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <main className="prompter-full">
      {/* GÓRNY PANEL (zakładki + user/day + sterowanie) */}
      <header className="topbar">
        <nav className="tabs">
          <a className="tab active" href="/day" aria-current="page">Prompter</a>
          <span className="tab disabled" aria-disabled="true" title="Wkrótce">Rysownik</span>
        </nav>

        <div className="top-info">
          <span className="meta"><b>Użytkownik:</b> {USER_NAME}</span>
          <span className="meta"><b>Dzień programu:</b> {DAY_LABEL}</span>
        </div>

        <div className="controls-top">
          {!isRunning ? (
            <button className="btn" onClick={startSession}>Start</button>
          ) : (
            <button className="btn" onClick={stopSession}>Stop</button>
          )}
          <button className="btn ghost" onClick={() => setMirror((m) => !m)}>
            {mirror ? "Mirror: ON" : "Mirror: OFF"}
          </button>
        </div>
      </header>

      {/* TIMER NA SAMEJ GÓRZE OBRAZU (na kamerze) */}
      <div className="timer-top">{fmt(remaining)}</div>

      {/* KAMERA + overlay z tekstem */}
      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />
        <div className="overlay center">
          <div className="center-text">
            {text.split("\n").map((line, i) => (
              <p key={i}>{line || " "}</p>
            ))}
          </div>
        </div>

        {/* VU-meter pionowy po prawej */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}


