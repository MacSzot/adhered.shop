export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import OpenAI from "openai";

// Ping GET — szybki test, czy endpoint żyje
export async function GET() {
  return new Response(JSON.stringify({ ok: true, service: "whisper" }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

// POST — przyjmuje multipart/form-data z polem "file"
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return new Response(JSON.stringify({ error: "file missing" }), { status: 400 });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const tr = await client.audio.transcriptions.create({
      model: "whisper-1",
      file,
      // language: "pl", // opcjonalnie
    });

    return new Response(JSON.stringify({ text: tr.text ?? "" }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "server error" }), {
      headers: { "content-type": "application/json" },
      status: 500,
    });
  }
}
