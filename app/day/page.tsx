"use client";

import { useEffect, useRef, useState } from "react";

// dzielenie tekstu: po liniach lub po .?!
function splitIntoSentences(input: string): string[] {
  const raw = input.replace(/\r/g, " ").replace(/\n+/g, "\n").trim();
  const lines = raw.split("\n").map(s => s.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  return raw.split(/(?<=[\.\?\!])\s+/g).map(s => s.trim()).filter(Boolean);
}

function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // --- USTAWIENIA ---
  const USER_NAME = "demo";
  const dayParam = typeof window !== "undefined" ? getParam("day", "01") : "01";
  const DAY_LABEL = "Dzień " + dayParam;
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

  // 1) Wczytaj treść dnia
  useEffect(() => {
    const day = getParam("day", "01");
    fetch(`/days/${day}.txt`)
      .then(r => {
        if (!r.ok) throw new Error("Brak pliku dnia");
        return r.text();
      })
      .then(t => {
        const segs = splitIntoSentences(t);
        setSentences(segs.length ? segs : ["Brak treści."]);
        setIdx(0);
      })
      .catch(() => setSentences(["Brak treści dla tego dnia."]));
  }, []);

  // 2) VU-meter (tylko wizualizacja)
  useEffect(() => {
    if (!isRunning) return;

    let raf: number | null = null;
    let analyser: AnalyserNode | null = null;
    let audioCtx: AudioContext | null = null;
    let streamRef: MediaStream | null = null;

    const start = async () => {
      try {
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
      } catch (e) {
        console.error(e);
        alert("Zezwól na dostęp do kamery i mikrofonu.");
      }
    };

    start();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      streamRef?.getTracks().forEach(t => t.stop());
      audioCtx?.close().catch(() => {});
    };
  }, [isRunning]);

  // 3) Start/Stop
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
      {/* TOPBAR z timerem wewnątrz belki */}
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

        {/* TIMER — część belki */}
        <div className="timer-badge">{fmt(remaining)}</div>

        <div className="controls-top">
          {!isRunning ? (
            <button className="btn" onClick={startSession}>Start</button>
          ) : (
            <button className="btn" onClick={stopSession}>Stop</button>
          )}
        </div>
      </header>

      {/* KAMERA + overlay */}
      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* Intro */}
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

        {/* Tekst */}
        {isRunning && (
          <div className="overlay center">
            <div key={idx} className="center-text fade">
              {sentences[idx] || ""}
            </div>
          </div>
        )}

        {/* VU-meter */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}




