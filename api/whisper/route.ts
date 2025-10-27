import { NextResponse } from "next/server";
import OpenAI from "openai";

// uruchamiane w środowisku edge (szybsze)
export const runtime = "edge";
export const maxDuration = 15; // maksymalny czas żądania (sekundy)

export async function POST(req: Request) {
  try {
    // odbieramy dane audio z formularza
    const form = await req.formData();
    const file = form.get("file");

    // walidacja — czy przyszło nagranie?
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file" }, { status: 400 });
    }

    // inicjalizacja OpenAI SDK z kluczem z ENV
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // wysyłamy audio do Whispera
    const result = await openai.audio.transcriptions.create({
      file,               // plik audio (.webm / .mp3 / .m4a / .wav)
      model: "whisper-1", // model transkrypcji
      language: "pl"      // wymuszamy język polski
    });

    // zwracamy tekst jako JSON
    return NextResponse.json({ text: result.text || "" });
  } catch (err: any) {
    console.error("Whisper error:", err);
    return NextResponse.json(
      { error: err?.message || "Transcription failed" },
      { status: 500 }
    );
  }
}
