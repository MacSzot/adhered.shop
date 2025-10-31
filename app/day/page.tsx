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

  const USER_NAME = "demo";
  const dayRaw = typeof window !== "undefined" ? getParam("day", "01") : "01";
  const dayFileParam = dayRaw.padStart(2, "0");
  const DAY_LABEL = (() => {
    const n = parseInt(dayRaw, 10);
    return Number.isNaN(n) ? dayRaw : String(n);
  })();

  const MAX_TIME = 6 * 60; // 6 minut

  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [idx, setIdx] = useState(0);
  const [displayText, setDisplayText] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [remaining, setRemaining] = useState(MAX_TIME);
  const [micError, setMicError] = useState<string | null>(null);

  /* ---- 1) Wczytaj plan ---- */
  useEffect(() => {
    (async () => {
      try {
        const { source, steps } = await loadDayPlanOrTxt(dayFileParam);
        setSteps(steps);
        setIdx(0);
        setDisplayText(steps[0]?.target || "");
        console.log(`[DAY ${dayFileParam}] source:`, source, `steps: ${steps.length}`);
      } catch (e) {
        console.error(e);
        const fallback = [{ mode: "VERIFY" as const, target: "Brak treści dla tego dnia." }];
        setSteps(fallback);
        setDisplayText(fallback[0].target!);
      }
    })();
  }, []);

  const startSession = () => {
    setIsRunning(true);
    setIdx(0);
  };

  const stopSession = () => {
    setIsRunning(false);
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

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

      {/* ZEGAR NA ŚRODKU */}
      {isRunning && (
        <div style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          fontSize: 64,
          fontWeight: "bold",
          color: "white",
          textShadow: "0 2px 8px rgba(0,0,0,0.7)",
          zIndex: 10
        }}>
          {fmt(remaining)}
        </div>
      )}

      <div className="stage mirrored">
        <video ref={videoRef} autoPlay playsInline muted className="cam" />

        {/* INTRO */}
        {!isRunning && (
          <div className="overlay center">
            <div
              style={{
                textAlign: "center",
                maxWidth: 600,
                margin: "0 auto",
                color: "white",
                fontSize: 18,
                lineHeight: 1.6,
                textShadow: "0 1px 3px rgba(0,0,0,0.8)",
              }}
            >
              <p>
                Twoja sesja potrwa około <b>6 minut</b>.<br />
                Postaraj się <b>wyraźnie powtarzać</b> wyświetlane treści.
              </p>
            </div>

            {/* LOGO MEROAR */}
            <img
              src="/assets/meroar-supervised.png"
              alt="Supervised by MeRoar & adhered."
              style={{
                position: "absolute",
                bottom: 32,
                left: "50%",
                transform: "translateX(-50%)",
                width: "85%",
                maxWidth: 420,
                opacity: 0.9,
              }}
            />
          </div>
        )}
      </div>
    </main>
  );
}

