"use client";
import { useEffect, useRef, useState } from "react";

export default function PrompterPage() {
  /* ================== USTAWIENIA ================== */
  const USER_NAME = "demo";
  const DAY_LABEL = "3";
  const MAX_TIME = 6 * 60;

  /* ================== REFY / STANY ================== */
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);

  const [displayText, setDisplayText] = useState("Jestem w bardzo dobrym miejscu.");
  const [sayTranscript, setSayTranscript] = useState("");

  // przypominajki: 0=off, 1/2/3 = konkretna treść
  const [hintStage, setHintStage] = useState<0 | 1 | 2 | 3>(0);

  // mic test + vu
  const [micErr, setMicErr] = useState<string | null>(null);
  const [micActive, setMicActive] = useState(false);
  const [levelPct, setLevelPct] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  /* ================== FORMATY ================== */
  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  /* ================== PRZYPOMINAJKI ================== */
  useEffect(() => {
    if (!isRunning) return;
    const timers: number[] = [];
    timers.push(window.setTimeout(() => setHintStage(1), 7000));
    timers.push(window.setTimeout(() => setHintStage(2), 14000));
    timers.push(window.setTimeout(() => setHintStage(3), 21000));
    return () => timers.forEach(clearTimeout);
  }, [isRunning]);

  const HINTS = {
    1: "Jeśli możesz, postaraj się przeczytać na głos.",
    2: "Pamiętaj — to przestrzeń pełna szacunku do Ciebie.",
    3: "Jeśli chcesz kontynuować, dotknij ekranu.",
  } as const;

  // po 3. przypominajce czekamy na pojedyncze dotknięcie i wygaszamy przypominajki
  useEffect(() => {
    if (hintStage !== 3) return;
    const handle = () => setHintStage(0);
    document.addEventListener("click", handle, { once: true });
    return () => document.removeEventListener("click", handle);
  }, [hintStage]);

  /* ================== TIMER SESJI ================== */
  useEffect(() => {
    if (!isRunning) return;
    const endAt = Date.now() + remaining * 1000;
    const id = window.setInterval(() => {
      const secs = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0) {
        setIsRunning(false);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [isRunning]);

  /* ================== TEST MIKROFONU / VU ================== */
  async function startMicTest() {
    stopMicTest();
    setMicErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
      streamRef.current = stream;

      const Ctx =
        (window.AudioContext ||
          (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new Ctx();
      audioCtxRef.current = ac;

      if (ac.state === "suspended") {
        await ac.resume().catch(() => {});
        const resumeOnClick = () => ac.resume().catch(() => {});
        document.addEventListener("click", resumeOnClick, { once: true });
      }

      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.86;
      ac.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.fftSize);
      const loop = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(data);

        let peak = 0,
          sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const x = (data[i] - 128) / 128;
          const a = Math.abs(x);
          if (a > peak) peak = a;
          sumSq += x * x;
        }
        const rms = Math.sqrt(sumSq / data.length);
        // wyliczamy syntetyczny VU
        const vu = Math.min(100, Math.max(0, Math.max(peak * 480, rms * 900)));
        setLevelPct((prev) => Math.max(vu, prev * 0.85));

        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      setMicActive(true);
    } catch (e: any) {
      setMicErr(
        e?.name === "NotAllowedError"
          ? "Brak zgody na mikrofon."
          : "Nie udało się uruchomić mikrofonu."
      );
      setMicActive(false);
    }
  }

  function stopMicTest() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {}
    }
    audioCtxRef.current = null;
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setMicActive(false);
    setLevelPct(0);
  }

  /* ================== START / STOP SESJI ================== */
  const handleStart = () => {
    // zegar od nowa
    setRemaining(MAX_TIME);
    setIsRunning(true);
  };
  const handleStop = () => {
    setIsRunning(false);
  };

  /* ================== STYLES (inline – kluczowe elementy) ================== */
  const topInfoStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    fontSize: 15,
  };

  const introTextStyle: React.CSSProperties = {
    maxWidth: 360,
    fontSize: 17,
    lineHeight: 1.55,
    color: "#fff",
    textAlign: "center",
    textShadow: "0 2px 7px rgba(0,0,0,0.7)",
    marginBottom: 80,
    padding: "0 15px",
  };

  const centerBoxStyle: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    textAlign: "center",
    width: "min(90vw, 700px)",
    color: "white",
  };

  const hintStyle: React.CSSProperties = {
    position: "absolute",
    top: "70%",
    left: "50%",
    transform: "translateX(-50%)",
    width: "min(90vw, 700px)",
    textAlign: "center",
    fontSize: 15,
    color: "rgba(255,255,255,0.96)",
    textShadow: "0 1px 2px rgba(0,0,0,0.5)",
    lineHeight: 1.4,
    padding: "0 16px",
    transition: "opacity 200ms ease",
  };

  /* ================== RENDER ================== */
  return (
    <main className="prompter-full">
      {/* GÓRNY PASEK */}
      <header
        className="topbar topbar--dense"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        <nav className="tabs">
          <a className="tab active" href="/day" aria-current="page">
            Prompter
          </a>
          <span className="tab disabled" aria-disabled="true">
            Rysownik
          </span>
        </nav>

        {/* W JEDNEJ LINII */}
        <div className="top-info compact" style={topInfoStyle}>
          <span className="meta">
            <b>Użytkownik:</b> {USER_NAME}
          </span>
          <span className="meta">
            <b>Dzień programu:</b> {DAY_LABEL}
          </span>
        </div>

        <div className="controls-top">
          {!isRunning ? (
            <button className="btn" onClick={handleStart}>
              Start
            </button>
          ) : (
            <button className="btn" onClick={handleStop}>
              Stop
            </button>
          )}
        </div>
      </header>

      {/* ZEGAR NA GÓRZE */}
      <div className="timer-top timer-top--strong">{fmt(remaining)}</div>

      {/* GŁÓWNA SCENA */}
      <div className="stage mirrored" style={{ position: "relative" }}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* INTRO */}
        {!isRunning && (
          <div
            className="overlay center"
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              alignItems: "center",
              minHeight: "100vh",
            }}
          >
            <div style={introTextStyle}>
              Twoja sesja potrwa około <b>6 minut</b>.
              <br />
              Postaraj się <b>wyraźnie powtarzać</b> wyświetlane treści.
            </div>

            {/* Panel testu mikrofonu */}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {!micActive ? (
                <button className="btn" onClick={startMicTest}>
                  Test mikrofonu
                </button>
              ) : (
                <button className="btn" onClick={stopMicTest}>
                  Zatrzymaj test
                </button>
              )}
              {micErr && (
                <span style={{ color: "#ffb3b3", fontSize: 14 }}>{micErr}</span>
              )}
            </div>

            {/* Logo na dole */}
            <img
              src="/assets/meroar-supervised.png"
              alt="Supervised by MeRoar & adhered."
              style={{
                position: "fixed",
                bottom: 10,
                left: "50%",
                transform: "translateX(-50%)",
                width: "45%",
                maxWidth: 220,
                height: "auto",
                objectFit: "contain",
                opacity: 0.9,
                pointerEvents: "none",
              }}
            />
          </div>
        )}

        {/* SESJA */}
        {isRunning && (
          <>
            {/* Centralny tekst + wypowiedź */}
            <div className="overlay center" style={centerBoxStyle}>
              <div style={{ fontSize: 22, lineHeight: 1.5, textShadow: "0 2px 7px rgba(0,0,0,0.7)" }}>
                {displayText}
              </div>
              {sayTranscript && (
                <div
                  style={{
                    marginTop: 18,
                    fontSize: 18,
                    fontWeight: 500,
                    textShadow: "0 2px 6px rgba(0,0,0,0.7)",
                  }}
                >
                  {sayTranscript}
                </div>
              )}
            </div>

            {/* Przypominajki ~70% wysokości */}
            {hintStage > 0 && <div style={hintStyle}>{HINTS[hintStage]}</div>}
          </>
        )}

        {/* VU-meter (działa w teście i w sesji, gdy micActive=true) */}
        <div
          aria-hidden
          style={{
            position: "fixed",
            right: 8,
            top: 80,
            bottom: 16,
            width: 6,
            borderRadius: 3,
            background: "rgba(255,255,255,0.08)",
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: `${levelPct}%`,
              background: "rgba(255,255,255,0.9)",
              transition: "height 80ms linear",
            }}
          />
        </div>
      </div>
    </main>
  );
}
