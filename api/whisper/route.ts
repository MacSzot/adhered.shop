export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import OpenAI from "openai";

export async function GET() {
  return new Response(JSON.stringify({ ok: true, service: "whisper" }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return new Response(JSON.stringify({ error: "file missing" }), { status: 400 });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    // Minimalny, stabilny wariant
    const tr = await client.audio.transcriptions.create({
      file,
      model: "whisper-1",
      // language: "pl", // opcjonalnie
      // response_format: "json", // domyślnie ok
    });

    return new Response(JSON.stringify({ text: tr.text ?? "" }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  } catch (e: any) {
    const msg = e?.message || "server error";
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
