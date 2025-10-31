"use client";

import React, { useEffect, useRef, useState } from "react";

/** ===== KONFIG ===== */
const MAX_TIME_SEC = 6 * 60;              // 6 minut sesji
const SILENCE_TRIGGER_MS = 10_000;        // przypominajka po 10 s ciszy
const VAD = {                             // progi detekcji głosu
  RMS: 0.017,
  PEAK: 0.040,
  VU: 7,
};

/** ===== POMOCNICZE ===== */
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

/** ===== STRONA ===== */
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // UI
  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "1") : "1";
  const DAY_LABEL = String(parseInt(dayRaw, 10) || 1);

  // Stany główne
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME_SEC);
  const [displayText, setDisplayText] = useState<string>(
    "Twoja sesja potrwa około 6 minut.\n\nProsimy o powtarzanie na głos wyświetlanych treści.\n\nAktywowano analizator dźwięku MeRoar™."
  );

  // VU / AV
  const [levelPct, setLevelPct] = useState(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  // Licznik
  const endAtRef = useRef<number | null>(null);
  const timerIdRef = useRef<number | null>(null);

  // Pauza po ciszy
  const [silencePause, setSilencePause] = useState(false);
  const [pauseMessage, setPauseMessage] = useState(
    "Jeśli nie czujesz, że to dobry moment, zawsze możesz wrócić później.\n\nJeśli chcesz kontynuować, dotknij ekranu."
  );
  const lastVoiceAtRef = useRef<number>(Date.now());

  // ======= START / STOP =======
  async function startSession() {
    setSilencePause(false);
    setRemaining(MAX_TIME_SEC);
    setIsRunning(true);
    await startAV();
    startCountdown(MAX_TIME_SEC);
    // pierwszy tekst dnia możesz wczytywać z pliku – tu minimalny placeholder
    setDisplayText("Jestem w bardzo dobrym miejscu.");
  }

  function stopSession() {
    setIsRunning(false);
    stopCountdown();
    stopAV();
    setLevelPct(0);
    setSilencePause(false);
    setDisplayText(
      "Twoja sesja potrwa około 6 minut.\n\nProsimy o powtarzanie na głos wyświetlanych treści.\n\nAktywowano analizator dźwięku MeRoar™."
    );
  }

  // ======= COUNTDOWN =======
  function startCountdown(seconds: number) {
    stopCountdown();
    endAtRef.current = Date.now() + seconds * 1000;
    setRemaining(seconds);
    timerIdRef.current = window.setInterval(() => {
      if (!endAtRef.current) return;
      const secs = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0) stopSession();
    }, 250);
  }

  function stopCountdown() {
    if (timerIdRef.current) {
      clearInterval(timerIdRef.current);
      timerIdRef.current = null;
    }
    endAtRef.current = null;
  }

  // ======= AUDIO / VAD =======
  async function startAV() {
    stopAV();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    streamRef.current = stream;
    if (videoRef.current) (videoRef.current as any).srcObject = stream;

    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ac = new Ctx();
    audioCtxRef.current = ac;
    if (ac.state === "suspended") {
      try { await ac.resume(); } catch {}
      document.addEventListener("click", () => ac.resume().catch(() => {}), { once: true });
    }

    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.86;
    ac.createMediaStreamSource(stream).connect(analyser);
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.fftSize);
    const loop = () => {
      if (!analyserRef.current) return;

      analyser.getByteTimeDomainData(data);
      let peak = 0, sumSq = 0;
      for (let i = 0; i < data.length; i++) {
        const x = (data[i] - 128) / 128;
        const a = Math.abs(x);
        if (a > peak) peak = a;
        sumSq += x * x;
      }
      const rms = Math.sqrt(sumSq / data.length);
      const vu = Math.min(100, peak * 480);
      setLevelPct(prev => Math.max(vu, prev * 0.85));

      const speakingNow = rms > VAD.RMS || peak > VAD.PEAK || vu > VAD.VU;
      const now = Date.now();
      if (speakingNow) {
        lastVoiceAtRef.current = now;
        // jeśli była pauza z powodu ciszy, nic nie rób – czekamy na tap
      } else if (isRunning && !silencePause) {
        // brak głosu — sprawdzamy 10 s
        if (now - lastVoiceAtRef.current >= SILENCE_TRIGGER_MS) {
          // 1) zatrzymaj licznik
          const secsLeft = Math.max(0, Math.ceil((endAtRef.current! - now) / 1000));
          stopCountdown();
          setRemaining(secsLeft);
          // 2) pokaż JEDEN komunikat i przejdź w tryb pauzy
          setSilencePause(true);
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }

  function stopAV() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
  }

  // ======= WZNOWIENIE PO TAPIE =======
  function resumeAfterSilence() {
    if (!silencePause) return;
    // restart timera od miejsca, w którym przerwaliśmy
    startCountdown(remaining);
    lastVoiceAtRef.current = Date.now(); // wyzeruj licznik ciszy
    setSilencePause(false);
  }

  // ======= FORMATY =======
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  /** ====== STYLES (kompaktowe, jeden plik) ====== */
  const centerWrap: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    textAlign: "center",
    padding: "0 24px",
  };
  const introStyle: React.CSSProperties = {
    maxWidth: 520,
    whiteSpace: "pre-wrap",
    lineHeight: 1.5,
    fontSize: 18,
    color: "white",
    textShadow: "0 1px 2px rgba(0,0,0,.6)",
  };
  const mainTextStyle: React.CSSProperties = {
    maxWidth: 720,
    whiteSpace: "pre-wrap",
    lineHeight: 1.5,
    fontSize: 24,
    color: "white",
    textShadow: "0 1px 2px rgba(0,0,0,.6)",
  };
  const pauseStyle: React.CSSProperties = {
    ...centerWrap,
    background: "rgba(0,0,0,0.55)",
    cursor: "pointer",
  };

  return (
    <main className="prompter-full">
      {/* Górny pasek */}
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
        <div className="controls-top">
          {!isRunning ? (
            <button className="btn" onClick={startSession}>Start</button>
          ) : (
            <button className="btn" onClick={stopSession}>Stop</button>
          )}
        </div>
      </header>

      {/* Zegar u góry */}
      <div className="timer-top timer-top--strong">{fmt(remaining)}</div>

      {/* Scena z kamerą */}
      <div className="stage mirrored">
        <video ref={videoRef} className="cam" autoPlay playsInline muted />

        {/* Intro (przed startem) */}
        {!isRunning && (
          <div style={centerWrap}>
            <div style={introStyle}>{displayText}</div>
          </div>
        )}

        {/* Sesja */}
        {isRunning && (
          <div style={centerWrap}>
            <div style={mainTextStyle}>{displayText}</div>
          </div>
        )}

        {/* Pauza po 10 s ciszy (JEDEN komunikat). Klik = wznowienie. */}
        {isRunning && silencePause && (
          <div style={pauseStyle} onClick={resumeAfterSilence}>
            <div style={{ ...introStyle, maxWidth: 560 }}>{pauseMessage}</div>
          </div>
        )}

        {/* VU po prawej (delikatny) */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>

      {/* Minimalne style globalne wymagane do układu (możesz mieć już w CSS) */}
      <style jsx global>{`
        .prompter-full { position: fixed; inset: 0; background: #000; color: #fff; }
        .topbar { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:rgba(0,0,0,.35); }
        .tabs { display:flex; gap:8px; }
        .tab { padding:6px 12px; border-radius:999px; background:#222; color:#ddd; text-decoration:none; }
        .tab.active { background:#111; color:#fff; }
        .tab.disabled { opacity:.4; }
        .top-info { display:flex; align-items:center; gap:8px; color:#ddd; }
        .top-info .meta b { color:#fff; }
        .controls-top .btn { background:#2e2e2e; color:#fff; border:1px solid #444; padding:6px 14px; border-radius:10px; }
        .timer-top { position: fixed; top: 64px; left: 0; right: 0; text-align: center; font-weight: 800; font-size: 44px; text-shadow: 0 2px 3px rgba(0,0,0,.6); }
        .stage { position: absolute; inset: 0; top: 110px; }
        .stage.mirrored .cam { transform: scaleX(-1); }
        .cam { position:absolute; inset:0; width:100%; height:100%; object-fit: cover; }
        .meter-vertical { position:absolute; right:10px; top:120px; bottom:16px; width:6px; border-radius:6px; background:rgba(255,255,255,.12); overflow:hidden; }
        .meter-vertical-fill { position:absolute; left:0; right:0; bottom:0; background:linear-gradient(#79ffa1,#00d084); }
      `}</style>
    </main>
  );
}
  );
}
