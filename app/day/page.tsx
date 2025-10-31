"use client";
import { useEffect, useRef, useState } from "react";

type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;
  prompt?: string;
  prep_ms?: number;
  dwell_ms?: number;
};

function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "03") : "03";
  const DAY_LABEL = String(parseInt(dayRaw, 10) || 3);
  const MAX_TIME = 6 * 60;

  const HINTS = [
    "Jeśli możesz, postaraj się przeczytać na głos.",
    "Pamiętaj — to przestrzeń pełna szacunku do Ciebie.",
    "Jeśli potrzebujesz chwili dla siebie, możesz wrócić później.\nJeśli chcesz kontynuować, dotknij ekranu.",
  ] as const;

  const TRAILER_STEPS: PlanStep[] = [
    { mode: "VERIFY", target: "Jestem w bardzo dobrym miejscu." },
    { mode: "VERIFY", target: "Szacunek do siebie staje się naturalny." },
    { mode: "VERIFY", target: "W moim wnętrzu dojrzewa spokój i zgoda." },

    // OTWARTE 12 s, większe pytania
    { mode: "SAY", prompt: "A teraz popatrz na siebie i podziękuj sobie.\nZrób to ze spokojem — Twoje słowa wyświetlą się na ekranie.", prep_ms: 1000, dwell_ms: 12000 },
    { mode: "SAY", prompt: "A teraz popatrz na siebie i przyznaj sobie rację.\nZrób to z przekonaniem — Twoje słowa wyświetlą się na ekranie.", prep_ms: 1000, dwell_ms: 12000 },
    { mode: "SAY", prompt: "A teraz popatrz na siebie i pogratuluj sobie.\nZrób to z radością — Twoje słowa wyświetlą się na ekranie.", prep_ms: 1000, dwell_ms: 12000 },

    { mode: "VERIFY", target: "Każdy dzień przybliża mnie do siebie." },
  ];

  // --- State ---
  const [steps] = useState(TRAILER_STEPS);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);

  const [levelPct, setLevelPct] = useState(0);
  const [speakingBlink, setSpeakingBlink] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  const [sayTranscript, setSayTranscript] = useState("");

  // hints
  const [hintStage, setHintStage] = useState<0 | 1 | 2>(0);
  const [hintVisible, setHintVisible] = useState(false);
  const [awaitingTapToContinue, setAwaitingTapToContinue] = useState(false);
  const [hintsDisabled, setHintsDisabled] = useState(false); // <— po 3-ciej wyłączamy na zawsze

  // Refs
  const isRunningRef = useRef(isRunning);
  const idxRef = useRef(idx);
  const awaitingTapRef = useRef(awaitingTapToContinue);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { awaitingTapRef.current = awaitingTapToContinue; }, [awaitingTapToContinue]);

  // Timers
  const endAtRef = useRef<number | null>(null);
  const countdownIdRef = useRef<number | null>(null);
  const stepTimerRef = useRef<number | null>(null);
  const sayTimerRef = useRef<number | null>(null);
  const hintTimerRef = useRef<number | null>(null);
  const advanceAfterSpeakRef = useRef<number | null>(null);

  // Audio / VAD
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // SAY
  const recognitionRef = useRef<any>(null);
  const sayActiveRef = useRef(false);

  function startCountdown(s: number) {
    stopCountdown();
    endAtRef.current = Date.now() + s * 1000;
    setRemaining(Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000)));
    countdownIdRef.current = window.setInterval(() => {
      if (!endAtRef.current) return;
      const secs = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0) stopSession(true);
    }, 250);
  }
  function stopCountdown() {
    if (countdownIdRef.current) window.clearInterval(countdownIdRef.current!);
    countdownIdRef.current = null;
    endAtRef.current = null;
  }
  function clearTimers() {
    [stepTimerRef, sayTimerRef, hintTimerRef, advanceAfterSpeakRef].forEach(r => {
      if (r.current) { window.clearTimeout(r.current); r.current = null; }
    });
  }

  async function startAV() {
    stopAV();
    setMicError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      streamRef.current = stream;
      if (videoRef.current) (videoRef.current as any).srcObject = stream;

      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new Ctx();
      audioCtxRef.current = ac;

      // iOS odblokowanie po geście
      const tryResume = () => { if (ac.state === "suspended") ac.resume().catch(() => {}); };
      ["click", "touchstart"].forEach(evt => document.addEventListener(evt, tryResume, { once: true, passive: true }));

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
          // mowa: chowamy hinty i reset
          if (hintVisible) setHintVisible(false);
          if (!hintsDisabled && hintStage !== 0) setHintStage(0);

          setSpeakingBlink(true);
          window.setTimeout(() => setSpeakingBlink(false), 120);

          // VERIFY: auto-next po 4 s od pierwszej mowy
          if (steps[idxRef.current]?.mode === "VERIFY" && !advanceAfterSpeakRef.current && !awaitingTapRef.current) {
            const thisI = idxRef.current;
            advanceAfterSpeakRef.current = window.setTimeout(() => {
              if (idxRef.current === thisI && !awaitingTapRef.current) gotoNext(thisI);
            }, 4000);
          }
        }

        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    } catch (e: any) {
      setMicError(e?.name === "NotAllowedError" ? "Brak zgody na mikrofon/kamerę." : "Nie udało się uruchomić mikrofonu/kamery.");
    }
  }

  function stopAV() {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch {} audioCtxRef.current = null; }
  }

  // SAY
  function startSayCapture() {
    sayActiveRef.current = true;
    setSayTranscript("");
    stopSayCapture();

    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    recognitionRef.current = rec;

    rec.lang = "pl-PL";
    rec.continuous = true;
    rec.interimResults = true;

    let buffer = "";
    rec.onresult = (e: any) => {
      let interim = "", finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      const composed = (buffer + finalText + interim).trim();
      setSayTranscript(composed);
      if (finalText) buffer += finalText + " ";
      if (composed && hintVisible && !hintsDisabled) {
        setHintVisible(false);
        setHintStage(0);
      }
    };

    rec.onend = () => { if (sayActiveRef.current) try { rec.start(); } catch {} };
    try { rec.start(); } catch {}
  }
  function stopSayCapture() {
    sayActiveRef.current = false;
    const rec = recognitionRef.current;
    if (rec) { try { rec.onend = null; rec.stop(); } catch {} }
    recognitionRef.current = null;
  }

  // Hints 1→2→3 (po 3-ciej: wyłączone na zawsze)
  function scheduleHintsForStep(i: number) {
    if (hintsDisabled) return; // po 3-ciej nie pokazujemy nigdy więcej
    if (hintTimerRef.current) { clearTimeout(hintTimerRef.current); hintTimerRef.current = null; }
    setHintVisible(false);
    setHintStage(0);
    setAwaitingTapToContinue(false);

    const fire = (stage: 0 | 1 | 2) => {
      if (idxRef.current !== i || !isRunningRef.current || hintsDisabled) return;

      if (stage < 2) {
        setHintStage((stage + 1) as 1 | 2);
        setHintVisible(true);
        hintTimerRef.current = window.setTimeout(() => fire((stage + 1) as 1 | 2), 4000);
      } else {
        // 3-ci etap – blok i wyłączenie przypominajek do końca sesji
        setHintStage(2);
        setHintVisible(true);
        setAwaitingTapToContinue(true);
        setHintsDisabled(true);
      }
    };

    // pierwsza po 7s ciszy
    hintTimerRef.current = window.setTimeout(() => fire(0), 7000);
  }

  function runStep(i: number) {
    clearTimers();
    setHintVisible(false);
    setAwaitingTapToContinue(false);
    setSayTranscript("");

    const s = steps[i];
    if (!s) return;

    if (s.mode === "VERIFY") {
      setDisplayText(s.target || "");
      scheduleHintsForStep(i);
    } else {
      setDisplayText(s.prompt || "");
      const prep = Number(s.prep_ms ?? 1200);
      const dwell = Number(s.dwell_ms ?? 12000);
      scheduleHintsForStep(i);

      stepTimerRef.current = window.setTimeout(() => {
        if (idxRef.current !== i) return;
        startSayCapture();

        sayTimerRef.current = window.setTimeout(() => {
          if (idxRef.current !== i) return;
          stopSayCapture();
          if (!awaitingTapRef.current) gotoNext(i);
        }, dwell);
      }, prep);
    }
  }

  function gotoNext(i: number) {
    clearTimers();
    setHintVisible(false);
    setAwaitingTapToContinue(false);
    stopSayCapture();

    const next = (i + 1) % steps.length;
    setIdx(next);
    const n = steps[next];
    setDisplayText(n?.mode === "VERIFY" ? (n.target || "") : (n?.prompt || ""));
    runStep(next);
  }

  const startSession = async () => {
    await startAV();
    setIsRunning(true);
    startCountdown(MAX_TIME);
    setIdx(0);
    setDisplayText(steps[0]?.mode === "VERIFY" ? (steps[0].target || "") : (steps[0]?.prompt || ""));
    runStep(0);
  };
  const stopSession = (hard = false) => {
    setIsRunning(false);
    clearTimers();
    stopSayCapture();
    stopAV();
    stopCountdown();
    setLevelPct(0);
    if (hard) alert("To koniec dzisiejszej sesji. Jeśli chcesz — możesz jeszcze chwilę porozmawiać ze sobą.");
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const isSay = steps[idx]?.mode === "SAY";

  // style
  const questionStyle: React.CSSProperties = {
    fontSize: 22, // większe komendy
    lineHeight: 1.55,
    maxWidth: 760,
    margin: "0 auto",
    textAlign: "center",
  };

  return (
    <main
      className="prompter-full"
      onClick={() => {
        if (awaitingTapToContinue && isRunning) {
          setAwaitingTapToContinue(false);
          setHintVisible(false);
          gotoNext(idxRef.current);
        }
      }}
    >
      <header className="topbar topbar--dense">
        <nav className="tabs">
          <a className="tab active" href="/day" aria-current="page">Prompter</a>
          <span className="tab disabled" aria-disabled="true">Rysownik</span>
        </nav>
        <div className="top-info compact">
          <span className="meta"><b>Użytkownik:</b> {USER_NAME}</span>
          <span className="meta" style={{ marginLeft: 8 }}><b>Dzień programu:</b> {DAY_LABEL}</span>
        </div>
        <div className="controls-top">
          {!isRunning ? <button className="btn" onClick={startSession}>Start</button> : <button className="btn" onClick={() => stopSession(false)}>Stop</button>}
        </div>
      </header>

      {/* ZEGAR NA GÓRZE */}
      <div className="timer-top timer-top--strong">{fmt(remaining)}</div>

      <div className="stage mirrored">
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* INTRO */}
        {!isRunning && (
          <div className="overlay center">
            <div style={{ textAlign: "center", color: "white", textShadow: "0 2px 7px rgba(0,0,0,0.7)" }}>
              <div style={{ fontSize: 18, lineHeight: 1.6 }}>
                Twoja sesja potrwa około <b>6 minut</b>.<br />
                Postaraj się <b>wyraźnie powtarzać</b> wyświetlane treści.
              </div>
            </div>
            <img
              src="/assets/meroar-supervised.png"
              alt="Supervised by MeRoar & adhered."
              style={{ position: "fixed", bottom: 6, left: "50%", transform: "translateX(-50%)", width: "54%", maxWidth: 260, height: "auto", objectFit: "contain", opacity: 0.9, pointerEvents: "none" }}
            />
          </div>
        )}

        {/* SESJA */}
        {isRunning && (
          <div className="overlay center" style={{ position: "relative" }}>
            {/* TRANSKRYPCJA NA GÓRZE */}
            {isSay && (
              <div
                style={{
                  position: "absolute",
                  top: 70, // wysoko u góry
                  left: 0,
                  right: 0,
                  padding: "0 16px",
                  textAlign: "center",
                  color: "white",
                  textShadow: "0 2px 6px rgba(0,0,0,0.7)",
                  fontSize: 18,
                  minHeight: 24,
                }}
              >
                {sayTranscript}
              </div>
            )}

            {/* CENTRALNY TEKST / KOMENDA */}
            <div className="center-text fade" style={{ whiteSpace: "pre-wrap", textAlign: "center", ...questionStyle }}>
              {displayText}
            </div>

            {/* PRZYPOMINAJKI (wyłączają się na zawsze po 3-ciej) */}
            {hintVisible && (
              <div
                style={{
                  position: "absolute",
                  left: 0, right: 0, bottom: 72,
                  padding: "0 24px",
                  textAlign: "center",
                  fontSize: 15,
                  lineHeight: 1.35,
                  color: "rgba(255,255,255,0.96)",
                  textShadow: "0 1px 2px rgba(0,0,0,0.6)",
                  pointerEvents: "none",
                }}
              >
                {HINTS[hintStage]}
              </div>
            )}
          </div>
        )}

        {/* VU po prawej */}
        <div className="meter-vertical">
          <div className="meter-vertical-fill" style={{ height: `${levelPct}%` }} />
          {speakingBlink && <div style={{ position: "absolute", left: 0, right: 0, bottom: 4, textAlign: "center", fontSize: 10, opacity: 0.7 }}>●</div>}
        </div>
      </div>
    </main>
  );
}



