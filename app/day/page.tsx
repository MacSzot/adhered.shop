"use client";

import { useEffect, useRef, useState } from "react";

/* =============== Typy =============== */
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;   // VERIFY: tekst do powtórzenia
  prompt?: string;   // SAY: pytanie/komenda
  prep_ms?: number;
  dwell_ms?: number;
};

/* =============== Ładowanie planu =============== */
async function loadDayPlanOrTxt(dayFileParam: string): Promise<PlanStep[]> {
  try {
    const r = await fetch(`/days/${dayFileParam}.plan.json`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j?.steps)) return j.steps as PlanStep[];
    }
  } catch {}
  const r2 = await fetch(`/days/${dayFileParam}.txt`, { cache: "no-store" });
  if (!r2.ok) return [{ mode: "VERIFY", target: "Brak treści dla tego dnia." }];
  const txt = await r2.text();
  return txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => ({ mode: "VERIFY" as const, target: line }));
}

/* =============== Helpers =============== */
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

/* =============== Strona =============== */
export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Parametry dnia
  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "03") : "03";
  const dayFileParam = dayRaw.padStart(2, "0");
  const DAY_LABEL = (() => {
    const n = parseInt(dayRaw, 10);
    return Number.isNaN(n) ? dayRaw : String(n);
  })();

  // Czas i progi
  const MAX_TIME_S = 6 * 60;                // 6 minut
  const SILENCE_HINT_MS = 7000;             // 7 s ciszy
  const HARD_CAP_MS = 12000;                // 12 s max na krok
  const VERIFY_NEXT_AFTER_VOICE_MS = 4000;  // 4 s po głosie

  // Przypominajka: JEDNA na całą sesję
  const REMINDER_TEXT = "Jeśli możesz, postaraj się przeczytać na głos";
  const reminderShownRef = useRef(false);

  // Stany
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME_S);
  const [micError, setMicError] = useState<string | null>(null);

  // HINT (pojawia się max raz)
  const [hint, setHint] = useState<string | null>(null);

  // VU
  const [levelPct, setLevelPct] = useState(0);

  // SAY – live transcript
  const [sayTranscript, setSayTranscript] = useState("");
  const recognitionRef = useRef<any>(null);
  const sayActiveRef = useRef(false);

  // AV / VAD
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const speakingFramesRef = useRef(0);
  const SPEAKING_FRAMES_REQUIRED = 2;

  // Refy bieżących
  const isRunningRef = useRef(false);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  const idxRef = useRef(0);
  useEffect(() => { idxRef.current = idx; }, [idx]);

  // Timery
  const stepTimerRef = useRef<number | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  const silenceHintTimerRef = useRef<number | null>(null);
  const hardCapTimerRef = useRef<number | null>(null);

  // Koniec sesji
  const [finished, setFinished] = useState(false);

  /* ---- 1) Wczytaj plan ---- */
  useEffect(() => {
    (async () => {
      const s = await loadDayPlanOrTxt(dayFileParam);
      setSteps(s);
      setIdx(0);
      const first = s[0];
      setDisplayText(first?.mode === "SAY" ? (first?.prompt || "") : (first?.target || ""));
    })();
  }, []);

  /* ---- 2) Licznik 6 min ---- */
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
    if (countdownIdRef.current) window.clearInterval(countdownIdRef.current);
    countdownIdRef.current = null;
    endAtRef.current = null;
  }

  /* ---- 3) AV + VAD ---- */
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
      analyser.smoothingTimeConstant = 0.88;
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
        const vu = Math.min(100, peak * 520);             // trochę żywszy wskaźnik
        setLevelPct(prev => Math.max(vu, prev * 0.85));

        // lekko niższe progi, by pewniej łapać szept
        const speakingNow = (rms > 0.012) || (peak > 0.030) || (vu > 5);
        if (speakingNow) {
          speakingFramesRef.current += 1;
          // chowamy ewentualny hint
          if (hint) setHint(null);

          if (speakingFramesRef.current >= SPEAKING_FRAMES_REQUIRED) {
            const s = steps[idxRef.current];
            if (s?.mode === "VERIFY") {
              if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
              const thisIdx = idxRef.current;
              advanceTimerRef.current = window.setTimeout(() => {
                if (idxRef.current === thisIdx) gotoNext(thisIdx);
              }, VERIFY_NEXT_AFTER_VOICE_MS);
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

  /* ---- 4) SAY (Web Speech API) ---- */
  function startSay() {
    sayActiveRef.current = true;
    setSayTranscript("");
    stopSay();

    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!SR) { console.warn("Web Speech API niedostępne."); return; }

    const rec = new SR();
    recognitionRef.current = rec;
    rec.lang = "pl-PL";
    rec.continuous = true;
    rec.interimResults = true;

    let buffer = "";
    rec.onresult = (e: any) => {
      let interim = "", finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      const composed = (buffer + finalText + interim).trim();
      setSayTranscript(composed);
      if (finalText) buffer += finalText + " ";
      if (composed) setHint(null);
    };
    rec.onerror = (err: any) => console.warn("SpeechRecognition error:", err?.error || err);
    rec.onend = () => { if (sayActiveRef.current) { try { rec.start(); } catch {} } };

    try { rec.start(); } catch (e) { console.warn("SpeechRecognition start error:", e); }
  }

  function stopSay() {
    sayActiveRef.current = false;
    const rec = recognitionRef.current;
    if (rec) { try { rec.onend = null; rec.stop(); } catch {} }
    recognitionRef.current = null;
  }

  /* ---- 5) Timery ---- */
  function clearTimers() {
    [stepTimerRef, advanceTimerRef, silenceHintTimerRef, hardCapTimerRef].forEach(ref => {
      if (ref.current) window.clearTimeout(ref.current);
      ref.current = null;
    });
  }

  function scheduleSilenceAndHard(i: number) {
    // Jednorazowa przypominajka dla całej sesji
    if (!reminderShownRef.current) {
      if (silenceHintTimerRef.current) window.clearTimeout(silenceHintTimerRef.current);
      silenceHintTimerRef.current = window.setTimeout(() => {
        if (idxRef.current === i && !reminderShownRef.current) {
          setHint(REMINDER_TEXT);
          reminderShownRef.current = true;
        }
      }, SILENCE_HINT_MS);
    }

    // Twardy limit kroku
    if (hardCapTimerRef.current) window.clearTimeout(hardCapTimerRef.current);
    hardCapTimerRef.current = window.setTimeout(() => {
      if (idxRef.current !== i) return;
      setHint(null);
      stopSay();
      gotoNext(i);
    }, HARD_CAP_MS);
  }

  /* ---- 6) Kroki ---- */
  function runStep(i: number) {
    if (!steps.length) return;
    clearTimers();
    setHint(null);
    setSayTranscript("");

    const s = steps[i];
    if (!s) return;

    if (s.mode === "VERIFY") {
      stopSay();
      setDisplayText(s.target || "");
      scheduleSilenceAndHard(i);
    } else {
      const prep = Number(s.prep_ms ?? 1200);
      const dwell = Number(s.dwell_ms ?? 12000);
      stopSay();
      setDisplayText(s.prompt || "");
      scheduleSilenceAndHard(i);

      stepTimerRef.current = window.setTimeout(() => {
        if (idxRef.current !== i) return;
        startSay();
        stepTimerRef.current = window.setTimeout(() => {
          if (idxRef.current !== i) return;
          stopSay();
          setHint(null);
          gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearTimers();
    setHint(null);
    stopSay();
    const next = (i + 1) % steps.length;
    setIdx(next);
    const n = steps[next];
    setDisplayText(n?.mode === "SAY" ? (n?.prompt || "") : (n?.target || ""));
    runStep(next);
  }

  /* ---- 7) Start/Stop sesji ---- */
  const startSession = async () => {
    if (!steps.length) return;
    const ok = await startAV();
    if (!ok) { setIsRunning(false); return; }
    setIsRunning(true);
    setFinished(false);
    setHint(null);
    reminderShownRef.current = false; // reset „jednego” hintu na nową sesję
    startCountdown(MAX_TIME_S);
    setIdx(0);
    setDisplayText(steps[0]?.mode === "SAY" ? (steps[0]?.prompt || "") : (steps[0]?.target || ""));
    runStep(0);
  };

  function hardFinishSession() {
    clearTimers();
    stopSay();
    stopAV();
    stopCountdown();
    setIsRunning(false);
    setFinished(true);
  }

  const stopSession = () => {
    clearTimers();
    stopSay();
    stopAV();
    stopCountdown();
    setIsRunning(false);
  };

  /* ---- UI helpers ---- */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  /* ---- Style ---- */
  const centerWrap: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    textAlign: "center",
    width: "min(92vw, 820px)",
    color: "white",
    textShadow: "0 2px 8px rgba(0,0,0,0.7)",
    zIndex: 12,
    padding: "0 8px",
  };
  const verifyTextStyle: React.CSSProperties = {
    fontSize: 22,
    lineHeight: 1.45,
    whiteSpace: "pre-wrap",
  };
  const sayQuestionStyle: React.CSSProperties = {
    fontSize: 20,
    lineHeight: 1.5,
    marginBottom: 10,
  };
  // Transkrypt: czysty biały tekst, bez tła
  const sayTranscriptStyle: React.CSSProperties = {
    fontSize: 20,
    lineHeight: 1.45,
    color: "#fff",
    textShadow: "0 2px 8px rgba(0,0,0,0.75)",
    minHeight: 28,
    whiteSpace: "pre-wrap",
  };

  return (
    <main className="prompter-full">
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

      {/* ZEGAR: na górze, gdzie „zawsze był” */}
      {isRunning && (
        <div style={{
          position: "fixed",
          top: 92,                  // pod topbarem; dostosuj jeśli potrzeba
          left: "50%",
          transform: "translateX(-50%)",
          fontSize: 58,
          fontWeight: 800,
          color: "white",
          textShadow: "0 2px 10px rgba(0,0,0,0.75)",
          zIndex: 11,
          pointerEvents: "none",
        }}>
          {fmt(remaining)}
        </div>
      )}

      <div className="stage mirrored">
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* INTRO (bez dodatkowych napisów, bo grafika idzie na dole; zostawiamy tylko błąd mic jeśli jest) */}
        {!isRunning && !finished && (
          <div className="overlay center">
            {micError && (
              <div style={{ 
                position: "absolute", left: "50%", top: "50%",
                transform: "translate(-50%, -50%)",
                color: "#ffb3b3", fontSize: 14, textAlign: "center"
              }}>
                {micError}
              </div>
            )}
            <img
              src="/assets/meroar-supervised.png"
              alt="Supervised by MeRoar & adhered."
              style={{
                position: "fixed",
                bottom: 12,
                left: "50%",
                transform: "translateX(-50%)",
                width: "72%",
                maxWidth: 360,
                height: "auto",
                objectFit: "contain",
                zIndex: 8,
                opacity: 0.92,
                pointerEvents: "none",
              }}
            />
          </div>
        )}

        {/* KONIEC */}
        {finished && (
          <div className="overlay center" onClick={() => setFinished(false)}>
            <div style={centerWrap}>
              <div style={{ fontSize: 20, lineHeight: 1.5 }}>
                To koniec dzisiejszej sesji.<br />
                Jeśli chcesz – powiedz jeszcze coś do siebie. Kamera nadal działa.
              </div>
            </div>
          </div>
        )}

        {/* Overlay kroków */}
        {isRunning && !finished && (
          <>
            <div style={centerWrap}>
              {steps[idx]?.mode === "VERIFY" && (
                <div style={verifyTextStyle}>{displayText}</div>
              )}
              {steps[idx]?.mode === "SAY" && (
                <>
                  <div style={sayQuestionStyle}>{displayText}</div>
                  <div style={sayTranscriptStyle}>{sayTranscript}</div>
                </>
              )}
            </div>

            {/* JEDNORAZOWA przypominajka */}
            {hint && (
              <div
                style={{
                  position: "fixed",
                  left: "50%", transform: "translateX(-50%)",
                  bottom: 70,
                  width: "min(92vw, 820px)",
                  textAlign: "center",
                  color: "rgba(255,255,255,0.96)",
                  textShadow: "0 2px 6px rgba(0,0,0,0.6)",
                  zIndex: 20,
                  fontSize: 16, lineHeight: 1.35, padding: "0 12px",
                }}
              >
                {hint}
              </div>
            )}

            {/* VU-meter (po prawej) */}
            <div className="meter-vertical" style={{ zIndex: 21 }}>
              <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
            </div>
          </>
        )}
      </div>
    </main>
  );
}


