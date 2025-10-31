// app/api/whisper/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs"; // klasyczny Node (nie edge)

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const audio = form.get("audio") as File | null;

    if (!audio) {
      return NextResponse.json({ error: "Brak pliku audio" }, { status: 400 });
    }

    // Przekazujemy do OpenAI Whisper
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Brak OPENAI_API_KEY" }, { status: 500 });
    }

    const payload = new FormData();
    payload.append("file", audio, "clip.webm");         // z przeglądarki
    payload.append("model", "whisper-1");               // model STT
    payload.append("language", "pl");                   // PL
    payload.append("response_format", "json");          // JSON (text też ok)

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: payload,
    });

    if (!r.ok) {
      const msg = await r.text();
      return NextResponse.json({ error: msg }, { status: r.status });
    }

    const data = await r.json();
    // Odpowiedź Whispera ma klucz "text" (transkrypcja)
    return NextResponse.json({ text: data.text ?? "" });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Błąd" }, { status: 500 });
  }
}


export async function GET() {
  return NextResponse.json({ ok: true, service: "whisper" });
}


