"use client";

import React, { useEffect, useRef, useState } from "react";

// ---------- USTAWIENIA ----------
const USER_NAME = "demo";
// 6 minut sesji; interwał zmiany zdania 5s
const MAX_TIME = 6 * 60;
const SENTENCE_INTERVAL_MS = 5000;

// ---------- POMOCNICZE ----------
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

async function loadDayText(day: string) {
  try {
    const res = await fetch(`/days/${day}.txt`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    console.error("loadDayText error", err);
    return "";
  }
}

// ---------- KOMPONENT ----------
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const dayParam = typeof window !== "undefined" ? getParam("day", "01") : "01";
  const DAY_LABEL = "Dzień " + dayParam;

  // STANY
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [sentences, setSentences] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);

  // TIMERY (number w przeglądarce)
  const timerRef = useRef<number | null>(null);
  const sentenceRef = useRef<number | null>(null);

  // AUDIO/MEDIA
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  // 1) Wczytaj treść dnia
  useEffect(() => {
    const day = getParam("day", "01");
    loadDayText(day)
      .then(text => setSentences(splitIntoSentences(text)))
      .catch(() => setSentences([]));
  }, []);

  // 2) Kamera + VU-meter (start/stop sesji)
  useEffect(() => {
    if (!isRunning) return;

    let analyser: AnalyserNode | null = null;

    const startMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;

        const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
        audioCtxRef.current = new Ctx();
        analyser = audioCtxRef.current.createAnalyser();
        analyser.fftSize = 1024;
        audioCtxRef.current.createMediaStreamSource(stream).connect(analyser);

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
          rafRef.current = window.requestAnimationFrame(tick);
        };
        rafRef.current = window.requestAnimationFrame(tick);
      } catch (e) {
        console.error("getUserMedia/Audio error", e);
      }
    };

    startMedia();

    return () => {
      // RAF
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // MEDIA
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      // AUDIO
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
  }, [isRunning]);

  // 3) Start/Stop
  const clearAll = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (sentenceRef.current !== null) {
      window.clearInterval(sentenceRef.current);
      sentenceRef.current = null;
    }
  };

  const startSession = () => {
    if (!sentences.length) return;
    setIsRunning(true);
    setRemaining(MAX_TIME);
    setIdx(0);

    timerRef.current = window.setInterval(() => {
      setRemaining(prev => {
        const next = prev - 1;
        if (next <= 0) {
          stopSession();
          return 0;
        }
        return next;
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

  // cleanup przy unmount
  useEffect(() => {
    return () => {
      clearAll();
      // extra: zamknięcie mediów/audio, gdyby komponent był wyłączony w trakcie RUN
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(1, "0")}:${String(s % 60).padStart(2, "0")}`;

  const current = sentences[idx] ?? "";
  const next = sentences[(idx + 1) % Math.max(1, sentences.length)] ?? "";

  return (
    <main className="prompter-full">
      {/* TOPBAR z timerem */}
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

        <div className="timer-badge">{fmt(remaining)}</div>

        <div className="controls-top">
          <button className="btn" onClick={startSession} disabled={isRunning || !sentences.length}>
            START
          </button>
          <button className="btn btn--ghost" onClick={stopSession} disabled={!isRunning}>
            STOP
          </button>
        </div>
      </header>

      <div className="workspace">
        {/* WIDEO (mirror) */}
        <div className="video-wrap">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={mirror ? "mirror" : ""}
          />
        </div>

        {/* TEKST DNIA */}
        <section className="reading-panel" id="reader">
          <div className="current">{current || "(brak treści dnia)"}</div>
          <div className="next">{next}</div>
        </section>

        {/* VU-meter */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}





