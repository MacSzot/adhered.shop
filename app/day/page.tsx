"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Prompter — wersja z ustabilizowanym detektorem dźwięku (VAD)
 * i JEDNĄ przypominajką po 10 sekundach ciszy na danym kroku.
 * Tekst zawsze idealnie na środku; zegar u góry.
 */

export default function DayPage() {
  // ── konfiguracja sesji ──────────────────────────────────────────────
  const TOTAL_SECONDS = 6 * 60;   // 6:00
  const SLIDE_SECONDS = 7;        // co ile zmieniamy tekst
  const SILENCE_HINT_MS = 10_000; // przypominajka po 10 s ciszy (raz/step)

  // Teksty (Day 3 + 3 otwarte)
  const LINES: string[] = [
    "Jestem w bardzo dobrym miejscu.",
    "Szacunek do siebie staje się naturalny.",
    "W moim wnętrzu dojrzewa spokój i zgoda.",
    "Czasem wystarczy chwila, by poczuć, że to dobra droga.",
    "Popatrz na siebie i podziękuj sobie. Zrób to ze spokojem — Twoje słowa wyświetlą się na ekranie.",
    "Doceniam to, jak wiele już zostało zrobione.",
    "Moje tempo jest wystarczające.",
    "Uznaję swoją historię taką, jaka jest.",
    "Popatrz na siebie i przyznaj sobie rację. Zrób to z przekonaniem — Twoje słowa wyświetlą się na ekranie.",
    "Podziwiam sposób przetrwania trudnych chwil.",
    "Jest we mnie siła, która potrafi wracać.",
    "Szanuję wysiłek, który doprowadził mnie tutaj.",
    "Popatrz na siebie i pogratuluj sobie. Zrób to z radością — Twoje słowa wyświetlą się na ekranie.",
    "Dobre słowo o sobie zaczyna brzmieć naturalnie.",
    "Każdy dzień przynosi nowe zrozumienie.",
    "Mam świadomość, że nie wszystko musi być naprawione."
  ];

  // ── stan podstawowy ─────────────────────────────────────────────────
  const [running, setRunning] = useState(false);
  const [timeLeft, setTimeLeft] = useState(TOTAL_SECONDS);
  const [slideIdx, setSlideIdx] = useState(0);

  // ── stan detektora / VU ─────────────────────────────────────────────
  const [vu, setVu] = useState(0);                 // 0–100
  const [micError, setMicError] = useState<string | null>(null);
  const [hintVisible, setHintVisible] = useState(false); // JEDNA przypominajka/step

  // ── refy i timery ───────────────────────────────────────────────────
  const tickRef = useRef<number | null>(null);
  const slideRef = useRef<number | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const silenceTimerRef = useRef<number | null>(null);
  const hintShownForStepRef = useRef(false); // czy pokazaliśmy już hint w tym kroku
  const runningRef = useRef(running);
  useEffect(() => { runningRef.current = running; }, [running]);

  // ── helpery ─────────────────────────────────────────────────────────
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  function clearIntervals() {
    if (tickRef.current) clearInterval(tickRef.current);
    if (slideRef.current) clearInterval(slideRef.current);
    tickRef.current = null;
    slideRef.current = null;
  }
  function clearSilenceTimer() {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }
  function scheduleSilenceHintOnce() {
    clearSilenceTimer();
    if (hintShownForStepRef.current) return; // już pokazano w tym kroku
    silenceTimerRef.current = window.setTimeout(() => {
      // jeśli nadal trwa ten sam step i nadal brak głosu → pokaż JEDEN raz
      if (runningRef.current && !hintShownForStepRef.current) {
        setHintVisible(true);
        hintShownForStepRef.current = true;
      }
    }, SILENCE_HINT_MS);
  }

  // ── AV start/stop ───────────────────────────────────────────────────
  async function startAV(): Promise<boolean> {
    stopAV();
    setMicError(null);
    setVu(0);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      streamRef.current = stream;

      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new Ctx();
      audioCtxRef.current = ac;
      if (ac.state === "suspended") {
        await ac.resume().catch(() => {});
        const resumeOnTap = () => ac.resume().catch(() => {});
        document.addEventListener("click", resumeOnTap, { once: true });
      }

      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.86;
      const source = ac.createMediaStreamSource(stream);
      source.connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.fftSize);
      // progi „stabilne”
      const RMS_THR = 0.015;   // wrażliwość RMS
      const PEAK_THR = 0.035;  // wrażliwość peak

      const loop = () => {
        if (!analyserRef.current || !runningRef.current) return;
        analyserRef.current.getByteTimeDomainData(data);

        let peak = 0;
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const x = (data[i] - 128) / 128;
          const a = Math.abs(x);
          if (a > peak) peak = a;
          sumSq += x * x;
        }
        const rms = Math.sqrt(sumSq / data.length);
        const meter = Math.min(100, Math.max(0, Math.round(peak * 500)));
        setVu((prev) => Math.max(meter, Math.round(prev * 0.85))); // wygładzenie

        const speakingNow = rms > RMS_THR || peak > PEAK_THR;
        if (speakingNow) {
          // mowa wykryta → chowamy hint i restartujemy licznik ciszy
          setHintVisible(false);
          scheduleSilenceHintOnce();
        }

        rafRef.current = requestAnimationFrame(loop);
      };
      // start licznika ciszy od razu po uruchomieniu kroku
      scheduleSilenceHintOnce();
      rafRef.current = requestAnimationFrame(loop);
      return true;
    } catch (e: any) {
      console.error("getUserMedia error:", e);
      setMicError(e?.name === "NotAllowedError" ? "Brak zgody na mikrofon." : "Nie udało się uruchomić mikrofonu.");
      return false;
    }
  }

  function stopAV() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    setVu(0);
  }

  // ── Start / Stop sesji ──────────────────────────────────────────────
  function start() {
    setRunning(true);
    setTimeLeft(TOTAL_SECONDS);
    setSlideIdx(0);
    setHintVisible(false);
    hintShownForStepRef.current = false;
    clearIntervals();

    // zegar
    tickRef.current = window.setInterval(() => {
      setTimeLeft((s) => {
        if (s <= 1) {
          stop();
          return 0;
        }
        return s - 1;
      });
    }, 1000);

    // zmiana slajdów
    slideRef.current = window.setInterval(() => {
      setSlideIdx((prev) => {
        // nowy krok ⇒ reset jednorazowej przypominajki
        hintShownForStepRef.current = false;
        setHintVisible(false);
        scheduleSilenceHintOnce(); // natychmiast rozpoczynamy okno 10 s
        return (prev + 1) % LINES.length;
      });
    }, SLIDE_SECONDS * 1000);

    // audio
    startAV();
  }

  function stop() {
    setRunning(false);
    clearIntervals();
    stopAV();
    clearSilenceTimer();
    setHintVisible(false);
  }

  // ── czyszczenie przy odmontowaniu ───────────────────────────────────
  useEffect(() => {
    return () => {
      clearIntervals();
      stopAV();
      clearSilenceTimer();
    };
  }, []);

  // ── style (środek ekranu, timer u góry, VU po prawej) ───────────────
  const centerWrap: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    padding: "0 24px",
    pointerEvents: "none",
  };
  const lineStyle: React.CSSProperties = {
    maxWidth: 820,
    fontSize: 28,
    lineHeight: 1.5,
    color: "#fff",
    textShadow: "0 2px 4px rgba(0,0,0,.55)",
  };
  const hintStyle: React.CSSProperties = {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 72,
    textAlign: "center",
    fontSize: 16,
    color: "rgba(255,255,255,.96)",
    textShadow: "0 1px 2px rgba(0,0,0,.55)",
    opacity: hintVisible ? 1 : 0,
    transition: "opacity 180ms ease",
    pointerEvents: "none",
  };
  const meterWrap: React.CSSProperties = {
    position: "fixed",
    right: 8,
    top: 64,
    bottom: 24,
    width: 10,
    borderRadius: 6,
    background: "rgba(255,255,255,.08)",
    overflow: "hidden",
  };
  const meterFill: React.CSSProperties = {
    position: "absolute",
    left: 0, right: 0, bottom: 0,
    height: `${vu}%`,
    background: "rgba(255,255,255,.9)",
  };

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff" }}>
      {/* topbar */}
      <header
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          background: "rgba(0,0,0,.45)",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", gap: 16 }}>
          <span><b>Użytkownik:</b> demo</span>
          <span><b>Dzień programu:</b> 3</span>
          {micError && <span style={{ color: "#ffb3b3" }}>{micError}</span>}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ fontWeight: 800, fontSize: 32 }}>{fmt(timeLeft)}</div>
          {!running ? (
            <button onClick={start} style={{ padding: "6px 14px", borderRadius: 8 }}>Start</button>
          ) : (
            <button onClick={stop} style={{ padding: "6px 14px", borderRadius: 8 }}>Stop</button>
          )}
        </div>
      </header>

      {/* centrum — zawsze idealnie na środku */}
      {!running ? (
        <div style={centerWrap}>
          <div style={lineStyle}>
            Twoja sesja potrwa około <b>6 minut</b>.<br />
            Prosimy o powtarzanie na głos wyświetlanych treści.
            <br /><br />
            Aktywowano analizator głosu <b>MeRoar™</b>
          </div>
        </div>
      ) : (
        <div style={centerWrap}>
          <div style={lineStyle}>{LINES[slideIdx]}</div>
        </div>
      )}

      {/* VU meter (stabilny, prosty) */}
      {running && (
        <div style={meterWrap}>
          <div style={meterFill} />
        </div>
      )}

      {/* JEDNA przypominajka po 10 s ciszy w danym kroku */}
      {running && <div style={hintStyle}>Jeśli możesz, postaraj się przeczytać na głos.</div>}
    </main>
  );
}



