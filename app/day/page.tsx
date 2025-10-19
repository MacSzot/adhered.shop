"use client";

import { useEffect, useRef, useState } from "react";

// proste dzielenie na zdania: po . ? ! lub po liniach
function splitIntoSentences(input: string): string[] {
  const raw = input.replace(/\r/g, " ").replace(/\n+/g, "\n").trim();
  // jeśli autor dał po jednym zdaniu w linii — szanujemy to;
  // w przeciwnym razie tniemy po znakach kończących zdanie
  const lines = raw.split("\n").map(s => s.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  return raw.split(/(?<=[\.\?\!])\s+/g).map(s => s.trim()).filter(Boolean);
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // ——— USTAWIENIA ———
  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień 1";
  const MAX_TIME = 6 * 60;           // 6 minut
  const SENTENCE_INTERVAL_MS = 5000; // ← zmiana co 5 sekund
  const MIC_GAIN = 380;              // czułość VU

  // ——— STANY ———
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [sentences, setSentences] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true); // mirror zawsze ON (bez przycisku)

  // ——— TIMERS & AUDIO ———
  const timerRef = useRef<number | null>(null);
  const sentenceRef = useRef<number | null>(null);
  const rafMeterRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  // wczytaj tekst
  useEffect(() => {
    fetch("/days/day01/prompter.txt")
      .then(r => r.text())
      .then(t => {
        const segs = splitIntoSentences(t);
        setSentences(segs.length ? segs : ["Brak treści."]);
        setIdx(0);
      })
      .catch(() => {
        setSentences(["Nie udało się wczytać tekstu."]);
      });
  }, []);

  // audio meter (żywy „peak”)
  const setupAudioMeter = (stream: MediaStream) => {
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const src = ctx.createMediaStreamSource(stream);
    src.connect(analyser);

    audioCtxRef.current = ctx;
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs((data[i] - 128) / 128);
        if (v > peak) peak = v;
      }
      const target = Math.min(100, peak * MIC_GAIN);
      setLevelPct(prev => Math.max(target, prev * 0.85));
      rafMeterRef.current = requestAnimationFrame(tick);
    };
    rafMeterRef.current = requestAnimationFrame(tick);
  };

  const startCamera = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    mediaStreamRef.current = stream;
    if (videoRef.current) videoRef.current.srcObject = stream;
    setupAudioMeter(stream);
  };

  const clearAll = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (sentenceRef.current) window.clearInterval(sentenceRef.current);
  };

  const stopSession = () => {
    setIsRunning(false);
    clearAll();
    if (rafMeterRef.current) cancelAnimationFrame(rafMeterRef.current);
    mediaStreamRef.current?.getTracks().forEach(t => t.stop());
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    setLevelPct(0);
  };

  const startSession = async () => {
    if (!sentences.length) return;
    setIsRunning(true);
    setRemaining(MAX_TIME);
    setIdx(0);

    try {
      await startCamera();
    } catch (e) {
      alert("Zezwól na dostęp do kamery i mikrofonu.");
      console.error(e);
      return;
    }

    // zegar malejący
    timerRef.current = window.setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) {
          stopSession();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // zmiana zdania co 5 sekund — cyklicznie
    sentenceRef.current = window.setInterval(() => {
      setIdx(prev => (prev + 1) % Math.max(1, sentences.length));
    }, SENTENCE_INTERVAL_MS);
  };

  // tapnięcie = następne zdanie natychmiast (nie resetuje interwału)
  const nextSentenceNow = () => {
    if (!isRunning) return;
    setIdx(prev => (prev + 1) % Math.max(1, sentences.length));
  };

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(1, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <main className="prompter-full" onClick={nextSentenceNow}>
      {/* GÓRNY PANEL */}
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
            <button className="btn" onClick={(e) => { e.stopPropagation(); startSession(); }}>Start</button>
          ) : (
            <button className="btn" onClick={(e) => { e.stopPropagation(); stopSession(); }}>Stop</button>
          )}
        </div>
      </header>

      {/* TIMER — na samej górze obrazu */}
      <div className="timer-top">{fmt(remaining)}</div>

      {/* KAMERA + overlay */}
      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />
        <div className="overlay center">
          <div key={idx} className="center-text fade">
            {sentences[idx] || ""}
          </div>
        </div>

        {/* VU-meter pionowy */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}



