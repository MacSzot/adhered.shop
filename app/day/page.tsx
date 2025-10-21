"use client";

import { useEffect, useRef, useState } from "react";

// ====== USTAWIENIA ======
const DEFAULT_DAY = "09";        // domyślnie Dzień 09 (zmienisz, jeśli trzeba)
const SESSION_SECONDS = 6 * 60;  // 6:00

// ====== HELPERS ======
function getQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get(name);
  return v && v.trim() ? v.trim() : null;
}
function mmss(s: number) {
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}
async function fetchDayText(day: string): Promise<string> {
  // próba 1: /days/day09.txt
  const a = await fetch(`/days/day${day}.txt`, { cache: "no-store" });
  if (a.ok) return a.text();

  // próba 2: /days/day9.txt (gdy plik był bez zera na przodzie)
  const dayNoZero = String(parseInt(day, 10));
  const b = await fetch(`/days/day${dayNoZero}.txt`, { cache: "no-store" });
  if (b.ok) return b.text();

  // log do konsoli, żebyś na Vercel logach od razu to widział
  console.error(
    `Nie znaleziono pliku dnia: /days/day${day}.txt ani /days/day${dayNoZero}.txt`
  );
  return "(brak treści dnia)";
}

export default function DayPage() {
  // ====== MEDIA ======
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // ====== TIMERS ======
  const clockRef = useRef<number | null>(null);

  // ====== UI STATE ======
  const [running, setRunning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(SESSION_SECONDS);
  const [dayText, setDayText] = useState("(ładowanie…)");
  const [activeTab, setActiveTab] = useState<"prompter" | "rysownik">("prompter");
  const [cameraError, setCameraError] = useState<string | null>(null);

  const dayParam = getQueryParam("day");
  const day = (dayParam || DEFAULT_DAY).padStart(2, "0"); // "09"

  // ====== ŁADOWANIE TEKSTU DNIA ======
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const txt = await fetchDayText(day);
        if (mounted) setDayText(txt);
      } catch {
        if (mounted) setDayText("(błąd ładowania pliku)");
      }
    })();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  // ====== START / STOP ======
  const start = async () => {
    if (running) return;
    setRunning(true);
    setSecondsLeft(SESSION_SECONDS);
    setCameraError(null);

    // 1) getUserMedia — wymaga kliknięcia (iOS)
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true
      });
      streamRef.current = s;

      if (videoRef.current) {
        videoRef.current.srcObject = s;
        // iOS Safari: playsInline + muted + play() po geście
        await videoRef.current.play().catch(() => {});
      }

      // 2) AudioContext (przygotowane pod późniejszy VU-meter/Whisper)
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext ||
          (window as any).webkitAudioContext)();
      }
    } catch (e: any) {
      console.error("getUserMedia error:", e);
      setCameraError(
        "Brak zgody na kamerę/mikrofon lub błąd urządzenia. Włącz dostęp w ustawieniach przeglądarki i spróbuj ponownie."
      );
    }

    // 3) zegar sesji
    if (clockRef.current === null) {
      clockRef.current = window.setInterval(() => {
        setSecondsLeft((prev) => {
          const next = Math.max(0, prev - 1);
          if (next === 0) {
            stop();
          }
          return next;
        });
      }, 1000);
    }
  };

  const stop = () => {
    if (!running) return;

    // Timery
    if (clockRef.current !== null) {
      window.clearInterval(clockRef.current);
      clockRef.current = null;
    }

    // Media
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    // Audio
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    setRunning(false);
  };

  // cleanup on unmount
  useEffect(() => {
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="min-h-screen w-screen bg-black text-white overflow-hidden">
      {/* TOP PANEL — STABILNY */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-black/85 backdrop-blur border-b border-white/10 safe-top">
        <div className="flex items-center gap-2 px-4 py-2 text-sm">
          <div className="inline-flex rounded-full bg-white/10 p-1">
            <button
              className={`px-3 py-1 rounded-full ${activeTab === "prompter" ? "bg-white text-black" : "text-white"}`}
              onClick={() => setActiveTab("prompter")}
            >
              Prompter
            </button>
            <button
              className={`px-3 py-1 rounded-full ${activeTab === "rysownik" ? "bg-white text-black" : "text-white"}`}
              onClick={() => setActiveTab("rysownik")}
            >
              Rysownik
            </button>
          </div>

          <div className="mx-3 opacity-70">Użytkownik: <span className="opacity-100">demo</span></div>
          <div className="opacity-70">Dzień programu: <span className="opacity-100">Dzień {day}</span></div>

          <div className="ml-auto inline-flex items-center gap-2 rounded-full bg-white/10 p-1">
            <div className="px-3 py-1 rounded-full bg-white text-black font-semibold tabular-nums">
              {mmss(secondsLeft)}
            </div>
            {!running ? (
              <button onClick={start} className="px-3 py-1 rounded-full bg-green-500 text-black font-medium">
                START
              </button>
            ) : (
              <button onClick={stop} className="px-3 py-1 rounded-full bg-red-500 text-black font-medium">
                STOP
              </button>
            )}
          </div>
        </div>
      </div>

      {/* LAYER: CAMERA */}
      <div className="relative w-full" style={{ height: "45vh", marginTop: "64px" }}>
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-cover"
          playsInline
          muted
          autoPlay
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/20 to-black/60 pointer-events-none" />
      </div>

      {/* CENTERED TEXT — mała czcionka, środek ekranu */}
      <section className="relative flex items-center justify-center px-4"
        style={{ minHeight: "calc(100vh - 45vh - 64px)" }}>
        <div className="max-w-2xl w-full text-center">
          {activeTab === "prompter" ? (
            <div className="whitespace-pre-wrap leading-7 text-[14px] sm:text-[15px] opacity-95">
              {dayText}
            </div>
          ) : (
            <div className="text-[14px] sm:text-[15px] opacity-70">
              (Rysownik – wkrótce)
            </div>
          )}
          {cameraError && (
            <div className="mt-4 text-xs text-red-400 opacity-90">{cameraError}</div>
          )}
        </div>
      </section>
    </main>
  );
}








