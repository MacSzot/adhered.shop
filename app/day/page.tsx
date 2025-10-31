"use client";

import { useEffect, useRef, useState } from "react";

/** ===== Typ kroku dnia ===== */
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;     // dla VERIFY
  prompt?: string;     // dla SAY
  min_sentences?: number;
  starts_with?: string[];
  starts_with_any?: string[];
  prep_ms?: number;    // opóźnienie przed startem nasłuchu SAY
  dwell_ms?: number;   // ile trwa okno SAY
  note?: string;
};

/** ===== Pomocnicze ===== */
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

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

/** ===== Strona ===== */
export default function PrompterPage() {
  // Ustawienia / parametry dnia
  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "01") : "01";
  const dayFileParam = dayRaw.padStart(2, "0");
  const DAY_LABEL = (() => {
    const n = parseInt(dayRaw, 10);
    return Number.isNaN(n) ? dayRaw : String(n);
  })();

  // Limity / czasy
  const MAX_TIME = 6 * 60;            // cała sesja ~6 min
  const SPEAKING_FRAMES_REQUIRED = 2; // ile ramek „głosu” z rzędu
  const SILENCE_HINT_MS = 7000;       // po 7 s ciszy pokaż hint
  const HARD_CAP_MS = 12000;          // po 12 s wymuś „dalej” (w kroku)
  const ADVANCE_AFTER_SPEAK_MS = 4000;// VERIFY: 4 s po głosie → „dalej”

  // Stan programu
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);

  // Kamera / audio / VAD
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [levelPct, setLevelPct] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const speakingFramesRef = useRef(0);
  const heardThisStepRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  // Transkrypcja „SAY”
  const [sayTranscript, setSayTranscript] = useState<string>("");
  const sayActiveRef = useRef(false);
  const recognitionRef = useRef<any>(null);

  // Timer sesji
  const endAtRef = useRef<number | null>(null);
  const countdownIdRef = useRef<number | null>(null);

  // Timery kroków
  const stepTimerRef = useRef<number | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  const silenceHintTimerRef = useRef<number | null>(null);
  const hardCapTimerRef = useRef<number | null>(null);

  // Lusterko
  const [mirror] = useState(true);

  // Przypominajki: 1 → 2 → 3 (po 3 wymagamy dotyku; potem już nigdy nie pokazujemy)
  const [hintStage, setHintStage] = useState<0 | 1 | 2 | 3>(0);
  const hintsDisabledRef = useRef(false);
  const [tapToContinueVisible, setTapToContinueVisible] = useState(false);

  // Refy aktualnych wartości
  const isRunningRef = useRef(isRunning);
  const idxRef = useRef(idx);
  const stepsRef = useRef<PlanStep[]>([]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  /** Wczytaj plan dnia */
  useEffect(() => {
    (async () => {
      try {
        const { source, steps } = await loadDayPlanOrTxt(dayFileParam);
        setSteps(steps);
        setIdx(0);
        setDisplayText(steps[0]?.mode === "VERIFY" ? (steps[0]?.target || "") : (steps[0]?.prompt || ""));
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

  /** Start / stop sesji */
  const startSession = async () => {
    if (!stepsRef.current.length) return;
    const ok = await startAV();
    if (!ok) { setIsRunning(false); return; }
    setIsRunning(true);
    startCountdown(MAX_TIME);
    hintsDisabledRef.current = false;
    setHintStage(0);
    setTapToContinueVisible(false);
    setIdx(0);
    setDisplayText(
      stepsRef.current[0]?.mode === "VERIFY"
        ? (stepsRef.current[0]?.target || "")
        : (stepsRef.current[0]?.prompt || "")
    );
    runStep(0);
  };

  const stopSession = () => {
    setIsRunning(false);
    stopCountdown();
    clearStepTimers();
    stopSayCapture();
    stopAV();
    setLevelPct(0);
    setHintStage(0);
    setTapToContinueVisible(false);
  };

  /** Kamera + VAD */
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
        await ac.resume().catch(() => {});
        const resumeOnTap = () => ac.resume().catch(() => {});
        document.addEventListener("touchstart", resumeOnTap, { once: true });
        document.addEventListener("click", resumeOnTap, { once: true });
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

          // jeśli ktoś mówi – nie pokazujemy przypominajek
          if (!hintsDisabledRef.current) setHintStage(0);

          if (speakingFramesRef.current >= SPEAKING_FRAMES_REQUIRED) {
            const s = stepsRef.current[idxRef.current];
            // VERIFY: po pierwszym głosie odlicz 4 s i przejdź dalej
            if (s?.mode === "VERIFY" && !heardThisStepRef.current) {
              heardThisStepRef.current = true;
              clearOnly(["silence", "hard"]);
              const thisIdx = idxRef.current;
              if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
              advanceTimerRef.current = window.setTimeout(() => {
                if (idxRef.current === thisIdx) gotoNext(thisIdx);
              }, ADVANCE_AFTER_SPEAK_MS);
            }
          }
        } else {
          speakingFramesRef.current = 0;
        }

        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      return true;
    } catch (err: any) {
      console.error("getUserMedia error:", err);
      setMicError(err?.name === "NotAllowedError"
        ? "Brak zgody na mikrofon/kamerę."
        : "Nie udało się uruchomić mikrofonu/kamery.");
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

  /** Web Speech API – SAY */
  function startSayCapture() {
    sayActiveRef.current = true;
    setSayTranscript("");
    stopSayCapture(); // safety

    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!SR) {
      console.warn("Web Speech API niedostępne.");
      return;
    }
    const rec = new SR();
    recognitionRef.current = rec;

    rec.lang = "pl-PL";
    rec.continuous = true;
    rec.interimResults = true;

    let buffer = "";

    rec.onresult = (e: any) => {
      let interim = "";
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      const composed = (buffer + finalText + interim).trim();
      setSayTranscript(composed);
      if (finalText) buffer += finalText + " ";
    };

    rec.onerror = (err: any) => {
      console.warn("SpeechRecognition error:", err?.error || err);
    };

    rec.onend = () => {
      if (sayActiveRef.current) {
        try { rec.start(); } catch {}
      }
    };

    try { rec.start(); } catch (e) { console.warn("SpeechRecognition start error:", e); }
  }

  function stopSayCapture() {
    sayActiveRef.current = false;
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.onend = null; rec.stop(); } catch {}
    }
    recognitionRef.current = null;
  }

  /** Licznik sesji */
  function startCountdown(seconds: number) {
    stopCountdown();
    endAtRef.current = Date.now() + seconds * 1000;
    setRemaining(Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000)));
    countdownIdRef.current = window.setInterval(() => {
      if (!endAtRef.current) return;
      const secs = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0) {
        // Hard finish
        stopSayCapture();
        setTapToContinueVisible(false);
        setHintStage(0);
        setIsRunning(false);
        stopAV();
      }
    }, 250);
  }

  function stopCountdown() {
    if (countdownIdRef.current) {
      window.clearInterval(countdownIdRef.current);
      countdownIdRef.current = null;
    }
    endAtRef.current = null;
  }

  /** Timery kroków */
  function clearOnly(which: Array<"step"|"advance"|"silence"|"hard">) {
    for (const w of which) {
      if (w === "step" && stepTimerRef.current) { window.clearTimeout(stepTimerRef.current); stepTimerRef.current = null; }
      if (w === "advance" && advanceTimerRef.current) { window.clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null; }
      if (w === "silence" && silenceHintTimerRef.current) { window.clearTimeout(silenceHintTimerRef.current); silenceHintTimerRef.current = null; }
      if (w === "hard" && hardCapTimerRef.current) { window.clearTimeout(hardCapTimerRef.current); hardCapTimerRef.current = null; }
    }
  }
  function clearStepTimers() { clearOnly(["step","advance","silence","hard"]); }

  function scheduleSilenceAndHard(i: number) {
    // Przypominajki (tylko jeśli nie wyłączone po 3 etapie)
    if (!hintsDisabledRef.current) {
      clearOnly(["silence"]);
      silenceHintTimerRef.current = window.setTimeout(() => {
        if (idxRef.current !== i) return;
        setHintStage(prev => {
          if (prev >= 3) return 3;
          const next = (prev + 1) as 1 | 2 | 3;
          if (next === 3) {
            // trzeci hint → pokaż „dotknij ekranu”
            setTapToContinueVisible(true);
          }
          return next;
        });
      }, SILENCE_HINT_MS);
    }

    // Wymuś przejście kroku po HARD_CAP_MS, ale
    // jeśli aktywny jest etap 3 i czekamy na dotyk — NIE wymuszaj automatu
    clearOnly(["hard"]);
    hardCapTimerRef.current = window.setTimeout(() => {
      if (idxRef.current !== i) return;
      if (tapToContinueVisible) return; // czekamy na dotyk przy 3 etapie
      stopSayCapture();
      gotoNext(i);
    }, HARD_CAP_MS);
  }

  /** Uruchom krok i */
  function runStep(i: number) {
    if (!stepsRef.current.length) return;
    const s = stepsRef.current[i];
    if (!s) return;

    clearStepTimers();
    heardThisStepRef.current = false;
    speakingFramesRef.current = 0;
    setHintStage(0);
    setTapToContinueVisible(false);

    if (s.mode === "VERIFY") {
      stopSayCapture();
      setSayTranscript("");
      setDisplayText(s.target || "");
      scheduleSilenceAndHard(i);
    } else {
      const prep = Number(s.prep_ms ?? 1200);
      const dwell = Number(s.dwell_ms ?? 12000);

      stopSayCapture();
      setDisplayText(s.prompt || "");
      setSayTranscript("");

      // od razu odpalamy liczniki przypominajek / hard-cap
      scheduleSilenceAndHard(i);

      // po prep start rozpoznawania
      stepTimerRef.current = window.setTimeout(() => {
        if (idxRef.current !== i) return;
        startSayCapture();
        // po dwell kończymy SAY
        stepTimerRef.current = window.setTimeout(() => {
          if (idxRef.current !== i) return;
          stopSayCapture();
          gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearStepTimers();
    setTapToContinueVisible(false);
    setHintStage(0);
    stopSayCapture();

    const next = (i + 1) % stepsRef.current.length;
    setIdx(next);
    const s = stepsRef.current[next];
    setDisplayText(s?.mode === "VERIFY" ? (s?.target || "") : (s?.prompt || ""));
    runStep(next);
  }

  /** Obsługa dotyku przy 3. przypominajce */
  function handleTapToContinue() {
    if (!tapToContinueVisible) return;
    setTapToContinueVisible(false);
    setHintStage(0);
    // od teraz nie pokazujemy już przypominajek
    hintsDisabledRef.current = true;
  }

  /** Render */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const isSay = steps[idx]?.mode === "SAY";

  return (
    <main style={styles.container}>
      {/* Topbar */}
      <header style={styles.topbar}>
        <nav style={styles.tabs}>
          <a href="/day" aria-current="page" style={{ ...styles.tab, ...styles.tabActive }}>Prompter</a>
          <span aria-disabled="true" title="Wkrótce" style={{ ...styles.tab, opacity: 0.5 }}>Rysownik</span>
        </nav>

        <div style={styles.topInfo}>
          <span><b>Użytkownik:</b> {USER_NAME}</span>
          <span style={{ opacity: 0.65, margin: "0 8px" }}>•</span>
          <span><b>Dzień programu:</b> {DAY_LABEL}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {!isRunning ? (
            <button style={styles.btn} onClick={startSession}>Start</button>
          ) : (
            <button style={{ ...styles.btn, background: "rgba(255,80,80,0.25)" }} onClick={stopSession}>Stop</button>
          )}
        </div>
      </header>

      {/* Zegar – zawsze u góry, centralnie */}
      <div style={styles.timerTop}>{fmt(remaining)}</div>

      {/* Scena */}
      <div style={{ ...styles.stage, ...(mirror ? styles.mirrored : {}) }} onClick={handleTapToContinue} onTouchStart={handleTapToContinue}>
        <video ref={videoRef} autoPlay playsInline muted style={styles.cam} />

        {/* Intro (przed startem) */}
        {!isRunning && (
          <div style={styles.overlay}>
            <div style={styles.introBox}>
              <p style={styles.introP}>
                Twoja sesja potrwa około <b>6 minut</b>.
              </p>
              <p style={{ ...styles.introP, marginTop: 10 }}>
                Prosimy o powtarzanie na głos wyświetlanych treści.
              </p>
              <p style={{ ...styles.introP, marginTop: 10 }}>
                Aktywowano analizator dźwięku <b>MeRoar™</b>.
              </p>
              {micError && (
                <p style={{ marginTop: 14, color: "#ffb3b3", fontSize: 14, textAlign: "center" }}>
                  {micError}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Sesja */}
        {isRunning && (
          <div style={styles.overlay}>
            {/* Transkrypt u góry (bez tła) */}
            {isSay && (
              <div style={styles.transcriptTop}>
                {sayTranscript}
              </div>
            )}

            {/* Tekst główny – ścisły środek ekranu */}
            <div style={styles.centerText}>
              {displayText}
            </div>

            {/* Przypominajki – pojawiają się na środku dolnej części, po 7 s ciszy.
                1: "Jeśli możesz, postaraj się przeczytać na głos"
                2: "Pamiętaj — to przestrzeń pełna szacunku do Ciebie"
                3: "Jeśli chcesz kontynuować, dotknij ekranu" */}
            {hintStage > 0 && !hintsDisabledRef.current && (
              <div style={styles.hint}>
                {HINTS[hintStage]}
              </div>
            )}

            {/* „Dotknij ekranu” – aktywne tylko przy etapie 3; po dotyku wyłączamy przypominajki do końca sesji */}
            {tapToContinueVisible && (
              <div style={styles.tapOverlay}>
                <div style={styles.tapOverlayInner}>Dotknij ekranu, aby kontynuować</div>
              </div>
            )}
          </div>
        )}

        {/* VU-meter po prawej */}
        <div style={styles.vuWrap}>
          <div style={{ ...styles.vuFill, height: `${levelPct}%` }} />
        </div>
      </div>
    </main>
  );
}

/** ===== Stałe tekstów ===== */
const HINTS: Record<1 | 2 | 3, string> = {
  1: "Jeśli możesz, postaraj się przeczytać na głos.",
  2: "Pamiętaj — to przestrzeń pełna szacunku do Ciebie.",
  3: "Jeśli chcesz kontynuować, dotknij ekranu.",
};

/** ===== Style (prosto i bezpiecznie) ===== */
const styles: Record<string, React.CSSProperties> = {
  container: { position: "fixed", inset: 0, background: "black", color: "white", fontFamily: "system-ui, Inter, Arial, sans-serif" },

  topbar: {
    position: "fixed",
    top: 0, left: 0, right: 0,
    height: 54,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 12px",
    background: "linear-gradient(to bottom, rgba(0,0,0,0.7), rgba(0,0,0,0))",
    zIndex: 50,
  },

  tabs: { display: "flex", alignItems: "center", gap: 10 },
  tab: { fontSize: 14, textDecoration: "none", color: "white", padding: "6px 10px", borderRadius: 8, opacity: 0.9 } as React.CSSProperties,
  tabActive: { background: "rgba(255,255,255,0.12)" },

  topInfo: { display: "flex", alignItems: "center", gap: 4, fontSize: 14, opacity: 0.95 },

  btn: {
    padding: "8px 14px",
    borderRadius: 10,
    background: "rgba(255,255,255,0.15)",
    color: "white",
    border: "1px solid rgba(255,255,255,0.25)",
    cursor: "pointer",
    fontSize: 14,
  },

  timerTop: {
    position: "fixed",
    top: 58, left: 0, right: 0,
    textAlign: "center",
    fontWeight: 600,
    fontSize: 18,
    letterSpacing: 0.5,
    zIndex: 40,
    textShadow: "0 1px 2px rgba(0,0,0,0.6)",
    pointerEvents: "none",
  },

  stage: { position: "absolute", inset: 0, overflow: "hidden" },
  mirrored: { transform: "scaleX(-1)" },
  cam: { width: "100%", height: "100%", objectFit: "cover" },

  overlay: {
    position: "absolute", inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 16px",
  },

  // Intro – węższa kolumna, środek
  introBox: {
    maxWidth: 520,
    textAlign: "center",
    lineHeight: 1.55,
    fontSize: 16,
    opacity: 0.95,
  },
  introP: { margin: "0.25rem 0" },

  // Główny tekst – idealny środek
  centerText: {
    position: "absolute",
    top: "50%", left: "50%",
    transform: "translate(-50%, -50%)",
    maxWidth: 700,
    padding: "0 12px",
    textAlign: "center",
    fontSize: 22,
    lineHeight: 1.5,
    textShadow: "0 1px 2px rgba(0,0,0,0.6)",
    whiteSpace: "pre-wrap",
  },

  // Transkrypt u góry (bez tła)
  transcriptTop: {
    position: "absolute",
    top: 106, left: 0, right: 0,
    textAlign: "center",
    fontSize: 18,
    fontWeight: 500,
    minHeight: 26,
    padding: "0 12px",
    textShadow: "0 1px 2px rgba(0,0,0,0.45)",
    whiteSpace: "pre-wrap",
  },

  // Przypominajka ~dolna część środka
  hint: {
    position: "absolute",
    bottom: 72, left: 0, right: 0,
    textAlign: "center",
    fontSize: 16,
    lineHeight: 1.35,
    color: "rgba(255,255,255,0.95)",
    textShadow: "0 1px 2px rgba(0,0,0,0.6)",
    pointerEvents: "none",
  },

  // Overlay dotyku przy 3. przypominajce
  tapOverlay: {
    position: "absolute", inset: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(0,0,0,0.25)",
  },
  tapOverlayInner: {
    fontSize: 16,
    padding: "10px 14px",
    borderRadius: 10,
    background: "rgba(0,0,0,0.35)",
    border: "1px solid rgba(255,255,255,0.25)",
  },

  // VU po prawej
  vuWrap: {
    position: "absolute",
    top: 70, bottom: 20, right: 10,
    width: 8,
    borderRadius: 6,
    background: "rgba(255,255,255,0.09)",
    overflow: "hidden",
  },
  vuFill: {
    position: "absolute",
    left: 0, bottom: 0, right: 0,
    background: "rgba(255,255,255,0.85)",
    transition: "height 120ms linear",
  },
};
