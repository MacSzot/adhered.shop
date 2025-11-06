"use client";

import { useEffect, useRef, useState } from "react";
import "../globals.css";

/* Typ planu */
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;
  prompt?: string;
  min_sentences?: number;
  starts_with?: string[];
  starts_with_any?: string[];
  prep_ms?: number;
  dwell_ms?: number;
  note?: string;
};

/* Ładowanie planu dnia */
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
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .map(line => ({ mode: "VERIFY" as const, target: line }));
  return { source: "txt", steps };
}

function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Ustawienia UI
  const USER_NAME = "Magda";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "1") : "1";
  const dayFileParam = dayRaw.toString().padStart(2, "0");
  const DAY_LABEL = dayRaw.toString();

  const MAX_TIME = 6 * 60; // 6 minut

  // Audio/VAD progi
  const SPEAKING_FRAMES_REQUIRED = 2;

  // Stany
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [sayTranscript, setSayTranscript] = useState<string>("");

  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [levelPct, setLevelPct] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);

  const [silencePause, setSilencePause] = useState(false);
  const pausedRemainingRef = useRef<number | null>(null);

  // Refy bieżące
  const isRunningRef = useRef(isRunning);
  const idxRef = useRef(idx);
  const stepsRef = useRef<PlanStep[]>([]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  // Timer sesji
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
    if (countdownIdRef.current) { window.clearInterval(countdownIdRef.current); countdownIdRef.current = null; }
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

  // Whisper chunking
  const recRef = useRef<MediaRecorder | null>(null);
  const chunkTimerRef = useRef<number | null>(null);

  const lastVoiceAtRef = useRef<number>(Date.now());

  /* 1) Wczytaj plan */
  useEffect(() => {
    (async () => {
      try {
        const { source, steps } = await loadDayPlanOrTxt(dayFileParam);
        setSteps(steps);
        setIdx(0);
        setDisplayText(steps[0]?.mode === "VERIFY" ? (steps[0].target || "") : (steps[0]?.prompt || ""));
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

  /* 2) Start/Stop AV + VU + watchdog ciszy */
  async function startAV(): Promise<boolean> {
    stopAV();
    setMicError(null);
    speakingFramesRef.current = 0;
    lastVoiceAtRef.current = Date.now();

    try {
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
        if (!analyserRef.current || !isRunningRef.current) return;
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

        // Jedyna przypominajka po 10 s ciszy
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
          }
        }

        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
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
    if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch {} audioCtxRef.current = null; }
  }

  function resumeFromPause() {
    if (!silencePause) return;
    const secs = pausedRemainingRef.current ?? remaining;
    startCountdown(secs);
    setSilencePause(false);
    lastVoiceAtRef.current = Date.now();
  }

  /* 3) Whisper chunkowanie */
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

    try {
      mr.start(2000);
    } catch {
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

  /* 4) Kroki */
  function clearStepTimers() {
    if (stepTimerRef.current) { window.clearTimeout(stepTimerRef.current); stepTimerRef.current = null; }
    if (advanceTimerRef.current) { window.clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null; }
  }

  function runStep(i: number) {
    if (!stepsRef.current.length) return;
    const s = stepsRef.current[i]; if (!s) return;

    clearStepTimers();
    heardThisStepRef.current = false;
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
        if (idxRef.current !== i) return;
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

  /* 5) Start/Stop sesji */
  const startSession = async () => {
    if (!stepsRef.current.length) return;
    const ok = await startAV();
    if (!ok) { setIsRunning(false); return; }
    setIsRunning(true);
    setSilencePause(false);
    pausedRemainingRef.current = null;
    startCountdown(MAX_TIME);
    setIdx(0);
    setDisplayText(stepsRef.current[0]?.mode === "VERIFY" ? (stepsRef.current[0].target || "") : (stepsRef.current[0]?.prompt || ""));
    runStep(0);
  };
  const stopSession = () => {
    setIsRunning(false);
    stopCountdown();
    clearStepTimers();
    stopSayCaptureWhisper();
    stopAV();
    setLevelPct(0);
    setSilencePause(false);
    pausedRemainingRef.current = null;
  };

  /* Render z nowym, stałym layoutem */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <main>
      <div className="stage">
        <video ref={videoRef} autoPlay playsInline muted className="cam" />
        <div className="veil" />

        {/* Górny panel zgodny z mockami */}
        <header className="topbar-fixed">
          <div className="topbar-inner">
            <div className="top-left">
              <div className="line">User: {USER_NAME}</div>
              <div className="line">Day: {DAY_LABEL}</div>
            </div>
            <div className="top-right" style={{ textAlign: "right" }}>
              <div className="line" role="button" onClick={stopSession}>STOP</div>
              <div className="line" role="button" onClick={() => setIsRunning(v => !v)}>PAUSE</div>
            </div>
          </div>
        </header>

        {/* Timer – zamglony pod panelem */}
        <div className="timer-ghost">{fmt(remaining)}</div>

        {/* Overlay centralny */}
        <div className="overlay-center">
          <div className="center-wrap">
            {!isRunning && (
              <>
                <div className="sys-text">Twoja sesja potrwa 6 minut – prosimy o wyraźne powtarzanie wyświetlanych treści.</div>
                {micError && <div className="sys-text" style={{ opacity:.9, marginTop:10, color:"#ffdddd" }}>{micError} — sprawdź dostęp do mikrofonu i kamery.</div>}
                <div className="start-big" role="button" onClick={startSession}>START</div>
              </>
            )}

            {isRunning && (
              <>
                {steps[idx]?.mode === "VERIFY" && (
                  <div className="sys-text" style={{ whiteSpace:"pre-wrap" }}>{displayText}</div>
                )}
                {steps[idx]?.mode === "SAY" && (
                  <>
                    <div className="sys-text" style={{ whiteSpace:"pre-wrap" }}>{displayText}</div>
                    <div className="user-speech" style={{ whiteSpace:"pre-wrap", minHeight:36 }}>{sayTranscript}</div>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {/* Pauza po 10 s ciszy */}
        {silencePause && (
          <div className="pause-overlay" onClick={resumeFromPause}>
            <div className="pause-card">
              <div className="l1">Jeśli nie czujesz, że to dobry moment, zawsze możesz wrócić później.</div>
              <div className="l2">Jeśli chcesz kontynuować, dotknij ekranu.</div>
            </div>
          </div>
        )}

        {/* Pasek dźwięku po prawej */}
        <div className="meter-vertical" aria-hidden="true">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}
