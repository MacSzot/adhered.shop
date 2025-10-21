"use client";

import React, { useEffect, useRef, useState } from "react";

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [mediaActive, setMediaActive] = useState(false);
  const [dayText, setDayText] = useState<string>("(ładowanie…)");

  // 🔹 wczytaj tekst dnia
  useEffect(() => {
    fetch("/days/day9.txt", { cache: "no-store" })
      .then((res) => (res.ok ? res.text() : "(brak treści dnia)"))
      .then((txt) => setDayText(txt))
      .catch(() => setDayText("(błąd ładowania pliku)"));
  }, []);

  // 🔹 uruchom kamerę i mikrofon
  const startMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setMediaActive(true);
    } catch (err) {
      console.error("Błąd getUserMedia:", err);
      alert("Nie udało się uruchomić kamery/mikrofonu");
    }
  };

  // 🔹 zatrzymaj kamerę i mikrofon
  const stopMedia = () => {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setMediaActive(false);
  };

  // 🔹 cleanup po opuszczeniu strony
  useEffect(() => {
    return () => stopMedia();
  }, []);

  return (
    <main className="relative w-screen h-screen bg-black text-white overflow-hidden">
      {/* 🔹 PANEL GÓRNY */}
      <div className="absolute top-0 left-0 w-full flex justify-between items-center px-4 py-2 bg-black/80 text-sm z-20">
        <div className="flex gap-2">
          <button
            onClick={startMedia}
            disabled={mediaActive}
            className="px-3 py-1 bg-white text-black rounded disabled:opacity-40"
          >
            Start
          </button>
          <button
            onClick={stopMedia}
            disabled={!mediaActive}
            className="px-3 py-1 border border-white rounded disabled:opacity-40"
          >
            Stop
          </button>
        </div>
        <div className="text-right">
          <div>Użytkownik: demo</div>
          <div>Dzień programu: Dzień 09</div>
        </div>
      </div>

      {/* 🔹 WIDEO Z KAMERY */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover opacity-30"
      />

      {/* 🔹 TEKST NA ŚRODKU */}
      <div className="absolute inset-0 flex items-center justify-center text-center px-6">
        <div className="text-base leading-relaxed whitespace-pre-line max-w-[90%]">
          {dayText}
        </div>
      </div>
    </main>
  );
}






