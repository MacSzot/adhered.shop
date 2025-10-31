"use client";

import { useEffect, useRef, useState } from "react";

/* ---------- Typ kroku ---------- */
type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;  // dla VERIFY
  prompt?: string;  // dla SAY
  prep_ms?: number;
  dwell_ms?: number;
};

/* ---------- Helpers ---------- */
function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

export default function PrompterPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Ustawienia trailera
  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "03") : "03";
  const DAY_LABEL = String(parseInt(dayRaw, 10) || 3);

  // 6 minut na sesję
  const MAX_TIME = 6 * 60;

  // VAD progi
  const SPEAKING_FRAMES_REQUIRED = 2;

  // Hints – treści po kolei
  const HINTS = [
    "Jeśli możesz, postaraj się przeczytać na głos.",
    "Pamiętaj — to przestrzeń pełna szacunku do Ciebie.",
    "Jeśli potrzebujesz chwili dla siebie, możesz wrócić później.\nJeśli chcesz kontynuować, dotknij ekranu.",
  ];

  // Kroki „trailera” dnia 3 — możesz podmienić na plik, ale to działa od razu
  const TRAILER_STEPS: PlanStep[] = [
    { mode: "VERIFY", target: "Jestem w bardzo dobrym miejscu." },
    { mode: "VERIFY", target: "Szacunek do siebie staje się naturalny." },
    { mode: "VERIFY", target: "W moim wnętrzu dojrzewa spokój i zgoda." },

    // OTWARTE (SAY) x3 wg Twoich wytycznych
    { mode: "SAY", prompt: "A teraz popatrz na siebie i podziękuj sobie.\nZrób to ze spokojem — Twoje słowa wyświetlą się na ekranie.", prep_ms: 1000, dwell_ms: 12000 },
    { mode: "SAY", prompt: "A teraz popatrz na siebie i przyznaj sobie rację.\nZrób to z przekonaniem — Twoje słowa wyświetlą się na ekranie.", prep_ms: 1000, dwell_ms: 12000 },
    { mode: "SAY", prompt: "A teraz popatrz na siebie i pogratuluj sobie.\nZrób to z radością — Twoje słowa wyświetlą się na ekranie.", prep_ms: 1000, dwell_ms: 12000 },

    { mode: "VERIFY", target: "Każdy dzień przybliża mnie do siebie." },
  ];

  /* ---------- Stany ---------- */
  const [steps] = useState<PlanStep[]>(TRAILER_STEPS);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);

  // VAD / audio
  const [levelPct, setLevelPct] = useState(0);
  const [speakingBlink, setSpeakingBlink] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  // SAY transkrypcja (biały, bez tła)
  const [sayTranscript, setSayTranscript] = useState("");

  // Przypominajki — 0/1/2 (na 3-cia zatrzymujemy krok i czekamy na tap)
  const [hintStage, setHintStage] = useState<0 | 1 | 2>(0);
  const [hintVisible, setHintVisible] = useState(false);
  const [awaitingTapToContinue, setAwaitingTapToContinue] = useState(false);

  // Refy
  const isRunningRef = useRef(isRunning);
  const idxRef = useRef(idx);
  const awaitingTapRef = useRef(awaitingTapToContinue);

  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { awaitingTapRef.current = awaitingTapToContinue; }, [awaitingTapToContinue]);

  /* ---------- Timery ---------- */
  const endAtRef = useRef<number | null>(null);
  const countdownIdRef = useRef<number | null>(null);

  const stepTimerRef = useRef<number | null>(null);
  const sayTimerRef = useRef<number | null>(null);
  const hintTimerRef = useRef<number | null>(null);

  const advanceAfterSpeakRef = useRef<number | null>(null);

  /* ---------- Audio/VAD ---------- */
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const speakingFramesRef = useRef(0);

  // Web Speech (SAY)
  const recognitionRef = useRef<any>(null);
  const sayActiveRef = useRef(false);

  function startCountdown(seconds: number) {
    stopCountdown();
    endAtRef.current = Date.now() + seconds * 1000;
    setRemaining(Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000)));
    countdownIdRef.current = window.setInterval(() => {
      if (!endAtRef.current) return;
      const secs = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0) stopSession(true);
    }, 250);
  }
  function stopCountdown() {
    if (countdownIdRef.current) {
      window.clearInterval(countdownIdRef.current);
      countdownIdRef.current = null;
    }
    endAtRef.current = null;
  }

  function clearTimers() {
    [stepTimerRef, sayTimerRef, hintTimerRef, advanceAfterSpeakRef].forEach(ref => {
      if (ref.current) { window.clearTimeout(ref.current); ref.current = null; }
    });
  }

  async function startAV() {
    stopAV();
    setMicError(null);

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
          // jeśli była przypominajka — chowamy i resetujemy licznik
          if (hintVisible) setHintVisible(false);
          if (hintStage !== 0) setHintStage(0);
          // jeśli oczekujemy „tap to continue” — mowa też schowa komunikat,
          // ale nie przełączy kroku (czekamy na tap zgodnie z ustaleniami)
          setSpeakingBlink(true);
          window.setTimeout(() => setSpeakingBlink(false), 120);

          // dla VERIFY – 4s po pierwszym głosie → next
          if (steps[idxRef.current]?.mode === "VERIFY" && !advanceAfterSpeakRef.current) {
            const thisI = idxRef.current;
            advanceAfterSpeakRef.current = window.setTimeout(() => {
              if (idxRef.current === thisI && !awaitingTapRef.current) gotoNext(thisI);
            }, 4000);
          }
        } else {
          speakingFramesRef.current = 0;
        }

        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    } catch (e: any) {
      setMicError(e?.name === "NotAllowedError"
        ? "Brak zgody na mikrofon/kamerę."
        : "Nie udało się uruchomić mikrofonu/kamery.");
    }
  }

  function stopAV() {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
  }

  /* ---------- SAY (natychmiastowy, przeglądarkowy) ---------- */
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
      let interim = "";
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      const composed = (buffer + finalText + interim).trim();
      setSayTranscript(composed);
      if (finalText) buffer += finalText + " ";
      if (composed) {
        // mowa = chowamy hint
        if (hintVisible) setHintVisible(false);
        if (hintStage !== 0) setHintStage(0);
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

  /* ---------- Kroki + przypominajki 1→2→3 ---------- */
  function scheduleHintsForStep(i: number) {
    // kasujemy stare
    if (hintTimerRef.current) { clearTimeout(hintTimerRef.current); hintTimerRef.current = null; }
    setHintVisible(false);
    setHintStage(0);
    setAwaitingTapToContinue(false);

    const fire = (stage: 0 | 1 | 2) => {
      if (idxRef.current !== i || !isRunningRef.current) return;

      if (stage < 2) {
        setHintStage((stage + 1) as 1 | 2);
        setHintVisible(true);
        // pokaż przez 4 s, jeśli dalej cisza — kolejny etap
        hintTimerRef.current = window.setTimeout(() => fire((stage + 1) as 1 | 2), 4000);
      } else {
        // 3-ci etap — blokujemy krok i czekamy na tap
        setHintStage(2);
        setHintVisible(true);
        setAwaitingTapToContinue(true);
      }
    };

    // start 1. przypominajki po 7 s ciszy
    hintTimerRef.current = window.setTimeout(() => fire(0), 7000);
  }

  function runStep(i: number) {
    clearTimers();
    setHintVisible(false);
    setHintStage(0);
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

      // hinty działają od razu
      scheduleHintsForStep(i);

      // po krótkim „prep” włączamy rozpoznawanie
      stepTimerRef.current = window.setTimeout(() => {
        if (idxRef.current !== i) return;
        startSayCapture();

        // po dwell kończymy krok (o ile nie czekamy na tap)
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

  /* ---------- Start/Stop ---------- */
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
    if (hard) {
      // komunikat końcowy po twardym stopie czasu
      alert("To koniec dzisiejszej sesji. Jeśli chcesz — możesz jeszcze chwilę porozmawiać ze sobą.");
    }
  };

  /* ---------- Render ---------- */
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const isSay = steps[idx]?.mode === "SAY";

  return (
    <main className="prompter-full" onClick={() => {
      // 3-ci hint — tap kontynuuje
      if (awaitingTapToContinue && isRunning) {
        setAwaitingTapToContinue(false);
        setHintVisible(false);
        gotoNext(idxRef.current);
      }
    }}>
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
          {!isRunning ? (
            <button className="btn" onClick={startSession}>Start</button>
          ) : (
            <button className="btn" onClick={() => stopSession(false)}>Stop</button>
          )}
        </div>
      </header>

      {/* ⏱ ZEGAR NA GÓRZE */}
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

            {/* znak na dole (mniejszy) */}
            <img
              src="/assets/meroar-supervised.png"
              alt="Supervised by MeRoar & adhered."
              style={{
                position: "fixed",
                bottom: 6,
                left: "50%",
                transform: "translateX(-50%)",
                width: "54%",
                maxWidth: 260,
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
          <div className="overlay center">
            {/* Tekst środka — zawsze centralnie zwięźle */}
            <div className="center-text fade" style={{ whiteSpace: "pre-wrap", textAlign: "center" }}>
              {displayText}
            </div>

            {/* SAY transkrypcja — biała, bez tła pod pytaniem */}
            {isSay && (
              <div
                style={{
                  marginTop: 14,
                  fontSize: 18,
                  minHeight: 28,
                  textAlign: "center",
                  color: "white",
                  textShadow: "0 2px 6px rgba(0,0,0,0.7)",
                }}
              >
                {sayTranscript}
              </div>
            )}

            {/* PRZYPOMINAJKI 1 → 2 → 3 (3-cia blokuje i czeka na tap) */}
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

        {/* Pionowy VU po prawej */}
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


