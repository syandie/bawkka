import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    // The middleware has already verified the rate limit by this point.
    // If we are here, the user is within their quota.

    const apiKey = process.env.HUGGINGFACE_API_KEY;

    if (!apiKey) {
      console.error("Hugging Face API key is missing in environment variables.");
      return NextResponse.json(
        { success: false, error: "Configuration error" }, 
        { status: 500 }
      );
    }

    const response = await fetch("https://router.huggingface.co/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "meta-llama/Llama-3.1-8B-Instruct",
        messages: [
          {
            role: "user",
            content: "Generate 3 short anonymous questions for a social media profile. Separate them ONLY with '||'. No numbers. Example: Question 1?||Question 2?||Question 3?"
          }
        ],
        max_tokens: 100,
        temperature: 0.7,
      }),
    });

    const rawText = await response.text();

    if (!response.ok) {
      console.error("HF API Error:", rawText);
      // Fallback questions to ensure the UI doesn't break for the user
      return NextResponse.json({
        success: true,
        questions: "What's your secret talent?||What is your dream job?||What is your favorite book?",
      });
    }

    const data = JSON.parse(rawText);
    const text = data.choices[0]?.message?.content?.trim() || "";

    return NextResponse.json({ success: true, questions: text });

  } catch (error: any) {
    console.error("HF Route Runtime Error:", error);
    // Silent fallback so the user still sees questions
    return NextResponse.json({
      success: true,
      questions: "What's your favorite movie?||Do you have pets?||What's your dream job?"
    });
  }
}