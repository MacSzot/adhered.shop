"use client";

import React, { useEffect, useRef, useState } from "react";

// Jeśli chcesz na start wyłączyć dostęp do kamery/mikrofonu, zmień na false:
const ENABLE_MEDIA = true;

// Jeżeli masz pliki w /public/days, ustaw np. "day3" lub podłącz to pod router/query:
const DEFAULT_DAY = "day1";

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

export default function DayPage() {
  // --- TIMERS & RAF (w przeglądarce zwracają number) ---
  const scrollIntervalRef = useRef<number | null>(null);
  const clockIntervalRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // --- MEDIA ---
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // --- UI STATE ---
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0); // sekundy
  const [dayText, setDayText] = useState<string>("(ładowanie…)");

  // Ładowanie treści dnia po wejściu
  useEffect(() => {
    let mounted = true;
    (async () => {
      const text = await loadDayText(DEFAULT_DAY);
      if (mounted) setDayText(text || "(brak treści dnia)");
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const startSession = async () => {
    if (typeof window === "undefined") return;
    if (running) return;

    setRunning(true);
    setElapsed(0);

    // MEDIA (opcjonalne)
    if (ENABLE_MEDIA) {
      try {
        mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: true
        });
      } catch (e) {
        console.error("getUserMedia error", e);
      }

      if (!audioCtxRef.current) {
        try {
          audioCtxRef.current = new (window.AudioContext ||
            (window as any).webkitAudioContext)();
        } catch (e) {
          console.error("AudioContext error", e);
        }
      }
    }

    // INTERWAŁY — konsekwentnie przez window.setInterval (typ: number)
    // 1) Scroll/auto-advance (przykład, możesz zamienić na swoją logikę)
    if (scrollIntervalRef.current === null) {
      scrollIntervalRef.current = window.setInterval(() => {
        // …Twoja logika przewijania/promptera…
        // przykład: document.getElementById("reader")?.scrollBy({ top: 1 });
      }, 50);
    }

    // 2) Zegar/odliczanie
    if (clockIntervalRef.current === null) {
      clockIntervalRef.current = window.setInterval(() => {
        setElapsed((s) => s + 1);
      }, 1000);
    }

    // 3) RAF (np. VU-meter/animacje)
    const loop = () => {
      // …opcjonalny pomiar audio/animacje…
      rafRef.current = window.requestAnimationFrame(loop);
    };
    if (rafRef.current === null) {
      rafRef.current = window.requestAnimationFrame(loop);
    }
  };

  const clearAll = () => {
    // Interwały
    if (scrollIntervalRef.current !== null) {
      window.clearInterval(scrollIntervalRef.current);
      scrollIntervalRef.current = null;
    }
    if (clockIntervalRef.current !== null) {
      window.clearInterval(clockIntervalRef.current);
      clockIntervalRef.current = null;
    }
    // RAF
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // Media
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    // Audio
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  };

  const stopSession = () => {
    if (!running) return;
    clearAll();
    setRunning(false);
  };

  // Cleanup przy unmount
  useEffect(() => {
    return () => {
      clearAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="p-6 max-w-3xl mx-auto">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Day Hub — {DEFAULT_DAY}</h1>
        <div className="text-sm opacity-70">
          {running ? "Session: RUNNING" : "Session: IDLE"}
        </div>
      </header>

      <section className="mb-4 flex gap-3">
        <button
          onClick={startSession}
          className="px-4 py-2 rounded bg-black text-white disabled:opacity-50"
          disabled={running}
        >
          START
        </button>
        <button
          onClick={stopSession}
          className="px-4 py-2 rounded border disabled:opacity-50"
          disabled={!running}
        >
          STOP
        </button>
        <div className="ml-auto text-sm">
          Czas: <span className="tabular-nums">{elapsed}s</span>
        </div>
      </section>

      <section className="rounded-2xl border p-4">
        <h2 className="mb-2 font-medium">Tekst dnia</h2>
        <div
          id="reader"
          className="prose whitespace-pre-wrap leading-relaxed max-h-[50vh] overflow-auto"
        >
          {dayText}
        </div>
      </section>

      {ENABLE_MEDIA && (
        <section className="mt-6 text-sm opacity-70">
          Kamera/mikrofon aktywowane podczas sesji (przez getUserMedia).
        </section>
      )}
    </main>
  );
}




