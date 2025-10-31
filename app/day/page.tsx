"use client";
import React, { useState, useRef, useEffect } from "react";

export default function Page() {
  // ────────────────────────────────────────────────
  //  STANY I REFERENCJE
  // ────────────────────────────────────────────────
  const [isRunning, setIsRunning] = useState(false);
  const [displayText, setDisplayText] = useState("");
  const [sayTranscript, setSayTranscript] = useState("");
  const [timeLeft, setTimeLeft] = useState(360); // 6 minut
  const [hintStage, setHintStage] = useState(0);
  const hintDisabledRef = useRef(false);
  const idxRef = useRef(0);
  const timerRef = useRef<number>();
  const silenceTimerRef = useRef<number>();
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Float32Array | null>(null);

  // ────────────────────────────────────────────────
  //  TEKSTY
  // ────────────────────────────────────────────────
  const VERIFY_LINES = [
    "Jestem w bardzo dobrym miejscu.",
    "Szacunek do siebie staje się naturalny.",
    "Popatrz na siebie i podziękuj sobie. Zrób to ze spokojem — twoje słowa wyświetlą się na ekranie.",
    "Popatrz na siebie i przyznaj sobie rację. Zrób to z przekonaniem — twoje słowa wyświetlą się na ekranie.",
    "Popatrz na siebie i pogratuluj sobie. Zrób to z radością — twoje słowa wyświetlą się na ekranie.",
  ];

  const HINTS = {
    1: "Jeśli możesz, postaraj się przeczytać na głos.",
    2: "Pamiętaj — to przestrzeń pełna szacunku do Ciebie.",
    3: "Jeśli chcesz kontynuować, dotknij ekranu.",
  } as const;

  // ────────────────────────────────────────────────
  //  URUCHOMIENIE SESJI
  // ────────────────────────────────────────────────
  async function startSession() {
    setIsRunning(true);
    idxRef.current = 0;
    setTimeLeft(360);
    setDisplayText(VERIFY_LINES[0]);
    hintDisabledRef.current = false;
    startMic();
    startTimer();
    nextStep(0);
  }

  // ────────────────────────────────────────────────
  //  OBSŁUGA MIKROFONU / WYKRYWANIE DŹWIĘKU
  // ────────────────────────────────────────────────
  async function startMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const buffer = new Float32Array(analyser.fftSize);
      src.connect(analyser);
      audioCtxRef.current = ctx;
      micRef.current = src;
      analyserRef.current = analyser;
      dataRef.current = buffer;
      loopListen();
    } catch (e) {
      console.warn("Brak dostępu do mikrofonu", e);
    }
  }

  function loopListen() {
    const analyser = analyserRef.current;
    const data = dataRef.current;
    if (!analyser || !data) return;
    analyser.getFloatTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
    const speakingNow = rms > 0.012;
    if (speakingNow) {
      if (hintStage !== 0) setHintStage(0);
    }
    requestAnimationFrame(loopListen);
  }

  // ────────────────────────────────────────────────
  //  TIMER SESJI
  // ────────────────────────────────────────────────
  function startTimer() {
    clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setTimeLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
  }

  useEffect(() => {
    if (timeLeft === 0) stopSession();
  }, [timeLeft]);

  // ────────────────────────────────────────────────
  //  KOLEJNE KROKI
  // ────────────────────────────────────────────────
  function nextStep(i: number) {
    if (i >= VERIFY_LINES.length - 1) {
      stopSession();
      return;
    }
    setTimeout(() => {
      const n = i + 1;
      idxRef.current = n;
      setDisplayText(VERIFY_LINES[n]);
      scheduleSilence(n);
    }, 9000);
  }

  // ────────────────────────────────────────────────
  //  PRZYPOMINAJKI
  // ────────────────────────────────────────────────
  function scheduleSilence(i: number) {
    clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = window.setTimeout(() => {
      if (idxRef.current !== i || hintDisabledRef.current) return;
      setHintStage(1);
      setTimeout(() => {
        if (!hintDisabledRef.current) setHintStage(2);
      }, 5000);
      setTimeout(() => {
        if (!hintDisabledRef.current) {
          setHintStage(3);
          const onceTap = () => {
            document.removeEventListener("click", onceTap);
            hintDisabledRef.current = true;
            setHintStage(0);
            nextStep(i);
          };
          document.addEventListener("click", onceTap, { once: true });
        }
      }, 10000);
    }, 8000);
  }

  // ────────────────────────────────────────────────
  //  ZAKOŃCZENIE
  // ────────────────────────────────────────────────
  function stopSession() {
    setIsRunning(false);
    setDisplayText("");
    setHintStage(0);
    clearInterval(timerRef.current);
  }

  // ────────────────────────────────────────────────
  //  STYLIZACJE
  // ────────────────────────────────────────────────
  const centerWrap: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    padding: "0 24px",
    pointerEvents: "none",
  };

  const mainLineStyle: React.CSSProperties = {
    maxWidth: 820,
    fontSize: 26,
    lineHeight: 1.45,
    textShadow: "0 2px 4px rgba(0,0,0,.5)",
  };

  const transcriptTopStyle: React.CSSProperties = {
    position: "absolute",
    top: "10vh",
    left: 0,
    right: 0,
    margin: "0 auto",
    maxWidth: 820,
    fontSize: 22,
    lineHeight: 1.4,
    padding: "0 24px",
    textAlign: "center",
    textShadow: "0 2px 4px rgba(0,0,0,.45)",
  };

  // ────────────────────────────────────────────────
  //  RENDER
  // ────────────────────────────────────────────────
  return (
    <main className="prompter-full" style={{ background: "black", color: "white", minHeight: "100vh" }}>
      <header className="topbar topbar--dense" style={{ padding: "12px 16px", background: "rgba(0,0,0,.4)" }}>
        <nav className="tabs">
          <a className="tab active" href="/day" aria-current="page">
            Prompter
          </a>
        </nav>
        <div className="top-info compact" style={{ display: "flex", justifyContent: "space-between" }}>
          <span className="meta">
            <b>Użytkownik:</b> demo
          </span>
          <span className="meta">
            <b>Dzień programu:</b> 3
          </span>
          <button
            onClick={startSession}
            style={{
              background: "rgba(255,255,255,0.1)",
              color: "white",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 6,
              padding: "4px 12px",
              marginLeft: 12,
            }}
          >
            {isRunning ? "Stop" : "Start"}
          </button>
        </div>
      </header>

      {/* ───────────── INTRO ───────────── */}
      {!isRunning && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            backgroundColor: "black",
            color: "white",
            lineHeight: 1.6,
            padding: "0 24px",
          }}
        >
          <div style={{ maxWidth: 600 }}>
            <p style={{ fontSize: 18, marginBottom: 20 }}>
              Twoja sesja potrwa około <b>6 minut.</b>
              <br />
              Prosimy o powtarzanie na głos wyświetlanych treści.
            </p>
            <p style={{ fontSize: 16, opacity: 0.9, marginTop: 20 }}>
              Aktywowano analizator głosu <b>MeRoar™</b>
            </p>
          </div>
        </div>
      )}

      {/* ───────────── SESJA ───────────── */}
      {isRunning && (
        <>
          <div style={{ textAlign: "center", fontSize: 36, fontWeight: 700, marginTop: 12 }}>
            {`${Math.floor(timeLeft / 60)}:${(timeLeft % 60).toString().padStart(2, "0")}`}
          </div>

          <div style={centerWrap}>
            <div style={mainLineStyle}>{displayText}</div>
          </div>

          {sayTranscript && <div style={transcriptTopStyle}>{sayTranscript}</div>}

          {hintStage > 0 && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: "68vh",
                padding: "0 24px",
                textAlign: "center",
                fontSize: 16,
                lineHeight: 1.35,
                color: "rgba(255,255,255,.95)",
                textShadow: "0 1px 2px rgba(0,0,0,.6)",
              }}
            >
              {HINTS[hintStage as keyof typeof HINTS]}
            </div>
          )}
        </>
      )}
    </main>
  );
}


