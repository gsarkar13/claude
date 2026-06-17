import Groq from "groq-sdk";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { text, mode } = await req.json();

    if (!text) {
      return NextResponse.json({ error: "No text provided" }, { status: 400 });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GROQ_API_KEY not configured" }, { status: 500 });
    }

    const groq = new Groq({ apiKey });

    const prompts: Record<string, string> = {
      fix: `Fix grammar, punctuation, and spelling. Return only the corrected text:\n\n${text}`,
      formal: `Rewrite in a formal, professional tone. Return only the rewritten text:\n\n${text}`,
      bullet: `Convert into a clean bulleted list of key points. Return only the bullet points:\n\n${text}`,
      email: `Format as a professional email body (no subject line). Return only the email body:\n\n${text}`,
      slack: `Make concise and suitable for a Slack message. Keep it casual. Return only the message:\n\n${text}`,
      translate: `The following text may be in Bengali, Hindi, English, or a mix. Translate it fully into clear English. Return only the translated text:\n\n${text}`,
    };

    const prompt = prompts[mode] ?? prompts.fix;

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
      temperature: 0.3,
    });

    const result = completion.choices[0]?.message?.content ?? "";
    return NextResponse.json({ text: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Cleanup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
