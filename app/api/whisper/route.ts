import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    // 🔧 obsługa obu nazw pól — 'file' (desktop) i 'audio' (mobile)
    let file = formData.get("file");
    if (!file) file = formData.get("audio");

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No audio file received" }, { status: 400 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ✅ używamy najnowszego modelu transkrypcji (PL działa poprawnie)
    const response = await openai.audio.transcriptions.create({
      file,
      model: "gpt-4o-mini-transcribe", // szybki, nowy model
      language: "pl", // wymusza polski
      temperature: 0.2,
    });

    return NextResponse.json({ text: (response.text || "").trim() });
  } catch (err: any) {
    console.error("[/api/whisper] error:", err);
    return NextResponse.json(
      { error: err.message || "Whisper failed" },
      { status: 500 }
    );
  }
}

// Prosty healthcheck endpoint
export async function GET() {
  return NextResponse.json({ ok: true, service: "whisper" });
}

