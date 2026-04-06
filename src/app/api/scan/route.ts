import { NextRequest, NextResponse } from "next/server";

import { analyzeUrl } from "@/lib/scanner/analyze";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { url?: string };
    const input = body.url?.trim();

    if (!input) {
      return NextResponse.json(
        { error: "Enter a URL to scan." },
        { status: 400 },
      );
    }

    const result = await analyzeUrl(input);

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The scan could not be completed for this URL.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
