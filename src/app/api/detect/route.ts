import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { detectRequestSchema } from "@/lib/detection/schema";
import { runDetectionOrchestrator } from "@/lib/detection/orchestrator";
import { detectLanguageHeuristic, hashTextSha256, normalizeForHash } from "@/lib/detection/utils";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const COOLDOWN_WINDOW_MS = 45_000;
const MAX_REPEAT_WITH_DETAILS = 2;

type GuardState = {
  windowStart: number;
  requestCount: number;
  lastHashes: Array<{ hash: string; at: number }>;
};

const guardStore = new Map<string, GuardState>();

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown-ip"
  );
}

function getBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice("Bearer ".length).trim();
}

function applyAbuseGuards(identityKey: string, textHash: string) {
  const now = Date.now();
  const state = guardStore.get(identityKey) || {
    windowStart: now,
    requestCount: 0,
    lastHashes: [],
  };

  if (now - state.windowStart > RATE_LIMIT_WINDOW_MS) {
    state.windowStart = now;
    state.requestCount = 0;
  }

  state.requestCount += 1;
  if (state.requestCount > RATE_LIMIT_MAX) {
    guardStore.set(identityKey, state);
    return {
      blocked: true,
      reason: "rate_limited",
      reducedDetail: true,
    } as const;
  }

  state.lastHashes = state.lastHashes.filter((entry) => now - entry.at <= COOLDOWN_WINDOW_MS);
  const repeatedCount = state.lastHashes.filter((entry) => entry.hash === textHash).length;
  state.lastHashes.push({ hash: textHash, at: now });
  guardStore.set(identityKey, state);

  return {
    blocked: false,
    reason: null,
    reducedDetail: repeatedCount >= MAX_REPEAT_WITH_DETAILS,
  } as const;
}

export const __testOnly = {
  applyAbuseGuards,
};

async function persistDetectionScan({
  supabaseUrl,
  supabasePublicKey,
  token,
  userId,
  text,
  textHash,
  privacyMode,
  result,
}: {
  supabaseUrl: string;
  supabasePublicKey: string;
  token: string;
  userId: string;
  text: string;
  textHash: string;
  privacyMode: "no_log" | "hash_only" | "full_text_opt_in";
  result: Awaited<ReturnType<typeof runDetectionOrchestrator>>;
}) {
  if (privacyMode === "no_log") {
    return;
  }

  const userScopedSupabase = createClient(supabaseUrl, supabasePublicKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  await userScopedSupabase.from("detection_scans").insert({
    user_id: userId,
    text_hash: textHash,
    text_length: text.length,
    privacy_mode: privacyMode,
    risk_band: result.summary.riskBand,
    ensemble_score: result.summary.ensembleScore,
    disagreement_score: result.summary.disagreement,
    calibrator_version: result.summary.calibratorVersion,
    detectors_summary: result.detectors.map((detector) => ({
      id: detector.id,
      status: detector.status,
      label: detector.label,
      score: detector.score,
      confidence: detector.confidence,
      latency_ms: detector.latencyMs,
    })),
    explainability_signals: result.explainabilitySignals,
    raw_text: privacyMode === "full_text_opt_in" ? text : null,
  });
}

export async function POST(request: Request) {
  try {
    const token = getBearerToken(request);
    if (!token) {
      return NextResponse.json({ error: "Missing access token." }, { status: 401 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabasePublicKey =
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabasePublicKey) {
      return NextResponse.json(
        { error: "Supabase env vars missing for detect endpoint." },
        { status: 500 },
      );
    }

    const supabase = createClient(supabaseUrl, supabasePublicKey);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: "Session is invalid." }, { status: 401 });
    }

    const body = await request.json();
    const parsed = detectRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid detect request body." }, { status: 400 });
    }

    const normalizedText = parsed.data.text.trim();
    const textHash = hashTextSha256(normalizeForHash(normalizedText));
    const identity = `${user.id}:${getClientIp(request)}`;
    const guardResult = applyAbuseGuards(identity, textHash);
    if (guardResult.blocked) {
      return NextResponse.json(
        {
          error: "Too many detection requests. Please wait a minute before rescanning.",
          code: "rate_limited",
        },
        { status: 429 },
      );
    }

    const language = parsed.data.context?.language || detectLanguageHeuristic(normalizedText);
    const mode = parsed.data.context?.mode || "general";
    const orchestrated = await runDetectionOrchestrator({
      text: normalizedText,
      mode,
      language,
      vendorConsent: Boolean(parsed.data.vendor_consent),
      detailsEnabled: Boolean(parsed.data.details_enabled),
      reducedDetail: guardResult.reducedDetail,
    });

    await persistDetectionScan({
      supabaseUrl,
      supabasePublicKey,
      token,
      userId: user.id,
      text: normalizedText,
      textHash,
      privacyMode: parsed.data.privacy_mode,
      result: orchestrated,
    });

    return NextResponse.json({
      ...orchestrated,
      limitations:
        "Signals are probabilistic and should not be treated as proof. Detector behavior can vary by text length, domain, and language.",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unexpected detect server error.",
      },
      { status: 500 },
    );
  }
}

