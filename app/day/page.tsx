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
  prep_ms?: number;
  dwell_ms?: number;
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
  const SILENCE_HINT_MS = 7000;   // hint po 7 s ciszy
  const HARD_CAP_MS = 12000;      // auto-next po 12 s (VERIFY i SAY)
  const ADVANCE_AFTER_SPEAK_MS = 4000; // VERIFY: 4 s po mowie

  // Stany
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);
  const [micError, setMicError] = useState<string | null>(null);
  const [showSilenceHint, _setShowSilenceHint] = useState(false);
  const showSilenceHintRef = useRef(false);
  const setShowSilenceHint = (v: boolean) => { showSilenceHintRef.current = v; _setShowSilenceHint(v); };
  const [speakingBlink, setSpeakingBlink] = useState(false);

  // SAY – transkrypt pod pytaniem
  const [sayTranscript, setSayTranscript] = useState<string>("");
  const sayActiveRef = useRef(false);

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
  const silenceHintTimerRef = useRef<number | null>(null);
  const hardCapTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // AV
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const heardThisStepRef = useRef(false);
  const speakingFramesRef = useRef(0);

  /* ---- 1) Wczytaj plan ---- */
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

  /* ================= WHISPER: utils & refs ================= */
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const transcribingRef = useRef(false);

  function pickAudioMime(): string {
    if (typeof MediaRecorder !== "undefined") {
      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
      if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
      if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
      if (MediaRecorder.isTypeSupported("audio/ogg")) return "audio/ogg";
    }
    return "";
  }

  async function transcribeBlob(blob: Blob) {
    try {
      transcribingRef.current = true;
      if (!sayTranscript) setSayTranscript("…");
      const fd = new FormData();
      // KLUCZ "audio" zgodny z backendem /api/whisper
      fd.append("audio", blob, "clip.webm");

      const r = await fetch("/api/whisper", { method: "POST", body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${r.status}`);
      }
      const j = await r.json();
      setSayTranscript(String(j?.text || "").trim());
    } catch (e: any) {
      console.error("transcribeBlob error:", e);
      setSayTranscript("(transkrypcja niedostępna)");
    } finally {
      transcribingRef.current = false;
    }
  }

  function startSayCapture() {
    if (!streamRef.current) {
      setSayTranscript("(brak aktywnego mikrofonu)");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setSayTranscript("(nagrywanie niedostępne w tej przeglądarce)");
      return;
    }

    try {
      sayActiveRef.current = true;
      setSayTranscript("");
      chunksRef.current = [];

      const mime = pickAudioMime();
      const rec = new MediaRecorder(streamRef.current, mime ? { mimeType: mime } : undefined);
      mediaRecorderRef.current = rec;

      (rec as any).ondataavailable = (ev: any) => {
        const data: Blob = ev?.data;
        if (data && data.size > 0) chunksRef.current.push(data);
      };

      rec.onstop = async () => {
        try {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
          chunksRef.current = [];
          // ZAWSZE transkrybujemy po zakończeniu SAY
          await transcribeBlob(blob);
        } catch (e) {
          console.error("onstop/transcribe error:", e);
        }
      };

      rec.start(); // nagrywamy cały okres SAY (bez timeslice)
    } catch (e) {
      console.error("startSayCapture error:", e);
      setSayTranscript("(nagrywanie niedostępne)");
    }
  }

  function stopSayCapture() {
    try {
      sayActiveRef.current = false;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    } catch {}
  }

  /* ---- 2) Start/Stop AV ---- */
  async function startAV(): Promise<boolean> {
    stopAV();
    setMicError(null);
    speakingFramesRef.current = 0;

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
        try { await ac.resume(); } catch {}
        const onceWrapper = () => { ac.resume().catch(() => {}); document.removeEventListener("click", onceWrapper); };
        document.addEventListener("click", onceWrapper, { once: true });
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
            setSpeakingBlink(true);
            const s = stepsRef.current[idxRef.current];

            // VERIFY: przy pierwszym głosie uruchom 4s do next
            if (s?.mode === "VERIFY" && !heardThisStepRef.current) {
              heardThisStepRef.current = true;
              setShowSilenceHint(false);
              if (silenceHintTimerRef.current) window.clearTimeout(silenceHintTimerRef.current);
              if (hardCapTimerRef.current) window.clearTimeout(hardCapTimerRef.current);
              const thisIdx = idxRef.current;
              if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
              advanceTimerRef.current = window.setTimeout(() => {
                if (idxRef.current === thisIdx) gotoNext(thisIdx);
              }, ADVANCE_AFTER_SPEAK_MS);
            }

            // SAY: pierwszy głos gasi hint (nie wraca w tym kroku)
            if (s?.mode === "SAY") {
              setShowSilenceHint(false);
            }
          }
        } else {
          speakingFramesRef.current = 0;
        }

        window.setTimeout(() => setSpeakingBlink(false), 120);
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
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
  }

  /* ---- 3) Timery + kroki ---- */
  function clearStepTimers() {
    [stepTimerRef, advanceTimerRef, silenceHintTimerRef, hardCapTimerRef].forEach(ref => {
      if (ref.current) window.clearTimeout(ref.current);
      ref.current = null;
    });
  }

  function scheduleSilenceTimers(i: number) {
    // 7 s → pokaż hint (VERIFY lub SAY)
    silenceHintTimerRef.current = window.setTimeout(() => {
      if (idxRef.current === i) setShowSilenceHint(true);
    }, SILENCE_HINT_MS);
    // 12 s → wymuś przejście (VERIFY lub SAY)
    hardCapTimerRef.current = window.setTimeout(() => {
      if (idxRef.current === i) {
        setShowSilenceHint(false);
        stopSayCapture(); // bezpieczeństwo dla SAY
        gotoNext(i);
      }
    }, HARD_CAP_MS);
  }

  function runStep(i: number) {
    if (!stepsRef.current.length) return;
    const s = stepsRef.current[i];
    if (!s) return;

    clearStepTimers();
    heardThisStepRef.current = false;
    speakingFramesRef.current = 0;
    setShowSilenceHint(false);

    if (s.mode === "VERIFY") {
      setSayTranscript(""); // nic pod spodem
      setDisplayText(s.target || "");
      scheduleSilenceTimers(i);
    } else {
      const prep = Number(s.prep_ms ?? 2000);    // 2s na przeczytanie pytania
      const dwell = Number(s.dwell_ms ?? 12000); // 12s aktywnego okna

      setDisplayText(s.prompt || "");
      setSayTranscript("");

      // hint po 7s ciszy
      silenceHintTimerRef.current = window.setTimeout(() => {
        if (idxRef.current === i) setShowSilenceHint(true);
      }, SILENCE_HINT_MS);

      // po prep_ms start nasłuchu/transkrypcji
      stepTimerRef.current = window.setTimeout(() => {
        if (idxRef.current !== i) return;
        startSayCapture();

        // po dwell_ms kończymy SAY i przechodzimy dalej
        stepTimerRef.current = window.setTimeout(() => {
          if (idxRef.current !== i) return;
          stopSayCapture();
          setShowSilenceHint(false);
          gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearStepTimers();
    setShowSilenceHint(false);
    stopSayCapture(); // safety
    const next = (i + 1) % stepsRef.current.length;
    setIdx(next);
    const n = stepsRef.current[next];
    setDisplayText(n?.mode === "VERIFY" ? (n?.target || "") : (n?.prompt || ""));
    runStep(next);
  }

  /* ---- 4) Start/Stop sesji ---- */
  const startSession = async () => {
    if (!stepsRef.current.length) return;
    const ok = await startAV();
    if (!ok) { setIsRunning(false); return; }
    setIsRunning(true);
    startCountdown(MAX_TIME);
    setIdx(0);
    setDisplayText(stepsRef.current[0]?.mode === "VERIFY" ? (stepsRef.current[0].target || "") : (stepsRef.current[0]?.prompt || ""));
    runStep(0);
  };

  const stopSession = () => {
    setIsRunning(false);
    stopCountdown();
    clearStepTimers();
    stopSayCapture();
    stopAV();
    setLevelPct(0);
  };

  /* ---- 5) Render ---- */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <main className="prompter-full">
      <header className="topbar topbar--dense">
        <nav className="tabs">
          <a className="tab active" href="/day" aria-current="page">Prompter</a>
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

      <div className="timer-top timer-top--strong">{fmt(remaining)}</div>

      <div className={`stage ${mirror ? "mirrored" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* OVERLAY START */}
        {!isRunning && (
          <div className="overlay center">
            <div className="intro" style={{ textAlign: "center", maxWidth: 520, lineHeight: 1.6 }}>
              <p style={{ fontSize: 16, opacity: 0.9, lineHeight: 1.6 }}>
                Twoja sesja potrwa około <b>6 minut</b>.<br />
                Prosimy o <b>wyraźne powtarzanie</b> pojawiających się wyrazów.
              </p>

              <p style={{ marginTop: 10, fontSize: 15, opacity: 0.85 }}>
                Aktywowano system analizy dźwięku <b>MeRoar™</b>
              </p>

              {micError && (
                <p style={{ marginTop: 16, color: "#ffb3b3", fontSize: 14 }}>
                  {micError} — upewnij się, że przeglądarka ma dostęp do mikrofonu i kamery.
                </p>
              )}
            </div>
          </div>
        )}

        {/* OVERLAY SESJI */}
        {isRunning && (
          <div className="overlay center">
            {/* VERIFY = tekst do powtórzenia */}
            {steps[idx]?.mode === "VERIFY" && (
              <div className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
                {displayText}
              </div>
            )}

            {/* SAY = pytanie + transkrypt pod spodem + hint po 7 s */}
            {steps[idx]?.mode === "SAY" && (
              <div className="center-text fade" style={{ whiteSpace: "pre-wrap" }}>
                <div style={{ fontSize: 18, lineHeight: 1.5, maxWidth: 700, margin: "0 auto" }}>
                  {displayText}
                </div>

                <div
                  style={{
                    marginTop: 16,
                    fontSize: 17,
                    opacity: 0.96,
                    minHeight: 24,
                    textAlign: "center",
                  }}
                >
                  {sayTranscript}
                </div>

                {showSilenceHint && (
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: 56, // niżej, by nie nachodziło na pytanie
                      padding: "0 24px",
                      textAlign: "center",
                      fontSize: 16,
                      lineHeight: 1.35,
                      color: "rgba(255,255,255,0.95)",
                      textShadow: "0 1px 2px rgba(0,0,0,0.6)",
                      pointerEvents: "none",
                      transition: "opacity 200ms ease",
                    }}
                  >
                    Czy możesz powiedzieć coś na głos?
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* VU-meter */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
          {speakingBlink && (
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 4, textAlign: "center", fontSize: 10, opacity: 0.7 }}>
              ●
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
