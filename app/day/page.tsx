"use client";
import { useEffect, useRef, useState } from "react";

type Mode = "VERIFY" | "SAY";
type PlanStep = { mode: Mode; text: string; prepMs?: number; dwellMs?: number };
type HintKey = 1 | 2 | 3;

/* ===== DZIEŃ 3: treści z 3 krokami SAY ===== */
const DAY3_STEPS: PlanStep[] = [
  { mode: "VERIFY", text: "Jestem w bardzo dobrym miejscu." },
  { mode: "VERIFY", text: "Szacunek do siebie staje się naturalny." },
  { mode: "SAY", text: "Popatrz na siebie i podziękuj sobie. Zrób to ze spokojem — Twoje słowa wyświetlą się na ekranie.", prepMs: 800, dwellMs: 12000 },
  { mode: "VERIFY", text: "W moim wnętrzu dojrzewa spokój i zgoda." },
  { mode: "VERIFY", text: "Doceniam to, jak wiele już zostało zrobione." },
  { mode: "VERIFY", text: "Moje tempo jest wystarczające." },
  { mode: "VERIFY", text: "Uznaję swoją historię taką, jaka jest." },
  { mode: "SAY", text: "Popatrz na siebie i przyznaj sobie rację. Zrób to z przekonaniem — Twoje słowa wyświetlą się na ekranie.", prepMs: 800, dwellMs: 12000 },
  { mode: "VERIFY", text: "Każdy dzień przynosi nowe zrozumienie." },
  { mode: "VERIFY", text: "Doceniam odwagę, z jaką uczę się siebie." },
  { mode: "SAY", text: "Popatrz na siebie i pogratuluj sobie. Zrób to z radością — Twoje słowa wyświetlą się na ekranie.", prepMs: 800, dwellMs: 12000 },
  { mode: "VERIFY", text: "Wdzięczność staje się moją rutyną." },
  { mode: "VERIFY", text: "W ciszy odnajduję równowagę." },
];

/* ===== KOMPONENT ===== */
export default function PrompterPage() {
  const USER_NAME = "demo";
  const DAY_LABEL = "3";
  const SESSION_SECONDS = 6 * 60;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(SESSION_SECONDS);
  const [stepIdx, setStepIdx] = useState(0);
  const [displayText, setDisplayText] = useState(DAY3_STEPS[0].text);
  const [sayTranscript, setSayTranscript] = useState("");

  const [hintStage, setHintStage] = useState<0 | HintKey>(0);
  const [hintsLockedOut, setHintsLockedOut] = useState(false);

  const [mediaErr, setMediaErr] = useState<string | null>(null);
  const [levelPct, setLevelPct] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const sessionTimerRef = useRef<number | null>(null);
  const stepTimerRef = useRef<number | null>(null);
  const stepEndRef = useRef<number | null>(null);

  const recRef = useRef<any>(null);
  const sayActiveRef = useRef(false);

  /* ====== HINTY ====== */
  const HINTS: Record<HintKey, string> = {
    1: "Jeśli możesz, postaraj się przeczytać na głos.",
    2: "Pamiętaj — to przestrzeń pełna szacunku do Ciebie.",
    3: "Jeśli chcesz kontynuować, dotknij ekranu.",
  };

  function scheduleHints() {
    if (hintsLockedOut) return;
    setHintStage(0);
    setTimeout(() => setHintStage(1), 7000);
    setTimeout(() => setHintStage(2), 14000);
    setTimeout(() => {
      setHintStage(3);
      const once = () => {
        setHintStage(0);
        setHintsLockedOut(true);
        document.removeEventListener("click", once);
      };
      document.addEventListener("click", once, { once: true });
    }, 21000);
  }

  /* ====== SESJA ====== */
  const startSession = async () => {
    await startAV();
    setRemaining(SESSION_SECONDS);
    setIsRunning(true);
    setHintsLockedOut(false);
    runStep(0);
    runSessionTimer();
  };

  const stopSession = () => {
    setIsRunning(false);
    stopSay();
    stopAV();
    if (sessionTimerRef.current) window.clearInterval(sessionTimerRef.current);
    if (stepTimerRef.current) window.clearTimeout(stepTimerRef.current);
  };

  /* ====== TIMER SESJI ====== */
  function runSessionTimer() {
    if (sessionTimerRef.current) window.clearInterval(sessionTimerRef.current);
    const endAt = Date.now() + SESSION_SECONDS * 1000;
    sessionTimerRef.current = window.setInterval(() => {
      const secs = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0) {
        setDisplayText("To koniec dzisiejszej sesji.\nJeśli chcesz — możesz jeszcze chwilę porozmawiać ze sobą.");
        stopSay();
        stopAV();
      }
    }, 250);
  }

  /* ====== KROKI ====== */
  function runStep(i: number) {
    stopSay();
    setSayTranscript("");
    const s = DAY3_STEPS[i];
    setDisplayText(s.text);
    scheduleHints();

    if (s.mode === "SAY") {
      const prep = s.prepMs ?? 1000;
      const dwell = s.dwellMs ?? 12000;
      setTimeout(() => {
        startSay();
        setTimeout(() => {
          stopSay();
          const next = (i + 1) % DAY3_STEPS.length;
          setStepIdx(next);
          runStep(next);
        }, dwell);
      }, prep);
    } else {
      setTimeout(() => {
        const next = (i + 1) % DAY3_STEPS.length;
        setStepIdx(next);
        runStep(next);
      }, 8000);
    }
  }

  /* ====== AUDIO + VIDEO ====== */
  async function startAV() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: { echoCancellation: false, noiseSuppression: false },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        (videoRef.current as any).srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }

      const Ctx =
        (window.AudioContext ||
          (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new Ctx();
      audioCtxRef.current = ac;
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      ac.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.fftSize);
      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0,
          sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const x = (data[i] - 128) / 128;
          peak = Math.max(peak, Math.abs(x));
          sumSq += x * x;
        }
        const rms = Math.sqrt(sumSq / data.length);
        const vu = Math.min(100, Math.max(0, Math.max(peak * 480, rms * 900)));
        setLevelPct((prev) => Math.max(vu, prev * 0.85));
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch (e: any) {
      setMediaErr("Brak dostępu do kamery/mikrofonu.");
    }
  }

  function stopAV() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLevelPct(0);
  }

  /* ====== SPEECH RECOGNITION ====== */
  function startSay() {
    stopSay();
    setSayTranscript("");
    sayActiveRef.current = true;
    const SR =
      (window as any).webkitSpeechRecognition ||
      (window as any).SpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    recRef.current = rec;
    rec.lang = "pl-PL";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      let t = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        t += e.results[i][0].transcript;
      }
      setSayTranscript(t.trim());
    };
    rec.onerror = () => {};
    rec.start();
  }

  function stopSay() {
    sayActiveRef.current = false;
    const rec = recRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {}
    }
    recRef.current = null;
  }

  /* ====== STYL ====== */
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

  /* ====== RENDER ====== */
  return (
    <main className="prompter-full">
      <header
        className="topbar topbar--dense"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        <div style={{ display: "flex", gap: 12, fontSize: 15 }}>
          <span>
            <b>Użytkownik:</b> {USER_NAME}
          </span>
          <span>
            <b>Dzień programu:</b> {DAY_LABEL}
          </span>
        </div>
        <div>
          {!isRunning ? (
            <button className="btn" onClick={startSession}>
              Start
            </button>
          ) : (
            <button className="btn" onClick={stopSession}>
              Stop
            </button>
          )}
        </div>
      </header>

      <div className="timer-top timer-top--strong">
        {`${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`}
      </div>

      <div className="stage mirrored" style={{ position: "relative" }}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

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

            {mediaErr && (
              <div style={{ color: "#ffb3b3", fontSize: 14, marginBottom: 70 }}>
                {mediaErr}
              </div>
            )}

            <img
              src="/assets/meroar-supervised.png"
              alt="Supervised by MeRoar & adhered."
              style={{
                position: "fixed",
                bottom: 10,
                left: "50%",
                transform: "translateX(-50%)",
                width: "40%",
                maxWidth: 200,
                opacity: 0.9,
                pointerEvents: "none",
              }}
            />
          </div>
        )}

        {isRunning && (
          <>
            <div className="overlay center" style={centerBoxStyle}>
              {sayTranscript && (
                <div style={{ marginBottom: 16, fontSize: 20, fontWeight: 600 }}>
                  {sayTranscript}
                </div>
              )}
              <div style={{ fontSize: 22, lineHeight: 1.5 }}>{displayText}</div>
            </div>

            {hintStage > 0 && !hintsLockedOut && (
              <div
                style={{
                  position: "absolute",
                  top: "70%",
                  left: "50%",
                  transform: "translateX(-50%)",
                  width: "min(90vw, 700px)",
                  textAlign: "center",
                  fontSize: 15,
                  color: "rgba(255,255,255,0.96)",
                  lineHeight: 1.4,
                  padding: "0 16px",
                }}
              >
                {HINTS[hintStage as HintKey]}
              </div>
            )}
          </>
        )}

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

