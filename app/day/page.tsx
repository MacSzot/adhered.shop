"use client";

import { useEffect, useRef, useState } from "react";

/* =============== PLAN DNIA =============== */
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;
  prompt?: string;
  min_sentences?: number;
  starts_with?: string[];
  starts_with_any?: string[];
  prep_ms?: number;   // opóźnienie przed startem nagrywania
  dwell_ms?: number;  // długość okna SAY
  note?: string;
};

async function loadDayPlanOrTxt(dayFileParam: string): Promise<{ source: "json" | "txt"; steps: PlanStep[] }> {
  try {
    const r = await fetch(`/days/${dayFileParam}.plan.json`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const steps = Array.isArray(j?.steps) ? (j.steps as PlanStep[]) : [];
      if (steps.length) return { source: "json", steps };
    }
  } catch {}
  const r2 = await fetch(`/days/${dayFileParam}.txt`, { cache: "no-store" });
  if (!r2.ok) throw new Error(`Brak pliku dnia: ${dayFileParam}.plan.json i ${dayFileParam}.txt`);
  const txt = await r2.text();
  const steps: PlanStep[] = txt
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(line => ({ mode: "VERIFY" as const, target: line }));
  return { source: "txt", steps };
}

/* =============== HELPERS =============== */
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

/* =============== PAGE =============== */
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Ustawienia
  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "01") : "01";
  const dayFileParam = dayRaw.padStart(2, "0"); // zawsze 01..11 do wczytywania plików
  const DAY_LABEL = (() => {
    const n = parseInt(dayRaw, 10);
    return Number.isNaN(n) ? dayRaw : String(n); // UI: bez zera wiodącego
  })();

  const MAX_TIME = 6 * 60; // 6 minut

  // Progi/czasy VAD
  const SPEAKING_FRAMES_REQUIRED = 2;

  // Stany
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [sayTranscript, setSayTranscript] = useState<string>("");

  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);           // ✅ nowy stan pauzy
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);
  const [micError, setMicError] = useState<string | null>(null);

  // ⏸️ Pauza ciszy (auto-pauza): jedyna przypominajka po 10 s
  const [silencePause, setSilencePause] = useState(false);
  const pausedRemainingRef = useRef<number | null>(null);

  // 👉 czy mamy już stream (żeby ukryć natywny „play”)
  const [hasStream, setHasStream] = useState(false);

  // Refy aktualnych wartości
  const isRunningRef = useRef(isRunning);
  const idxRef = useRef(idx);
  const stepsRef = useRef<PlanStep[]>([]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  // ===== TIMER SESJI =====
  const endAtRef = useRef<number | null>(null);
  const countdownIdRef = useRef<number | null>(null);

  function startCountdown(seconds: number) {
    stopCountdown();
    endAtRef.current = Date.now() + seconds * 1000;
    setRemaining(Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000)));
    countdownIdRef.current = window.setInterval(() => {
      if (!endAtRef.current) return;
      const secs = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0) stopSession();
    }, 250);
  }
  function stopCountdown() {
    if (countdownIdRef.current) {
      window.clearInterval(countdownIdRef.current);
      countdownIdRef.current = null;
    }
    endAtRef.current = null;
  }

  // Timery/RAF
  const stepTimerRef = useRef<number | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // AV
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const heardThisStepRef = useRef(false);
  const speakingFramesRef = useRef(0);

  // Whisper recorder
  const recRef = useRef<MediaRecorder | null>(null);
  const chunkTimerRef = useRef<number | null>(null);

  // znacznik ostatniego realnego głosu (dla pauzy po 10 s)
  const lastVoiceAtRef = useRef<number>(Date.now());

  /* ---- 1) Wczytaj plan ---- */
  useEffect(() => {
    (async () => {
      try {
        const { source, steps } = await loadDayPlanOrTxt(dayFileParam);
        setSteps(steps);
        setIdx(0);
        setDisplayText(steps[0]?.mode === "VERIFY" ? (steps[0].target || "") : (steps[0]?.prompt || ""));
        // eslint-disable-next-line no-console
        console.log(`[DAY ${dayFileParam}] source:`, source, `steps: ${steps.length}`);
      } catch (e) {
        console.error(e);
        const fallback = [{ mode: "VERIFY" as const, target: "Brak treści dla tego dnia." }];
        setSteps(fallback);
        setDisplayText(fallback[0].target!);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- 2) Start/Stop AV + VU + watchdog ciszy ---- */
  async function startAV(): Promise<boolean> {
    // nie zatrzymujemy AV przy "pauzie" – tylko przy pełnym "stop"
    setMicError(null);
    speakingFramesRef.current = 0;
    lastVoiceAtRef.current = Date.now();

    try {
      if (!streamRef.current) {
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
      }
      setHasStream(true);

      if (!audioCtxRef.current) {
        const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
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
        ac.createMediaStreamSource(streamRef.current!).connect(analyser);
        analyserRef.current = analyser;

        const data = new Uint8Array(analyser.fftSize);
        const loop = () => {
          if (!analyserRef.current || !isRunningRef.current) {
            rafRef.current = requestAnimationFrame(loop); // utrzymuj animację paska
            return;
          }
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

          const speakingNow = (rms > 0.017) || (peak > 0.040) || (vu > 7);
          if (speakingNow) {
            speakingFramesRef.current += 1;
            if (speakingFramesRef.current >= SPEAKING_FRAMES_REQUIRED) {
              heardThisStepRef.current = true;
              lastVoiceAtRef.current = Date.now();
            }
          } else {
            speakingFramesRef.current = 0;
          }

          // Jedyna „auto-pauza” po 10 s ciszy
          if (isRunningRef.current && !silencePause) {
            const now = Date.now();
            if (now - lastVoiceAtRef.current >= 10_000) {
              let secsLeft = remaining;
              if (endAtRef.current != null) {
                secsLeft = Math.max(0, Math.ceil((endAtRef.current - now) / 1000));
              }
              pausedRemainingRef.current = secsLeft;
              stopCountdown();
              setRemaining(secsLeft);
              setSilencePause(true);
              setIsRunning(false);
              setIsPaused(true);
            }
          }

          rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);
      }

      return true;
    } catch (err: any) {
      console.error("getUserMedia error:", err);
      setMicError(err?.name === "NotAllowedError" ? "Brak zgody na mikrofon/kamerę." : "Nie udało się uruchomić mikrofonu/kamery.");
      return false;
    }
  }

  function stopAV() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    setHasStream(false);
  }

  // Ręczna pauza z przycisku
  function pauseSession() {
    if (!isRunning) return;
    stopCountdown();
    clearStepTimers();
    stopSayCaptureWhisper();
    setIsRunning(false);
    setIsPaused(true);        // zachowujemy stan (czas, krok, kamera)
    setSilencePause(false);
    pausedRemainingRef.current = remaining;
  }

  // Wznowienie po tapnięciu w komunikat lub przycisk START
  function resumeFromPause() {
    const secs = pausedRemainingRef.current ?? remaining;
    startCountdown(secs);
    setSilencePause(false);
    setIsPaused(false);
    setIsRunning(true);
    lastVoiceAtRef.current = Date.now();
    runStep(idxRef.current);
  }

  /* ===== WHISPER: start/stop ===== */
  async function startSayCaptureWhisper() {
    setSayTranscript("");
    const stream = streamRef.current;
    if (!stream) return;

    const mime = MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "");
    if (!mime) { console.warn("MediaRecorder: brak wspieranego MIME."); return; }

    const mr = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64_000 });
    recRef.current = mr;

    mr.ondataavailable = async (e) => {
      if (!e.data || e.data.size === 0) return;
      const fd = new FormData();
      const filename = mime.includes("mp4") ? "chunk.m4a" : "chunk.webm";
      fd.append("audio", e.data, filename);
      try {
        const resp = await fetch("/api/whisper", { method: "POST", body: fd });
        const json = await resp.json();
        if (json?.text) {
          setSayTranscript((p) => (p ? p + " " : "") + json.text);
          lastVoiceAtRef.current = Date.now();
        } else if (json?.error) {
          console.warn("Whisper API error:", json.error);
        }
      } catch (err) {
        console.warn("Whisper fetch failed:", err);
      }
    };

    try { mr.start(2000); }
    catch {
      try { mr.start(); } catch {}
      chunkTimerRef.current = window.setInterval(() => {
        if (recRef.current && recRef.current.state === "recording") {
          try { recRef.current.requestData(); } catch {}
        }
      }, 2000);
    }
  }

  function stopSayCaptureWhisper() {
    if (chunkTimerRef.current) { clearInterval(chunkTimerRef.current); chunkTimerRef.current = null; }
    if (recRef.current) { try { recRef.current.stop(); } catch {} recRef.current = null; }
  }

  /* ---- 3) Kroki ---- */
  function clearStepTimers() {
    if (stepTimerRef.current) { window.clearTimeout(stepTimerRef.current); stepTimerRef.current = null; }
    if (advanceTimerRef.current) { window.clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null; }
  }

  function runStep(i: number) {
    if (!stepsRef.current.length) return;
    const s = stepsRef.current[i];
    if (!s) return;

    clearStepTimers();
    setSayTranscript("");

    if (s.mode === "VERIFY") {
      stopSayCaptureWhisper();
      setDisplayText(s.target || "");
    } else {
      const prep = Number(s.prep_ms ?? 200);
      const dwell = Number(s.dwell_ms ?? 12000);

      stopSayCaptureWhisper();
      setDisplayText(s.prompt || "");
      setSayTranscript("");

      stepTimerRef.current = window.setTimeout(() => {
        if (idxRef.current !== i || !isRunningRef.current) return;
        startSayCaptureWhisper();

        stepTimerRef.current = window.setTimeout(() => {
          if (idxRef.current !== i) return;
          stopSayCaptureWhisper();
          gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearStepTimers();
    stopSayCaptureWhisper();
    const next = (i + 1) % stepsRef.current.length;
    setIdx(next);
    const n = stepsRef.current[next];
    setDisplayText(n?.mode === "VERIFY" ? (n?.target || "") : (n?.prompt || ""));
    runStep(next);
  }

  /* ---- 4) Start/Stop/Wznów ---- */
  const startSession = async () => {
    if (isPaused) {              // wznawiamy z pauzy
      resumeFromPause();
      return;
    }
    if (!stepsRef.current.length) return;
    const ok = await startAV();
    if (!ok) { setIsRunning(false); return; }
    setIsRunning(true);
    setIsPaused(false);
    setSilencePause(false);
    pausedRemainingRef.current = null;
    startCountdown(MAX_TIME);
    setIdx(0);
    setDisplayText(stepsRef.current[0]?.mode === "VERIFY" ? (stepsRef.current[0].target || "") : (stepsRef.current[0]?.prompt || ""));
    runStep(0);
  };

  const stopSession = () => {
    setIsRunning(false);
    setIsPaused(false);
    stopCountdown();
    clearStepTimers();
    stopSayCaptureWhisper();
    stopAV();
    setLevelPct(0);
    setSilencePause(false);
    pausedRemainingRef.current = null;
    setRemaining(MAX_TIME);
  };

  /* ---- 5) Render ---- */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // Teksty
  const questionStyle: React.CSSProperties = {
    fontSize: 20,
    lineHeight: 1.55,
    maxWidth: 720,
    margin: "0 auto",
    textAlign: "center",
  };
  const transcriptStyle: React.CSSProperties = {
    marginTop: 14,
    fontSize: 20,
    opacity: 0.98,
    minHeight: 30,
    textAlign: "center",
  };

  return (
    <main className="prompter-full">
      {/* WYŻSZY TOPBAR z dwoma liniami po lewej oraz STOP/PAUSE w kolumnie */}
      <header className="topbar topbar--dense topbar--tall">
        <div className="top-sides">
          <div className="top-left">
            <div className="line"><b>Użytkownik:</b> {USER_NAME}</div>
            <div className="line"><b>Dzień programu:</b> {DAY_LABEL}</div>
          </div>

          <div className="controls-vert">
            {isRunning ? (
              <>
                <button className="btn-ghost" onClick={pauseSession}>Pause</button>
                <button className="btn-ghost" onClick={stopSession}>Stop</button>
              </>
            ) : (
              <button className="btn-ghost" onClick={startSession}>{isPaused ? "Wznów" : "Start"}</button>
            )}
          </div>
        </div>
      </header>

      <div className="timer-top timer-top--strong" style={{ textAlign: "center" }}>{fmt(remaining)}</div>

      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`cam ${!hasStream ? "video-hidden" : ""}`}
        />

        {/* EKRAN STARTOWY / WZNÓW */}
        {!isRunning && !silencePause && (
          <>
            <div className="overlay center">
              <div className="intro" style={{ textAlign: "center", maxWidth: 520, lineHeight: 1.6, margin: "0 auto" }}>
                <p style={{ fontSize: 15.5, opacity: 0.92 }}>
                  Twoja sesja potrwa około <b>6 minut</b>.<br />
                  Prosimy o powtarzanie na głos wyświetlanych treści.
                </p>
                {micError && (
                  <p style={{ marginTop: 12, color: "#ffb3b3", fontSize: 14 }}>
                    {micError} — sprawdź dostęp do mikrofonu i kamery.
                  </p>
                )}
              </div>
            </div>
            <button className="start-floating" onClick={startSession}>{isPaused ? "WZNÓW" : "START"}</button>
          </>
        )}

        {/* SESJA */}
        {isRunning && (
          <div className="overlay center" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: "100%", padding: "0 16px" }}>
              {/* VERIFY: tekst do powtórzenia */}
              {steps[idx]?.mode === "VERIFY" && (
                <div className="center-text fade" style={{ whiteSpace: "pre-wrap", textAlign: "center", fontSize: 22, lineHeight: 1.5, maxWidth: 760, margin: "0 auto" }}>
                  {displayText}
                </div>
              )}

              {/* SAY: pytanie + transkrypt */}
              {steps[idx]?.mode === "SAY" && (
                <div className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
                  <div style={questionStyle}>{displayText}</div>
                  <div style={transcriptStyle}>{sayTranscript}</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ⏸️ Powiadomienie po 10 s ciszy – na dole, dotknięcie = wznów */}
        {silencePause && (
          <div className="pause-overlay" onClick={resumeFromPause}>
            <div className="pause-card">
              <div className="l1">Jeśli nie czujesz, że to dobry moment, zawsze możesz wrócić później.</div>
              <div className="l2">Jeśli chcesz kontynuować, dotknij ekranu.</div>
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
