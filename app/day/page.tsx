"use client";

import { useEffect, useRef, useState } from "react";

type PlanStep = {
  mode: "VERIFY" | "SAY";
  target?: string;
  prompt?: string;
  prep_ms?: number;
  dwell_ms?: number;
};

async function loadDayPlanOrTxt(dayFileParam: string): Promise<PlanStep[]> {
  // 1) spróbuj JSON: /public/days/06.plan.json itd.
  try {
    const r = await fetch(`/days/${dayFileParam}.plan.json`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const steps = Array.isArray(j?.steps) ? (j.steps as PlanStep[]) : [];
      if (steps.length) return steps;
    }
  } catch {}
  // 2) fallback: TXT (każda linia = VERIFY)
  try {
    const r2 = await fetch(`/days/${dayFileParam}.txt`, { cache: "no-store" });
    if (r2.ok) {
      const txt = await r2.text();
      return txt
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((line) => ({ mode: "VERIFY" as const, target: line }));
    }
  } catch {}
  // 3) awaryjnie — prosty zestaw, w tym jedno SAY (pokazanie Whispera)
  return [
    { mode: "VERIFY", target: "Jestem w bardzo dobrym miejscu." },
    { mode: "VERIFY", target: "Szacunek do siebie staje się naturalny." },
    {
      mode: "SAY",
      prompt:
        "A teraz popatrz na siebie i podziękuj sobie. Zrób to ze spokojem — Twoje słowa wyświetlą się na ekranie.",
      prep_ms: 800,
      dwell_ms: 12000,
    },
  ];
}

function getParam(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return (v && v.trim()) || fallback;
}

export default function Page() {
  // ======== refs & state ========
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const dayRaw = typeof window !== "undefined" ? getParam("day", "06") : "06";
  const dayFileParam = dayRaw.padStart(2, "0");
  const DAY_LABEL = (() => {
    const n = parseInt(dayRaw, 10);
    return Number.isNaN(n) ? dayRaw : String(n);
  })();

  const MAX_TIME = 6 * 60; // 6 minut (hard koniec)
  const SILENCE_HINT_MS = 7000; // jedno przypomnienie po 7s ciszy

  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [display, setDisplay] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  const [remaining, setRemaining] = useState(MAX_TIME);
  const endAtRef = useRef<number | null>(null);
  const countdownIdRef = useRef<number | null>(null);

  const [hintShown, setHintShown] = useState(false); // jedno przypomnienie
  const silenceTimerRef = useRef<number | null>(null);
  const hardCapTimerRef = useRef<number | null>(null);

  // audio
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const [vu, setVu] = useState(0);

  // transkrypcja
  const [sayText, setSayText] = useState(""); // co powiedział użytkownik (Whisper)
  const sayActiveRef = useRef(false);
  const [mirror] = useState(true);

  // ======== init plan ========
  useEffect(() => {
    (async () => {
      const s = await loadDayPlanOrTxt(dayFileParam);
      setSteps(s);
      const first = s[0];
      setDisplay(first?.mode === "VERIFY" ? first.target || "" : first?.prompt || "");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ======== camera+mic ========
  async function startAV() {
    stopAV();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      streamRef.current = stream;
      if (videoRef.current) (videoRef.current as any).srcObject = stream;

      // vu-meter
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
        if (!analyserRef.current) return;
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const x = (data[i] - 128) / 128;
          const a = Math.abs(x);
          if (a > peak) peak = a;
        }
        setVu(Math.min(100, peak * 480));
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      return true;
    } catch (e) {
      console.error("getUserMedia error:", e);
      return false;
    }
  }

  function stopAV() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try { mediaRecorderRef.current.stop(); } catch {}
    }
    mediaRecorderRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;

    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
  }

  // ======== countdown ========
  function startCountdown(secs: number) {
    stopCountdown();
    endAtRef.current = Date.now() + secs * 1000;
    setRemaining(Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000)));
    countdownIdRef.current = window.setInterval(() => {
      if (!endAtRef.current) return;
      const left = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) stopSession(true);
    }, 250);
  }
  function stopCountdown() {
    if (countdownIdRef.current) window.clearInterval(countdownIdRef.current);
    countdownIdRef.current = null;
    endAtRef.current = null;
  }

  // ======== whisper chunks ========
  function startWhisperChunks() {
    setSayText("");
    sayActiveRef.current = true;

    const stream = streamRef.current;
    if (!stream) return;

    const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorderRef.current = mr;

    mr.ondataavailable = async (ev) => {
      if (!ev.data || !ev.data.size) return;
      // wyślij chunk do /api/whisper
      try {
        const fd = new FormData();
        const file = new File([ev.data], `chunk-${Date.now()}.webm`, { type: "audio/webm" });
        fd.append("file", file);
        const r = await fetch("/api/whisper", { method: "POST", body: fd });
        const j = await r.json();
        if (j?.text) {
          setSayText((prev) => (prev ? `${prev} ${j.text}` : j.text));
          // po pierwszej transkrypcji chowamy hint (pokazujemy go tylko raz po ciszy)
          if (!j.text.trim()) return;
          if (!hintShown) setHintShown(false);
        }
      } catch (e) {
        console.warn("whisper chunk error:", e);
      }
    };

    // nagrywamy małe porcje, np. co 3s
    mr.start(3000);
  }

  function stopWhisperChunks() {
    sayActiveRef.current = false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try { mediaRecorderRef.current.stop(); } catch {}
    }
    mediaRecorderRef.current = null;
  }

  // ======== timers for step ========
  function clearStepTimers() {
    if (silenceTimerRef.current) { window.clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    if (hardCapTimerRef.current) { window.clearTimeout(hardCapTimerRef.current); hardCapTimerRef.current = null; }
  }

  function runStep(i: number) {
    clearStepTimers();
    setHintShown(false);

    const s = steps[i];
    if (!s) return;

    if (s.mode === "VERIFY") {
      stopWhisperChunks();
      setDisplay(s.target || "");
      // jedno przypomnienie po 7s ciszy
      silenceTimerRef.current = window.setTimeout(() => setHintShown(true), SILENCE_HINT_MS);
      // twardy cap kroku po 12s (nie blokujemy całej sesji)
      hardCapTimerRef.current = window.setTimeout(() => nextStep(i), 12000);
    } else {
      setDisplay(s.prompt || "");
      setSayText("");

      // hint po 7s (jeśli nadal cisza — brak transkrypcji)
      silenceTimerRef.current = window.setTimeout(() => setHintShown(true), SILENCE_HINT_MS);

      // chwila na przeczytanie polecenia
      const prep = Number(s.prep_ms ?? 800);
      const dwell = Number(s.dwell_ms ?? 12000);

      window.setTimeout(() => {
        startWhisperChunks();
        // kończymy okno SAY po upływie dwell i idziemy dalej
        window.setTimeout(() => {
          stopWhisperChunks();
          setHintShown(false);
          nextStep(i);
        }, dwell);
      }, prep);
    }
  }

  function nextStep(i: number) {
    clearStepTimers();
    const n = (i + 1) % steps.length;
    setIdx(n);
    const s = steps[n];
    setDisplay(s?.mode === "VERIFY" ? s?.target || "" : s?.prompt || "");
    runStep(n);
  }

  // ======== session ========
  const startSession = async () => {
    if (!steps.length) return;
    const ok = await startAV();
    if (!ok) return;
    setIsRunning(true);
    setIdx(0);
    setDisplay(steps[0]?.mode === "VERIFY" ? steps[0]?.target || "" : steps[0]?.prompt || "");
    startCountdown(MAX_TIME);
    runStep(0);
  };

  function stopSession(autoEnd = false) {
    setIsRunning(false);
    stopWhisperChunks();
    stopCountdown();
    clearStepTimers();
    stopAV();
    if (autoEnd) {
      // szybki komunikat końcowy
      setDisplay("To koniec dzisiejszej sesji — jeśli chcesz, możesz jeszcze chwilę porozmawiać ze sobą.");
    }
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // ======== styles ========
  const wrap: React.CSSProperties = { display: "flex", flexDirection: "column", minHeight: "100vh", color: "#fff", background: "#000" };
  const topbar: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)"
  };
  const titleRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
  const timerStyle: React.CSSProperties = { fontVariantNumeric: "tabular-nums", fontWeight: 600 };
  const stage: React.CSSProperties = { position: "relative", flex: 1, display: "flex" };
  const videoStyle: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover", transform: mirror ? "scaleX(-1)" : "none" };

  const overlay: React.CSSProperties = {
    position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none"
  };
  const centerCol: React.CSSProperties = { maxWidth: 780, textAlign: "center", padding: "0 16px" };

  const displayTextStyle: React.CSSProperties = {
    fontSize: 26, lineHeight: 1.35, marginBottom: 18, whiteSpace: "pre-wrap"
  };

  const sayTextStyle: React.CSSProperties = {
    fontSize: 22, lineHeight: 1.35, whiteSpace: "pre-wrap", marginTop: 8
  };

  const hintStyle: React.CSSProperties = {
    marginTop: 18, fontSize: 16, opacity: hintShown ? 0.98 : 0, transition: "opacity 200ms ease"
  };

  const vuWrap: React.CSSProperties = { position: "absolute", right: 8, top: 60, width: 8, height: 160, background: "rgba(255,255,255,0.08)", borderRadius: 6 };
  const vuFill: React.CSSProperties = { position: "absolute", bottom: 0, left: 0, right: 0, height: `${vu}%`, background: "rgba(255,255,255,0.9)", borderRadius: 6 };

  return (
    <main style={wrap}>
      <header style={topbar}>
        <div style={titleRow}>
          <span><b>Użytkownik:</b> demo</span>
          <span>•</span>
          <span><b>Dzień programu:</b> {DAY_LABEL}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={timerStyle}>{fmt(remaining)}</span>
          {!isRunning ? (
            <button onClick={startSession} style={{ pointerEvents: "auto" }}>Start</button>
          ) : (
            <button onClick={() => stopSession(false)} style={{ pointerEvents: "auto" }}>Stop</button>
          )}
        </div>
      </header>

      <div style={stage}>
        <video ref={videoRef} autoPlay playsInline muted className="cam" style={videoStyle} />

        {/* overlay */}
        <div style={overlay}>
          <div style={centerCol}>
            {!isRunning ? (
              <>
                <div style={{ fontSize: 18, opacity: 0.92 }}>
                  Twoja sesja potrwa około <b>6 minut</b>.<br />
                  <br />
                  Prosimy o powtarzanie na głos wyświetlanych treści.
                </div>
                <div style={{ marginTop: 8, fontSize: 14, opacity: 0.85 }}>
                  Aktywowano analizator dźwięku MeRoar
                </div>
              </>
            ) : (
              <>
                <div style={displayTextStyle}>{display}</div>
                {/* transkrypcja użytkownika — NA ŚRODKU (pod komendą) */}
                {sayText && <div style={sayTextStyle}>{sayText}</div>}
                {/* jedno przypomnienie po 7s ciszy */}
                <div style={hintStyle}>Jeśli możesz, postaraj się przeczytać na głos.</div>
              </>
            )}
          </div>

          {/* prosty VU po prawej */}
          {isRunning && (
            <div style={vuWrap}>
              <div style={vuFill} />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}



