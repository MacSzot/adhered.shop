"use client";

import React, { useEffect, useRef, useState } from "react";

/* ===================== TYPES ===================== */
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;           // VERIFY: tekst do powtórzenia
  prompt?: string;           // SAY: pytanie / komenda
  min_sentences?: number;
  starts_with?: string[];
  starts_with_any?: string[];
  prep_ms?: number;          // czas na przeczytanie pytania
  dwell_ms?: number;         // czas aktywnego okna mówienia
  note?: string;
};

/* ===================== HELPERS ===================== */
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
  // fallback .txt -> linia = VERIFY
  const r2 = await fetch(`/days/${dayFileParam}.txt`, { cache: "no-store" });
  if (!r2.ok) throw new Error(`Brak pliku dnia: ${dayFileParam}.plan.json i ${dayFileParam}.txt`);
  const txt = await r2.text();
  const steps: PlanStep[] = txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => ({ mode: "VERIFY" as const, target: line }));
  return { source: "txt", steps };
}

/* ===================== PAGE ===================== */
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // ——— USTAWIENIA ———
  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "01") : "01";
  const dayFileParam = dayRaw.padStart(2, "0"); // 01..11 do nazw plików
  const DAY_LABEL = (() => {
    const n = parseInt(dayRaw, 10);
    return Number.isNaN(n) ? dayRaw : String(n); // UI: bez wiodącego zera
  })();

  const MAX_TIME = 6 * 60; // 6 minut (twardy limit sesji)

  // ——— progi VAD / timery ———
  const SPEAKING_FRAMES_REQUIRED = 2;
  const SILENCE_STEP_MS = 7000;      // co 7 s eskalacja
  const HARD_CAP_STEP_MS = 12000;    // twardy limit kroku
  const ADVANCE_AFTER_SPEAK_MS = 4000; // VERIFY → 4 s po wykryciu głosu

  // ——— STANY ———
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);

  const [levelPct, setLevelPct] = useState(0);
  const [mirror] = useState(true);
  const [micError, setMicError] = useState<string | null>(null);

  // 3-stopniowa przypominajka: 0 (brak) → 1 → 2 → 3 (STOP & tap to resume)
  const [hintStage, _setHintStage] = useState<0 | 1 | 2 | 3>(0);
  const hintStageRef = useRef<0 | 1 | 2 | 3>(0);
  const setHintStage = (v: 0 | 1 | 2 | 3) => {
    hintStageRef.current = v;
    _setHintStage(v);
  };
  const [pausedForHint, setPausedForHint] = useState(false);

  const [speakingBlink, setSpeakingBlink] = useState(false);

  // SAY: transkrypt
  const [sayTranscript, setSayTranscript] = useState<string>("");
  const sayActiveRef = useRef(false);
  const recognitionRef = useRef<any>(null); // webkitSpeechRecognition

  // refy aktualnych wartości
  const isRunningRef = useRef(isRunning);
  const idxRef = useRef(idx);
  const stepsRef = useRef<PlanStep[]>([]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  // ——— TIMER SESJI (twarde 6 min) ———
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
      if (secs <= 0) hardFinishSession();
    }, 250);
  }
  function stopCountdown() {
    if (countdownIdRef.current) {
      clearInterval(countdownIdRef.current);
      countdownIdRef.current = null;
    }
    endAtRef.current = null;
  }

  // ——— Timery / RAF ———
  const stepTimerRef = useRef<number | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  const silenceHint1Ref = useRef<number | null>(null);
  const silenceHint2Ref = useRef<number | null>(null);
  const silenceHint3Ref = useRef<number | null>(null);
  const hardCapTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // ——— Audio / VAD ———
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const heardThisStepRef = useRef(false);
  const speakingFramesRef = useRef(0);

  /* ========== 1) WCZYTANIE PLANU DNIA ========== */
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

  /* ========== 2) START/STOP AV + VAD ========== */
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
        if (!analyserRef.current || !isRunningRef.current || pausedForHint) return;
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

        setLevelPct((prev) => Math.max(vu, prev * 0.85));

        const speakingNow = rms > 0.017 || peak > 0.040 || vu > 7;
        if (speakingNow) {
          speakingFramesRef.current += 1;

          // schowaj hint od razu kiedy słychać głos
          if (hintStageRef.current > 0) setHintStage(0);

          if (speakingFramesRef.current >= SPEAKING_FRAMES_REQUIRED) {
            setSpeakingBlink(true);
            const s = stepsRef.current[idxRef.current];

            // VERIFY: pierwsza mowa → odlicz 4s i next
            if (s?.mode === "VERIFY" && !heardThisStepRef.current) {
              heardThisStepRef.current = true;
              clearSilenceTimers();
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

        window.setTimeout(() => setSpeakingBlink(false), 120);
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      return true;
    } catch (err: any) {
      console.error("getUserMedia error:", err);
      setMicError(
        err?.name === "NotAllowedError"
          ? "Brak zgody na mikrofon/kamerę."
          : "Nie udało się uruchomić mikrofonu/kamery."
      );
      return false;
    }
  }

  function stopAV() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {}
      audioCtxRef.current = null;
    }
  }

  /* ========== 3) WEB SPEECH (SAY) ========== */
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
      if (composed && hintStageRef.current > 0) setHintStage(0);
      if (finalText) buffer += finalText + " ";
    };

    rec.onerror = (err: any) => {
      console.warn("SpeechRecognition error:", err?.error || err);
    };

    rec.onend = () => {
      if (sayActiveRef.current && !pausedForHint) {
        try { rec.start(); } catch {}
      }
    };

    try { rec.start(); } catch (e) { console.warn("SR start error", e); }
  }

  function stopSayCapture() {
    sayActiveRef.current = false;
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.onend = null; rec.stop(); } catch {}
    }
    recognitionRef.current = null;
  }

  /* ========== 4) TIMERY KROKU / HINTY ========== */
  function clearSilenceTimers() {
    if (silenceHint1Ref.current) { clearTimeout(silenceHint1Ref.current); silenceHint1Ref.current = null; }
    if (silenceHint2Ref.current) { clearTimeout(silenceHint2Ref.current); silenceHint2Ref.current = null; }
    if (silenceHint3Ref.current) { clearTimeout(silenceHint3Ref.current); silenceHint3Ref.current = null; }
  }
  function clearStepTimers() {
    if (stepTimerRef.current) { clearTimeout(stepTimerRef.current); stepTimerRef.current = null; }
    if (advanceTimerRef.current) { clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null; }
    if (hardCapTimerRef.current) { clearTimeout(hardCapTimerRef.current); hardCapTimerRef.current = null; }
    clearSilenceTimers();
  }

  // 3-stopniowa eskalacja ciszy
  function armSilenceEscalation(i: number) {
    clearSilenceTimers();
    setHintStage(0);

    silenceHint1Ref.current = window.setTimeout(() => {
      if (idxRef.current === i && !pausedForHint) setHintStage(1);
    }, SILENCE_STEP_MS);

    silenceHint2Ref.current = window.setTimeout(() => {
      if (idxRef.current === i && !pausedForHint) setHintStage(2);
    }, SILENCE_STEP_MS * 2);

    silenceHint3Ref.current = window.setTimeout(() => {
      if (idxRef.current === i && !pausedForHint) {
        setHintStage(3);
        setPausedForHint(true);
        // zatrzymaj nasłuchiwanie i czekaj na tap
        stopSayCapture();
      }
    }, SILENCE_STEP_MS * 3);
  }

  function scheduleHardCap(i: number) {
    if (hardCapTimerRef.current) clearTimeout(hardCapTimerRef.current);
    hardCapTimerRef.current = window.setTimeout(() => {
      if (idxRef.current === i) {
        setHintStage(0);
        stopSayCapture();
        gotoNext(i);
      }
    }, HARD_CAP_STEP_MS);
  }

  /* ========== 5) URUCHOMIENIE KROKU ========== */
  function runStep(i: number) {
    if (!stepsRef.current.length) return;
    const s = stepsRef.current[i];
    if (!s) return;

    clearStepTimers();
    heardThisStepRef.current = false;
    speakingFramesRef.current = 0;
    setHintStage(0);
    setPausedForHint(false);

    if (s.mode === "VERIFY") {
      stopSayCapture();
      setSayTranscript("");
      setDisplayText(s.target || "");

      armSilenceEscalation(i);
      scheduleHardCap(i);
    } else {
      const prep = Number(s.prep_ms ?? 1200);
      const dwell = Number(s.dwell_ms ?? 12000);

      stopSayCapture();
      setSayTranscript("");
      setDisplayText(s.prompt || "");

      armSilenceEscalation(i);
      scheduleHardCap(i);

      stepTimerRef.current = window.setTimeout(() => {
        if (idxRef.current !== i || pausedForHint) return;
        startSayCapture();

        stepTimerRef.current = window.setTimeout(() => {
          if (idxRef.current !== i) return;
          stopSayCapture();
          setHintStage(0);
          gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearStepTimers();
    setHintStage(0);
    stopSayCapture();
    const next = (i + 1) % stepsRef.current.length;
    setIdx(next);
    const n = stepsRef.current[next];
    setDisplayText(n?.mode === "VERIFY" ? (n?.target || "") : (n?.prompt || ""));
    runStep(next);
  }

  /* ========== 6) START/STOP SESJI ========== */
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
    setHintStage(0);
    setPausedForHint(false);
  };

  function hardFinishSession() {
    // kończymy łagodnie: zatrzymanie + komunikat
    stopSession();
    alert("To koniec dzisiejszej sesji. Jeśli chcesz – możesz jeszcze chwilę pobyć ze sobą i dokończyć myśl.");
  }

  // tap po 3. przypomnieniu
  function handleTapToResume() {
    if (!pausedForHint) return;
    setPausedForHint(false);
    setHintStage(0);
    // wracamy do bieżącego kroku
    runStep(idxRef.current);
  }

  /* ========== 7) RENDER ========== */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // wspólne style
  const safeBottom = "calc(env(safe-area-inset-bottom, 0px) + 16px)";

  const overlayWrap: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
    pointerEvents: pausedForHint ? "auto" : "none", // przy 3. podniesiemy pointerEvents na kontenerze z komunikatem
  };

  const centerBlock: React.CSSProperties = {
    maxWidth: 740,
    width: "100%",
    textAlign: "center",
    lineHeight: 1.4,
    // lekki panel dla czytelności
    background: "rgba(0,0,0,0.22)",
    borderRadius: 14,
    backdropFilter: "blur(1.5px)",
    padding: "14px 16px",
  };

  const verifyTextStyle: React.CSSProperties = {
    whiteSpace: "pre-wrap",
    fontSize: 20,
    letterSpacing: 0.2,
  };

  const questionStyle: React.CSSProperties = {
    fontSize: 18,
    lineHeight: 1.45,
    marginBottom: 10,
  };

  const transcriptStyle: React.CSSProperties = {
    fontSize: 18,
    minHeight: 28,
    padding: "8px 10px",
    background: "rgba(0,0,0,0.28)",
    borderRadius: 10,
  };

  const hintBase: React.CSSProperties = {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: safeBottom,
    textAlign: "center",
    fontSize: 15,
    lineHeight: 1.35,
    color: "rgba(255,255,255,0.96)",
    textShadow: "0 1px 2px rgba(0,0,0,0.55)",
    transition: "opacity 180ms ease",
    pointerEvents: "none",
  };

  const hintText =
    hintStage === 1
      ? "Czy możesz powiedzieć coś na głos?"
      : hintStage === 2
      ? "Pamiętaj, to przestrzeń pełna szacunku do Ciebie."
      : hintStage === 3
      ? "Jeśli potrzebujesz chwili dla siebie, możesz wrócić później.\nJeśli chcesz kontynuować, dotknij ekranu."
      : "";

  const isSay = steps[idx]?.mode === "SAY";

  return (
    <main className="prompter-full" style={{ position: "relative", height: "100dvh", background: "black" }}>
      {/* Top bar */}
      <header className="topbar topbar--dense" style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "10px 12px", zIndex: 20 }}>
        <nav className="tabs" style={{ display: "flex", gap: 8 }}>
          <a className="tab active" href="/day" aria-current="page" style={{ opacity: 0.95 }}>Prompter</a>
          <span className="tab disabled" aria-disabled="true" title="Wkrótce" style={{ opacity: 0.5 }}>Rysownik</span>
        </nav>
        <div className="top-info compact" style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
          <span className="meta"><b>Użytkownik:</b> {USER_NAME}</span>
          <span className="dot">•</span>
          <span className="meta"><b>Dzień programu:</b> {DAY_LABEL}</span>
        </div>
        <div className="controls-top" style={{ position: "absolute", top: 10, right: 12 }}>
          {!isRunning ? (
            <button className="btn" onClick={startSession}>Start</button>
          ) : (
            <button className="btn" onClick={stopSession}>Stop</button>
          )}
        </div>
      </header>

      {/* Timer */}
      <div className="timer-top timer-top--strong" style={{
        position: "absolute", top: 64, left: 0, right: 0, textAlign: "center", fontSize: 44, fontWeight: 800, letterSpacing: 1, zIndex: 10
      }}>
        {fmt(remaining)}
      </div>

      {/* Kamera */}
      <div className={`stage ${mirror ? "mirrored" : ""}`} style={{ position: "absolute", inset: 0 }}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" style={{
          width: "100%", height: "100%", objectFit: "cover", transform: mirror ? "scaleX(-1)" : undefined
        }} />
      </div>

      {/* Ekran startowy */}
      {!isRunning && (
        <div className="overlay center" style={overlayWrap}>
          <div style={{ ...centerBlock, pointerEvents: "auto" }}>
            <p style={{ fontSize: 16, opacity: 0.92 }}>
              Twoja sesja potrwa około <b>6 minut</b>.<br />
              Powtarzaj <b>wyraźnie</b> i odpowiadaj <b>na głos</b>.
            </p>
            <p style={{ marginTop: 8, fontSize: 15, opacity: 0.9 }}>
              Aktywowano system analizy głosu <b>MeRoar™</b>
            </p>
            {/* jeśli wrzucisz plik do /public/assets/meroar-supervised.png, możesz go też pokazać: */}
            {/* <img src="/assets/meroar-supervised.png" alt="Super-vised by MeRoar / supervised by adhered." style={{ marginTop: 10, width: "100%", maxWidth: 420 }} /> */}
            {micError && (
              <p style={{ marginTop: 12, color: "#ffb3b3", fontSize: 14 }}>
                {micError} — sprawdź dostęp do mikrofonu i kamery.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Overlay treści – ZAWSZE centralnie, zwarto */}
      {isRunning && (
        <div
          className="overlay running"
          style={overlayWrap}
          onClick={pausedForHint && hintStage === 3 ? handleTapToResume : undefined}
        >
          <div style={{ ...centerBlock, pointerEvents: pausedForHint ? "auto" : "none" }}>
            {/* VERIFY */}
            {steps[idx]?.mode === "VERIFY" && (
              <div style={verifyTextStyle}>{displayText}</div>
            )}

            {/* SAY */}
            {isSay && (
              <>
                <div style={questionStyle}>{displayText}</div>
                <div style={transcriptStyle}>{sayTranscript}</div>
              </>
            )}
          </div>

          {/* 3-stopniowe przypomnienie (pozycja przy dolnej krawędzi, ale ponad safe-area) */}
          {!!hintStage && !pausedForHint && (
            <div style={{ ...hintBase, opacity: 1, whiteSpace: "pre-wrap" }}>{hintText}</div>
          )}

          {/* Po 3. – pełnoekranowy overlay „tap, by kontynuować” */}
          {pausedForHint && hintStage === 3 && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 16,
                background: "rgba(0,0,0,0.45)",
                backdropFilter: "blur(1.5px)",
                pointerEvents: "auto",
              }}
            >
              <div
                style={{
                  maxWidth: 740,
                  width: "100%",
                  textAlign: "center",
                  lineHeight: 1.45,
                  background: "rgba(0,0,0,0.35)",
                  borderRadius: 14,
                  padding: "16px 18px",
                }}
              >
                <div style={{ whiteSpace: "pre-wrap", fontSize: 16 }}>{hintText}</div>
                <div style={{ marginTop: 10, fontSize: 14, opacity: 0.9 }}>(Dotknij ekranu, aby kontynuować)</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* VU-meter (prawa krawędź) */}
      <div className="meter-vertical" style={{ position: "absolute", top: 80, bottom: 20, right: 8, width: 6, background: "rgba(255,255,255,0.12)", borderRadius: 3 }}>
        <div className="meter-vertical-fill" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: `${levelPct}%`, background: "rgba(46,207,116,0.9)", borderRadius: 3 }} />
        {speakingBlink && (
          <div style={{ position: "absolute", left: -2, right: -2, bottom: 4, textAlign: "center", fontSize: 10, opacity: 0.7 }}>●</div>
        )}
      </div>
    </main>
  );
}
