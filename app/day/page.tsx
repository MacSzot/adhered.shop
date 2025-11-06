// app/day/page.tsx
"use client";

import { useEffect, useRef, useState } from "react";

/* =============== PLAN DNIA =============== */
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;
  prompt?: string;
  prep_ms?: number;
  dwell_ms?: number;
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
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .map(line => ({ mode: "VERIFY" as const, target: line }));
  return { source: "txt", steps };
}

/* =============== HELPERS / DETECT =============== */
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}
type SR = any;
function getSpeechRecognitionCtor(): SR | null {
  if (typeof window === "undefined") return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}
function isMobileUA(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
}
function isIOSSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  return isIOS && isSafari;
}

/* =============== PAGE =============== */
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Ustawienia
  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "01") : "01";
  const dayFileParam = dayRaw.padStart(2, "0");
  const DAY_LABEL = (() => {
    const n = parseInt(dayRaw, 10);
    return Number.isNaN(n) ? dayRaw : String(n);
  })();
  const isDayOne = dayFileParam === "01";

  // Timingi
  const MAX_TIME = 6 * 60;       // 6:00
  const VERIFY_GREEN_AT = 4000;  // po 4s od pierwszego głosu
  const VERIFY_NEXT_AT = 5000;   // po 5s (flash 1s)
  const SAY_LIMIT_TOTAL = 12000; // 12s
  const SAY_GREEN_AT = 11000;    // 11s → 1s flash
  const SILENCE_TIMEOUT = 10000; // 10s ciszy

  // Progi VAD
  const SPEAKING_FRAMES_REQUIRED = 2;

  // Stan UI
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [sayTranscript, setSayTranscript] = useState<string>("");

  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);
  const [micError, setMicError] = useState<string | null>(null);
  const [hasStream, setHasStream] = useState(false);
  const [flashGreen, setFlashGreen] = useState(false);
  const [silencePause, setSilencePause] = useState(false);

  // Refs
  const isRunningRef = useRef(isRunning);
  const idxRef = useRef(idx);
  const stepsRef = useRef<PlanStep[]>([]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  // Zegar sesji
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

  // Timery kroków
  const verifyGreenTimerRef = useRef<number | null>(null);
  const verifyNextTimerRef = useRef<number | null>(null);
  const sayGreenTimerRef = useRef<number | null>(null);
  const sayNextTimerRef = useRef<number | null>(null);
  const prepTimerRef = useRef<number | null>(null);

  function clearStepTimers() {
    [verifyGreenTimerRef, verifyNextTimerRef, sayGreenTimerRef, sayNextTimerRef, prepTimerRef].forEach(r => {
      if (r.current) { clearTimeout(r.current!); r.current = null; }
    });
  }

  // AV / VAD
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioActiveRef = useRef(false); // ✅ tylko gdy mamy mikrofon

  const speakingFramesRef = useRef(0);
  const heardThisStepRef = useRef(false);
  const lastVoiceAtRef = useRef<number>(Date.now());

  // Web Speech (desktop)
  const SR_CTOR = getSpeechRecognitionCtor();
  const speechRecRef = useRef<InstanceType<typeof SR_CTOR> | null>(null);

  // Pauza – ile zostało
  const pausedRemainingRef = useRef<number | null>(null);

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

  /* ---- 2) Start/Stop AV + VAD ---- */
  async function startAV(opts?: { audioOnly?: boolean }) {
    setMicError(null);
    speakingFramesRef.current = 0;
    lastVoiceAtRef.current = Date.now();

    const wantAudioOnly = !!opts?.audioOnly;

    try {
      if (!streamRef.current) {
        const constraints: MediaStreamConstraints = wantAudioOnly
          ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false }
          : {
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
              video: true,
            };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;
        if (!wantAudioOnly && videoRef.current) (videoRef.current as any).srcObject = stream;
      }
      setHasStream(!wantAudioOnly); // kamera widoczna tylko gdy wideo
      audioActiveRef.current = true;

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
        analyser.smoothingTimeConstant = 0.75;
        ac.createMediaStreamSource(streamRef.current!).connect(analyser);
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

          setLevelPct(prev => Math.max(vu, prev * 0.82));

          const speakingNow = (rms > 0.017) || (peak > 0.040) || (vu > 7);
          const now = Date.now();

          if (isRunningRef.current && audioActiveRef.current) {
            if (speakingNow) {
              speakingFramesRef.current += 1;
              if (speakingFramesRef.current >= SPEAKING_FRAMES_REQUIRED) {
                if (!heardThisStepRef.current) {
                  heardThisStepRef.current = true;
                  onFirstVoiceHeard();
                }
                lastVoiceAtRef.current = now;
              }
            } else {
              speakingFramesRef.current = 0;
            }
            if (!silencePause) {
              const delta = now - lastVoiceAtRef.current;
              if (delta >= SILENCE_TIMEOUT) triggerSilencePause();
            }
          }

          rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);
      }

      return true;
    } catch (err: any) {
      console.error("getUserMedia error:", err);
      setMicError(err?.name === "NotAllowedError" ? "Brak zgody na mikrofon." : "Nie udało się uruchomić mikrofonu/kamery.");
      return false;
    }
  }

  function stopAV() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    audioActiveRef.current = false;
    setHasStream(false);
  }

  /* ---- 3) Reakcje na głos i ciszę ---- */
  function onFirstVoiceHeard() {
    lastVoiceAtRef.current = Date.now();
    const s = stepsRef.current[idxRef.current];
    if (!s) return;
    if (s.mode === "VERIFY") {
      if (verifyGreenTimerRef.current) clearTimeout(verifyGreenTimerRef.current);
      if (verifyNextTimerRef.current) clearTimeout(verifyNextTimerRef.current);
      verifyGreenTimerRef.current = window.setTimeout(() => setFlashGreen(true), VERIFY_GREEN_AT);
      verifyNextTimerRef.current = window.setTimeout(() => {
        setFlashGreen(false);
        gotoNext(idxRef.current);
      }, VERIFY_NEXT_AT);
    }
  }

  function triggerSilencePause() {
    let secsLeft = remaining;
    if (endAtRef.current != null) secsLeft = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
    pausedRemainingRef.current = secsLeft;
    stopCountdown();

    stopWebSpeech();
    stopWhisperRecorder();

    setSilencePause(true);
    setIsRunning(false);
    clearStepTimers();
  }

  function clickSilenceOverlayGoNext() {
    setSilencePause(false);
    setFlashGreen(false);
    gotoNext(idxRef.current);
    const secs = pausedRemainingRef.current ?? remaining;
    startCountdown(secs);
    setIsRunning(true);
    lastVoiceAtRef.current = Date.now();
  }

  /* ---- 4) Web Speech (desktop) ---- */
  function startWebSpeech() {
    const SR = SR_CTOR;
    if (!SR) return;
    const rec = new SR();
    try {
      rec.lang = "pl-PL";
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (ev: any) => {
        let txt = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          txt += res[0]?.transcript || "";
        }
        if (isRunningRef.current) {
          setSayTranscript(txt.trim());
          lastVoiceAtRef.current = Date.now();
        }
      };
      rec.onerror = () => {};
      rec.onend = () => {};
      speechRecRef.current = rec as any;
      try { rec.start(); } catch {}
    } catch {}
  }
  function stopWebSpeech() {
    const rec: any = speechRecRef.current;
    if (rec) {
      try { rec.stop(); } catch {}
      speechRecRef.current = null;
    }
  }

  /* ---- 5) Whisper (mobile) ---- */
  const mrRef = useRef<MediaRecorder | null>(null);
  const mrIntervalRef = useRef<number | null>(null);

  function startWhisperRecorder() {
    if (typeof MediaRecorder === "undefined") {
      console.warn("Brak MediaRecorder.");
      return;
    }
    const stream = streamRef.current;
    if (!stream) return;

    const preferMp4 = isIOSSafari();
    const mp4Ok = MediaRecorder.isTypeSupported("audio/mp4");
    const webmOk = MediaRecorder.isTypeSupported("audio/webm;codecs=opus");
    const mime =
      (preferMp4 && mp4Ok) ? "audio/mp4"
      : (webmOk ? "audio/webm;codecs=opus"
      : (mp4Ok ? "audio/mp4" : ""));

    if (!mime) {
      console.warn("MediaRecorder: brak wspieranego MIME.");
      return;
    }

    const mr = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128_000 });
    mrRef.current = mr;

    mr.onstart = () => { try { mr.requestData(); } catch {} };

    mr.ondataavailable = async (e) => {
      if (!e.data || e.data.size < 1024) return;
      const fd = new FormData();
      const filename = mime.includes("mp4") ? "chunk.m4a" : "chunk.webm";
      fd.append("audio", e.data, filename);

      const ctrl = new AbortController();
      const to = window.setTimeout(() => ctrl.abort(), 4000);

      try {
        const resp = await fetch("/api/whisper", { method: "POST", body: fd, signal: ctrl.signal, cache: "no-store" });
        window.clearTimeout(to);
        if (!resp.ok) return;
        const json = await resp.json();
        if (json?.text && isRunningRef.current) {
          setSayTranscript((prev) => {
            const next = (prev ? prev + " " : "") + String(json.text || "").trim();
            return next.trim();
          });
          lastVoiceAtRef.current = Date.now();
        }
      } catch {
        window.clearTimeout(to);
      }
    };

    try { mr.start(600); } catch { try { mr.start(); } catch {} }
    if (mrIntervalRef.current) clearInterval(mrIntervalRef.current);
    mrIntervalRef.current = window.setInterval(() => {
      if (mrRef.current && mrRef.current.state === "recording") {
        try { mrRef.current.requestData(); } catch {}
      }
    }, 600);
  }
  function stopWhisperRecorder() {
    if (mrIntervalRef.current) { clearInterval(mrIntervalRef.current); mrIntervalRef.current = null; }
    if (mrRef.current) { try { mrRef.current.stop(); } catch {} mrRef.current = null; }
  }

  /* ---- 6) Kroki ---- */
  function runStep(i: number) {
    clearStepTimers();
    setFlashGreen(false);
    setSayTranscript("");
    heardThisStepRef.current = false;
    speakingFramesRef.current = 0;

    // Dzień 1: mikrofon dopiero od kroku 6 (po 5 intro). Kamera w Dniu 1 NIGDY.
    if (isDayOne) {
      const needMicNow = i >= 6;
      if (needMicNow && !audioActiveRef.current) {
        startAV({ audioOnly: true }).then(() => {
          lastVoiceAtRef.current = Date.now();
        });
      }
    }

    const s = stepsRef.current[i];
    if (!s) return;

    const prep = Number(s.prep_ms ?? 0);

    if (s.mode === "VERIFY") {
      setDisplayText(s.target || "");
      // Zielony/next odpala się po pierwszym głosie (gdy mic jest aktywny)
    } else {
      setDisplayText(s.prompt || "");
      sayGreenTimerRef.current = window.setTimeout(() => setFlashGreen(true), prep + SAY_GREEN_AT);
      sayNextTimerRef.current  = window.setTimeout(() => { setFlashGreen(false); gotoNext(i); }, prep + SAY_LIMIT_TOTAL);

      // Rozpoznawanie: desktop → Web Speech; mobile → Whisper
      const useMobile = isMobileUA();
      if (!useMobile && SR_CTOR) {
        prepTimerRef.current = window.setTimeout(() => startWebSpeech(), Math.max(0, prep));
      } else {
        prepTimerRef.current = window.setTimeout(() => startWhisperRecorder(), Math.max(0, prep));
      }
    }
  }

  function gotoNext(i: number) {
    clearStepTimers();
    setFlashGreen(false);
    stopWebSpeech();
    stopWhisperRecorder();
    setSayTranscript("");

    const next = (i + 1) % stepsRef.current.length;
    setIdx(next);
    const n = stepsRef.current[next];
    setDisplayText(n?.mode === "VERIFY" ? (n?.target || "") : (n?.prompt || ""));
    runStep(next);
  }

  /* ---- 7) Start/Stop ---- */
  const startSession = async () => {
    if (!stepsRef.current.length) return;

    // Dzień 1: start bez AV. Dni 2+: od razu audio+video.
    if (!isDayOne) {
      const ok = await startAV({ audioOnly: false });
      if (!ok) { setIsRunning(false); return; }
    }

    // pre-warm whisper (żeby pierwsza paczka nie była zimnym startem)
    try { await fetch("/api/whisper", { cache: "no-store" }); } catch {}

    setIsRunning(true);
    setSilencePause(false);
    pausedRemainingRef.current = null;
    startCountdown(MAX_TIME);
    setIdx(0);
    const first = stepsRef.current[0];
    setDisplayText(first?.mode === "VERIFY" ? (first?.target || "") : (first?.prompt || ""));
    runStep(0);
  };

  const stopSession = () => {
    setIsRunning(false);
    setSilencePause(false);
    stopCountdown();
    clearStepTimers();
    stopWebSpeech();
    stopWhisperRecorder();
    stopAV();
    setLevelPct(0);
    setSayTranscript("");
    setFlashGreen(false);
    pausedRemainingRef.current = null;
    setRemaining(MAX_TIME);
  };

  /* ---- 8) Render ---- */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const questionStyle: React.CSSProperties = {
    fontSize: 22,
    lineHeight: 1.55,
    maxWidth: 720,
    margin: "0 auto",
    textAlign: "center",
    opacity: 0.8
  };
  const transcriptStyle: React.CSSProperties = {
    marginTop: 16,
    fontSize: 26,
    fontWeight: 800,
    opacity: 0.98,
    minHeight: 34,
    textAlign: "center",
    textShadow: "0 0 22px rgba(0,0,0,.95)",
    letterSpacing: "0.01em",
    wordSpacing: "0.06em",
    transition: "color .25s ease, opacity .25s ease",
    color: flashGreen ? "#35ff7a" : "#ffffff",
  };
  const verifyStyle: React.CSSProperties = {
    whiteSpace: "pre-wrap",
    textAlign: "center",
    fontSize: 24,
    lineHeight: 1.5,
    maxWidth: 760,
    margin: "0 auto",
    color: flashGreen ? "#8fff8f" : "rgba(255,255,255,.78)",
    textShadow: "0 0 16px rgba(0,0,0,.9)",
    transition: "color .25s ease"
  };

  return (
    <main className="prompter-full">
      {/* GÓRNY PANEL – bez zmian designu */}
      <header className="topbar topbar--dense topbar--tall">
        <div className="top-sides">
          <div className="top-left">
            <div className="line"><b>Użytkownik:</b> {USER_NAME}</div>
            <div className="line"><b>Dzień programu:</b> {DAY_LABEL}</div>
          </div>
          <div className="controls-vert">
            {isRunning ? (
              <>
                <button className="btn-ghost" onClick={triggerSilencePause}>Pause</button>
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
        {/* Dzień 1 nie używa wideo, więc videoRef pozostanie puste; Dni 2+ pokażą kamerę */}
        <video ref={videoRef} autoPlay playsInline muted className={`cam ${!hasStream ? "video-hidden" : ""}`} />

        {/* START */}
        {!isRunning && !silencePause && (
          <>
            <div className="overlay center">
              <div className="intro" style={{ textAlign: "center", maxWidth: 520, lineHeight: 1.6, margin: "0 auto" }}>
                <p style={{ fontSize: 15.5, opacity: 0.92 }}>
                  Twoja sesja potrwa około <b>6 minut</b>.<br />
                  Prosimy o powtarzanie na głos wyświetlanych treści, gdy o to poprosimy.
                </p>
                {micError && (
                  <p style={{ marginTop: 12, color: "#ffb3b3", fontSize: 14 }}>
                    {micError} — sprawdź dostęp do mikrofonu.
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
              {steps[idx]?.mode === "VERIFY" && (
                <div className="center-text fade" style={verifyStyle}>{displayText}</div>
              )}
              {steps[idx]?.mode === "SAY" && (
                <div className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
                  <div style={questionStyle}>{displayText}</div>
                  <div style={transcriptStyle}>{sayTranscript || "…"}</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Pauza po 10 s ciszy – aktywna tylko, gdy mic jest włączony */}
        {silencePause && (
          <div
            className="pause-overlay"
            onClick={clickSilenceOverlayGoNext}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
              padding: 24,
              textAlign: "center",
              background: "rgba(0,0,0,0.35)",
              cursor: "pointer",
              zIndex: 50
            }}
          >
            <div style={{ maxWidth: 680, lineHeight: 1.5, marginBottom: 28 }}>
              <div style={{ fontSize: 18, marginBottom: 10 }}>
                Jeśli nie czujesz, że to dobry moment, zawsze możesz wrócić później.
              </div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>
                Jeśli chcesz kontynuować, dotknij ekranu.
              </div>
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


