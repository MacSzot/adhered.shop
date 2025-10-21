"use client";

import { useEffect, useRef, useState } from "react";

// dzielenie tekstu: po liniach lub po .?!
function splitIntoSentences(input: string): string[] {
  const raw = input.replace(/\r/g, " ").replace(/\n+/g, "\n").trim();
  const lines = raw.split("\n").map(s => s.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  return raw.split(/(?<=[\.\?\!])\s+/g).map(s => s.trim()).filter(Boolean);
}

// pobierz parametr z URL (np. ?day=03)
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // --- USTAWIENIA ---
  const USER_NAME = "demo";
  const DAY_LABEL = "Dzień " + (typeof window !== "undefined" ? (getParam("day","01")) : "01");
  const MAX_TIME = 6 * 60;           // 6 minut
  const SENTENCE_INTERVAL_MS = 5000; // zmiana zdania co 5 s

  // --- STANY ---
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [sentences, setSentences] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);

  // timery
  const timerRef = useRef<number | null>(null);
  const sentenceRef = useRef<number | null>(null);

  // audio api
  const mediaRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);

  // helper: mm:ss
  const mmss = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2,"0")}`;
  };

  // wczytaj treść dnia
  useEffect(() => {
    const day = typeof window !== "undefined" ? getParam("day","01") : "01";
    fetch(`/days/day${day}.txt`, { cache: "no-store" })
      .then(r => r.ok ? r.text() : "(brak treści dnia)")
      .then(txt => setSentences(splitIntoSentences(txt)))
      .catch(() => setSentences(["(błąd ładowania)"]))
  }, []);

  // oblicz pasek głośności (0–100%)
  const computeLevel = () => {
    const analyser = analyserRef.current;
    const data = dataArrayRef.current;
    if (!analyser || !data) return 0;
    analyser.getByteTimeDomainData(data);
    // prosty peak na podstawie odchylenia od środka 128
    let maxDev = 0;
    for (let i=0;i<data.length;i++) {
      const dev = Math.abs(data[i] - 128);
      if (dev > maxDev) maxDev = dev;
    }
    // skala do ~0–100
    return Math.min(100, Math.round((maxDev / 64) * 100));
  };

  // start sesji
  const start = async () => {
    if (isRunning) return;
    setIsRunning(true);
    setRemaining(MAX_TIME);

    try {
      // MEDIA (kamera + mic)
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true
      });
      mediaRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }

      // AUDIO — analyser
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const bufferLength = analyser.fftSize;
      const dataArray = new Uint8Array(bufferLength);
      src.connect(analyser);
      analyserRef.current = analyser;
      dataArrayRef.current = dataArray;
    } catch (e) {
      console.error("getUserMedia error", e);
    }

    // TIMER odliczania
    if (timerRef.current === null) {
      timerRef.current = window.setInterval(() => {
        setRemaining(prev => {
          const n = Math.max(0, prev - 1);
          if (n === 0) stop();
          return n;
        });
        // update poziomu głośności
        setLevelPct(computeLevel());
      }, 1000);
    }

    // zmiana zdania co X sekund
    if (sentenceRef.current === null && sentences.length > 0) {
      sentenceRef.current = window.setInterval(() => {
        setIdx(i => (i + 1) % sentences.length);
      }, SENTENCE_INTERVAL_MS);
    }
  };

  // stop sesji
  const stop = () => {
    if (!isRunning) return;

    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (sentenceRef.current !== null) {
      window.clearInterval(sentenceRef.current);
      sentenceRef.current = null;
    }

    if (mediaRef.current) {
      mediaRef.current.getTracks().forEach(t => t.stop());
      mediaRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(()=>{});
      audioCtxRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsRunning(false);
    setLevelPct(0);
  };

  // cleanup on unmount
  useEffect(() => {
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // aktualne zdanie
  const current = sentences.length ? sentences[idx] : "(ładowanie…)";

  return (
    <main className="prompter-full">
      {/* TOP */}
      <div className="topbar">
        <div className="group-left">
          <button className="tab active">Prompter</button>
          <button className="tab">Rysownik</button>
          <div className="meta">Użytkownik: <b>{USER_NAME}</b></div>
          <div className="meta">Dzień programu: <b>{DAY_LABEL}</b></div>
        </div>
        <div className="group-right">
          <div className="timer">
            <div className="pill">{mmss(remaining)}</div>
            {!isRunning ? (
              <button onClick={start} className="btn">START</button>
            ) : (
              <button onClick={stop} className="btn">STOP</button>
            )}
          </div>
        </div>
      </div>

      {/* CAMERA */}
      <div className="camera" style={{ transform: mirror ? "scaleX(-1)" : "none" }}>
        <video ref={videoRef} autoPlay muted playsInline />
        <div className="shade" />
      </div>

      {/* METER (pionowy pasek) */}
      <div className="meter-vertical" aria-hidden>
        <div className="fill" style={{ height: `${levelPct}%` }} />
      </div>

      {/* CENTER TEXT */}
      <div className="center-wrap">
        <div className="center-text">{current}</div>
      </div>
    </main>
  );
}







