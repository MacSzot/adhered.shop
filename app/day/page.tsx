"use client";
import { useEffect, useRef, useState } from "react";

export default function DayPage() {
  // ── minimalny stan ─────────────────────────────
  const [running, setRunning] = useState(false);
  const [t, setT] = useState(360); // 6:00
  const [i, setI] = useState(0);

  // Teksty (Day 3 + 3 otwarte)
  const LINES = [
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
  ];

  // ── timer + zmiana slajdów ─────────────────────
  const tickRef = useRef<number | null>(null);
  const slideRef = useRef<number | null>(null);

  function start() {
    setRunning(true);
    setT(360);
    setI(0);
  }

  function stop() {
    setRunning(false);
    if (tickRef.current) clearInterval(tickRef.current);
    if (slideRef.current) clearInterval(slideRef.current);
  }

  useEffect(() => {
    if (!running) return;

    // zegar
    tickRef.current = window.setInterval(() => {
      setT((s) => {
        if (s <= 1) {
          stop();
          return 0;
        }
        return s - 1;
      });
    }, 1000);

    // zmiana tekstu co 7s
    slideRef.current = window.setInterval(() => {
      setI((prev) => (prev + 1) % LINES.length);
    }, 7000);

    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      if (slideRef.current) clearInterval(slideRef.current);
    };
  }, [running]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // ── stałe style wymuszające środek ekranu ──────
  const wrap: React.CSSProperties = {
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
    maxWidth: 800,
    fontSize: 28,
    lineHeight: 1.5,
    color: "#fff",
    textShadow: "0 2px 4px rgba(0,0,0,.55)",
  };

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff" }}>
      {/* topbar + przyciski */}
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
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 32 }}>{fmt(t)}</div>
          {!running ? (
            <button onClick={start} style={{ padding: "6px 14px", borderRadius: 8 }}>Start</button>
          ) : (
            <button onClick={stop} style={{ padding: "6px 14px", borderRadius: 8 }}>Stop</button>
          )}
        </div>
      </header>

      {/* intro albo sesja */}
      {!running ? (
        <div style={wrap}>
          <div style={lineStyle}>
            Twoja sesja potrwa około <b>6 minut</b>.<br />
            Prosimy o powtarzanie na głos wyświetlanych treści.
            <br /><br />
            Aktywowano analizator głosu <b>MeRoar™</b>
          </div>
        </div>
      ) : (
        <div style={wrap}>
          <div style={lineStyle}>{LINES[i]}</div>
        </div>
      )}
    </main>
  );
}


