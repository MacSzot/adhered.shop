"use client";

import React, { useEffect, useRef, useState } from "react";

/** ---------- Konfiguracja ---------- */
const MAX_SESSION_SEC = 6 * 60; // 6 minut
const HINT_1 = "Jeśli możesz, postaraj się przeczytać na głos.";
const HINT_2 = "Pamiętaj — to przestrzeń pełna szacunku do Ciebie.";
const HINT_3 = "Jeśli chcesz kontynuować, dotknij ekranu.";
const HINTS: Record<1 | 2 | 3, string> = { 1: HINT_1, 2: HINT_2, 3: HINT_3 };

type Step =
  | { mode: "VERIFY"; text: string; dwellMs?: number }
  | { mode: "SAY"; prompt: string; dwellMs?: number };

const DAY3: Step[] = [
  { mode: "VERIFY", text: "Jestem w bardzo dobrym miejscu.", dwellMs: 4000 },
  { mode: "VERIFY", text: "Szacunek do siebie staje się naturalny.", dwellMs: 4000 },
  { mode: "SAY", prompt: "Popatrz na siebie i podziękuj sobie. Zrób to ze spokojem — Twoje słowa wyświetlą się na ekranie.", dwellMs: 12000 },
  { mode: "VERIFY", text: "W moim wnętrzu dojrzewa spokój i zgoda.", dwellMs: 4000 },
  { mode: "SAY", prompt: "Popatrz na siebie i przyznaj sobie rację. Zrób to z przekonaniem — Twoje słowa wyświetlą się na ekranie.", dwellMs: 12000 },
  { mode: "VERIFY", text: "Doceniam to, jak wiele już zostało zrobione.", dwellMs: 4000 },
  { mode: "SAY", prompt: "Popatrz na siebie i pogratuluj sobie. Zrób to z radością — Twoje słowa wyświetlą się na ekranie.", dwellMs: 12000 },
];

/** ---------- Pomocnicze ---------- */
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export default function PrompterPage() {
  const [running, setRunning] = useState(false);
  const [remain, setRemain] = useState(MAX_SESSION_SEC);
  const [stepIdx, setStepIdx] = useState(0);
  const [hintStage, setHintStage] = useState<0 | 1 | 2 | 3>(0);
  const [transcript, setTranscript] = useState("");
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const countdownRef = useRef<number | null>(null);
  const stepTimerRef = useRef<number | null>(null);
  const sayChunkTimerRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  /** ---- Start/Stop sesji ---- */
  const start = async () => {
    cleanupAll();
    setErr(null);
    setTranscript("");
    setStepIdx(0);
    setHintStage(0);
    setRemain(MAX_SESSION_SEC);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      if (videoRef.current) (videoRef.current as any).srcObject = stream;

      // AudioContext + analyser do VAD
      const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ac = new AC();
      acRef.current = ac;
      const src = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.85;
      src.connect(analyser);
      analyserRef.current = analyser;

      // MediaRecorder → Whisper
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
      const chunks: BlobPart[] = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = async () => {
        if (!chunks.length) return;
        const blob = new Blob(chunks, { type: "audio/webm" });
        chunks.length = 0;
        await sendChunkToWhisper(blob);
      };
      mediaRecorderRef.current = mr;

      // VAD pętla
      const buf = new Uint8Array(1024);
      let lastVoiceAt = Date.now();
      const loop = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(buf);
        let peak = 0, sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
          const x = (buf[i] - 128) / 128;
          const a = Math.abs(x);
          if (a > peak) peak = a;
          sumSq += x * x;
        }
        const rms = Math.sqrt(sumSq / buf.length);
        const vu = Math.min(100, peak * 500);
        setLevel((prev) => Math.max(vu, prev * 0.85));

        const speaking = rms > 0.02 || peak > 0.05 || vu > 8;
        if (speaking) {
          lastVoiceAt = Date.now();
          if (hintStage > 0) setHintStage(0);
        }
        // po 7 s ciszy pokazuj kolejne wskazówki, max do 3
        if (Date.now() - lastVoiceAt > 7000 && hintStage < 3) {
          setHintStage((h) => ((h === 0 ? 1 : (h + 1) as 1 | 2 | 3)));
          lastVoiceAt = Date.now();
        }

        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);

      // licznik sesji
      countdownRef.current = window.setInterval(() => {
        setRemain((r) => {
          if (r <= 1) { stop(); return 0; }
          return r - 1;
        });
      }, 1000);

      setRunning(true);
      runStep(0);
    } catch (e: any) {
      setErr(e?.message || "Nie udało się uruchomić kamery/mikrofonu.");
      stop();
    }
  };

  const stop = () => {
    setRunning(false);
    cleanupAll();
  };

  const cleanupAll = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    if (countdownRef.current) window.clearInterval(countdownRef.current);
    countdownRef.current = null;

    if (stepTimerRef.current) window.clearTimeout(stepTimerRef.current);
    stepTimerRef.current = null;

    if (sayChunkTimerRef.current) window.clearInterval(sayChunkTimerRef.current);
    sayChunkTimerRef.current = null;

    if (mediaRecorderRef.current) {
      try { mediaRecorderRef.current.stop(); } catch {}
      mediaRecorderRef.current = null;
    }

    if (acRef.current) { try { acRef.current.close(); } catch {} acRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }

    analyserRef.current = null;
    setLevel(0);
  };

  /** ---- Kroki ---- */
  const runStep = (i: number) => {
    if (!DAY3[i]) return;
    setStepIdx(i);
    setTranscript("");

    const s = DAY3[i];
    const dwell = Math.max(2000, s.dwellMs ?? (s.mode === "SAY" ? 12000 : 4000));

    // SAY → nagrywanie chunków co 4s
    if (s.mode === "SAY" && mediaRecorderRef.current) {
      try { mediaRecorderRef.current.start(); } catch {}
      sayChunkTimerRef.current = window.setInterval(() => {
        if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== "recording") return;
        mediaRecorderRef.current.stop();
        try { mediaRecorderRef.current.start(); } catch {}
      }, 4000);
    }

    stepTimerRef.current = window.setTimeout(() => {
      if (sayChunkTimerRef.current) { window.clearInterval(sayChunkTimerRef.current); sayChunkTimerRef.current = null; }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") { try { mediaRecorderRef.current.stop(); } catch {} }

      const next = i + 1;
      if (next < DAY3.length) runStep(next);
      else stop();
    }, dwell);
  };

  /** ---- Whisper ---- */
  const sendChunkToWhisper = async (blob: Blob) => {
    try {
      const fd = new FormData();
      fd.append("audio", blob, "clip.webm");
      const r = await fetch("/api/whisper", { method: "POST", body: fd });
      if (!r.ok) return;
      const j = await r.json();
      const t = (j?.text || "").trim();
      if (t) setTranscript((prev) => (prev ? prev + " " + t : t));
    } catch { /* spokojnie – fallback tylko na VAD */ }
  };

  /** ---- Layout guards ---- */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const current = DAY3[stepIdx];

  return (
    <main style={styles.root}>
      {/* Topbar */}
      <header style={styles.topbar}>
        <div style={styles.badgeRow}>
          <span style={styles.meta}><b>Użytkownik:</b> demo</span>
          <span style={{ padding: "0 8px", opacity: 0.6 }}>•</span>
          <span style={styles.meta}><b>Dzień programu:</b> 3</span>
        </div>
        <div>
          {!running ? (
            <button style={styles.btn} onClick={start}>Start</button>
          ) : (
            <button style={styles.btn} onClick={stop}>Stop</button>
          )}
        </div>
      </header>

      {/* Timer */}
      <div style={styles.timer}>{fmt(remain)}</div>

      {/* Scena */}
      <div style={styles.stage}>
        <video ref={videoRef} autoPlay playsInline muted style={styles.cam} />
        <div style={styles.overlay}>
          {/* środek */}
          <div style={styles.centerBlock}>
            {current?.mode === "VERIFY" && <div style={styles.verifyText}>{current.text}</div>}
            {current?.mode === "SAY" && <div style={styles.verifyText}>{current.prompt}</div>}
          </div>

          {/* transkrypcja u góry */}
          {transcript && <div style={styles.transcriptTop}>{transcript}</div>}

          {/* przypominajka – max 3 razy */}
          {hintStage > 0 && <div style={styles.hintCenter}>{HINTS[hintStage]}</div>}
        </div>

        {/* VU-meter */}
        <div style={styles.meter}><div style={{ ...styles.meterFill, height: `${level}%` }} /></div>
      </div>

      {err && <div style={styles.error}>{err}</div>}
    </main>
  );
}

/** ---------- Style ---------- */
const styles: Record<string, React.CSSProperties> = {
  root: { position: "fixed", inset: 0, background: "#000", color: "#fff", fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial" },

  topbar: { position: "absolute", left: 0, right: 0, top: 0, height: 64, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", background: "rgba(20,20,20,0.55)", backdropFilter: "blur(6px)", zIndex: 20 },
  badgeRow: { display: "flex", alignItems: "center", gap: 4, fontSize: 14 },
  meta: { opacity: 0.95 },
  btn: { padding: "8px 14px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.08)", color: "#fff", cursor: "pointer" },

  timer: { position: "absolute", top: 84, left: 0, right: 0, textAlign: "center", fontSize: 46, fontWeight: 800, textShadow: "0 2px 6px rgba(0,0,0,0.6)", zIndex: 15 },

  stage: { position: "absolute", inset: 0, overflow: "hidden" },
  cam: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" },
  overlay: { position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: "84px 16px 16px 16px" },

  centerBlock: { maxWidth: 800, textAlign: "center", padding: "0 12px" },
  verifyText: { fontSize: 28, lineHeight: 1.35, textShadow: "0 2px 6px rgba(0,0,0,0.55)" },

  transcriptTop: { position: "absolute", top: 128, left: 0, right: 0, textAlign: "center", fontSize: 18, padding: "0 16px", textShadow: "0 2px 6px rgba(0,0,0,0.55)", pointerEvents: "none" },

  hintCenter: { position: "absolute", bottom: "18%", left: 0, right: 0, textAlign: "center", fontSize: 18, opacity: 0.95, textShadow: "0 2px 6px rgba(0,0,0,0.55)", pointerEvents: "none" },

  meter: { position: "absolute", top: 84, bottom: 16, right: 10, width: 8, background: "rgba(255,255,255,0.2)", borderRadius: 8, overflow: "hidden" },
  meterFill: { position: "absolute", left: 0, right: 0, bottom: 0, background: "#7CFC00" },

  error: { position: "absolute", bottom: 12, left: 12, right: 12, padding: "10px 12px", background: "rgba(160,0,0,0.6)", borderRadius: 10, fontSize: 14 },
};


}



