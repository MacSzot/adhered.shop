import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    // akceptujemy "audio" (front) oraz "file" (fallback)
    const file = (formData.get("audio") || formData.get("file")) as File | null;

    if (!file) {
      return NextResponse.json({ error: "No audio file received" }, { status: 400 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const resp = await openai.audio.transcriptions.create({
      file,
      model: "gpt-4o-mini-transcribe", // lub: "whisper-1"
      // language: "pl", // opcjonalnie, ale nie wymagane
      // response_format: "json", // domyślnie json
    });

    return NextResponse.json({ text: resp.text || "" });
  } catch (err: any) {
    console.error("Whisper error:", err);
    return NextResponse.json(
      { error: err?.message || "Whisper failed" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "whisper" });
}

