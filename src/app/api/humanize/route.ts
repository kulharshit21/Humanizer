import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { countWords, HUMANIZER_SYSTEM_PROMPT, MAX_WORDS_PER_REQUEST } from "@/lib/constants";
import toneProfilesData from "@/lib/tone-profiles.json";
import toneCalibrationData from "@/lib/tone-calibration.json";

const requestSchema = z.object({
  text: z.string().min(1, "Text is required."),
  tone: z
    .enum([
      "casual",
      "professional",
      "creative",
      "academic",
      "linkedin",
      "blog",
      "email",
      "simplify",
      "human-like",
    ])
    .optional(),
  strength: z.enum(["minimal", "balanced", "strong", "maximum"]).optional(),
  strengthLevel: z.number().min(0).max(100).optional(),
  styleProfile: z
    .object({
      avgSentenceLength: z.number().min(4).max(40),
      lexicalDiversity: z.number().min(0).max(100),
      preferredTone: z
        .enum([
          "casual",
          "professional",
          "creative",
          "academic",
          "linkedin",
          "blog",
          "email",
          "simplify",
          "human-like",
        ])
        .optional(),
    })
    .optional(),
});

type MistralMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type MistralResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type ValidationResult = {
  qualityScore: number;
  issues: string[];
};

type GenerationConfig = {
  temperature: number;
  topP: number;
  maxTokens: number;
};

type ToneProfile = {
  instruction: string;
  requiredStyleRules: string[];
  blockedPatterns: string[];
  defaultDecoding: {
    temperatureDelta: number;
    topPDelta: number;
  };
};

type ToneCalibrationEntry = {
  temperatureDelta: number;
  topPDelta: number;
  sampleCount?: number;
};

const MAX_ATTEMPTS = 3;
const MIN_QUALITY_SCORE = 72;
const MIN_REWRITE_CHANGE_RATIO = 0.18;
const MAX_EM_DASH_COUNT = 1;

const BANNED_PHRASES = [
  "great question",
  "i hope this helps",
  "delve into",
  "in today's fast-paced world",
  "as an ai language model",
  "in conclusion",
  "it's important to note",
  "furthermore",
  "moreover",
  "additionally",
];

const TONE_PROFILES = toneProfilesData as Record<string, ToneProfile>;
const TONE_CALIBRATION = toneCalibrationData as {
  updatedAt: string | null;
  source: string;
  tones: Record<string, ToneCalibrationEntry>;
};

const STRENGTH_INSTRUCTIONS: Record<string, string> = {
  minimal: "Keep changes minimal: improve awkward phrasing but preserve structure closely.",
  balanced: "Balance clarity and naturalness with moderate rewriting.",
  strong: "Apply assertive rewriting to improve flow and readability substantially.",
  maximum:
    "Maximize humanization while preserving meaning; allow broad sentence restructuring.",
};

const DECODING_PRESETS: Record<string, GenerationConfig> = {
  minimal: {
    temperature: 0.28,
    topP: 0.86,
    maxTokens: 1400,
  },
  balanced: {
    temperature: 0.42,
    topP: 0.9,
    maxTokens: 1500,
  },
  strong: {
    temperature: 0.55,
    topP: 0.93,
    maxTokens: 1600,
  },
  maximum: {
    temperature: 0.62,
    topP: 0.95,
    maxTokens: 1700,
  },
};

type StrengthMode = "minimal" | "balanced" | "strong" | "maximum";

const STRENGTH_LEVEL_ANCHORS: Array<{ level: number; mode: StrengthMode }> = [
  { level: 0, mode: "minimal" },
  { level: 33, mode: "balanced" },
  { level: 66, mode: "strong" },
  { level: 100, mode: "maximum" },
];

function clampStrengthLevel(level: number): number {
  return Math.max(0, Math.min(100, level));
}

function getStrengthModeFromLevel(level: number): StrengthMode {
  if (level < 25) {
    return "minimal";
  }
  if (level < 55) {
    return "balanced";
  }
  if (level < 80) {
    return "strong";
  }
  return "maximum";
}

function interpolateConfig(
  left: GenerationConfig,
  right: GenerationConfig,
  ratio: number,
): GenerationConfig {
  return {
    temperature: left.temperature + (right.temperature - left.temperature) * ratio,
    topP: left.topP + (right.topP - left.topP) * ratio,
    maxTokens: Math.round(left.maxTokens + (right.maxTokens - left.maxTokens) * ratio),
  };
}

function getGenerationConfigForStrengthLevel(level: number): GenerationConfig {
  const clampedLevel = clampStrengthLevel(level);
  for (let index = 0; index < STRENGTH_LEVEL_ANCHORS.length - 1; index += 1) {
    const left = STRENGTH_LEVEL_ANCHORS[index];
    const right = STRENGTH_LEVEL_ANCHORS[index + 1];
    if (clampedLevel >= left.level && clampedLevel <= right.level) {
      const span = Math.max(1, right.level - left.level);
      const ratio = (clampedLevel - left.level) / span;
      return interpolateConfig(DECODING_PRESETS[left.mode], DECODING_PRESETS[right.mode], ratio);
    }
  }
  return DECODING_PRESETS.maximum;
}

function getStyleProfileInstruction(
  styleProfile:
    | {
        avgSentenceLength: number;
        lexicalDiversity: number;
        preferredTone?: string;
      }
    | undefined,
): string | null {
  if (!styleProfile) {
    return null;
  }
  return [
    "Match the user's writing fingerprint where possible.",
    `Target average sentence length around ${styleProfile.avgSentenceLength.toFixed(1)} words.`,
    `Target lexical diversity around ${styleProfile.lexicalDiversity.toFixed(1)}%.`,
    styleProfile.preferredTone ? `If meaning allows, align rhythm with ${styleProfile.preferredTone} tone.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function getBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice("Bearer ".length).trim();
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9']/g, "");
}

function getTokenSet(text: string): Set<string> {
  return new Set(
    text
      .split(/\s+/)
      .map(normalizeToken)
      .filter((token) => token.length > 2),
  );
}

function getJaccardSimilarity(inputText: string, outputText: string): number {
  const inputTokens = getTokenSet(inputText);
  const outputTokens = getTokenSet(outputText);

  if (inputTokens.size === 0 && outputTokens.size === 0) {
    return 1;
  }

  let intersectionCount = 0;
  for (const token of inputTokens) {
    if (outputTokens.has(token)) {
      intersectionCount += 1;
    }
  }

  const unionCount = new Set([...inputTokens, ...outputTokens]).size;
  return unionCount === 0 ? 0 : intersectionCount / unionCount;
}

function extractSquareBracketCitations(text: string): string[] {
  const matches = text.match(/\[(?:\d+(?:\s*[-,]\s*\d+)*)\]/g);
  if (!matches) {
    return [];
  }
  return matches.map((marker) => marker.replace(/\s+/g, ""));
}

function extractAuthorYearCitations(text: string): string[] {
  const matches = text.match(/\([A-Z][^()]*?\b(?:19|20)\d{2}[a-z]?\)/g);
  if (!matches) {
    return [];
  }
  return matches.map((marker) => marker.replace(/\s+/g, " ").trim());
}

function getMissingMarkers(requiredMarkers: string[], outputMarkers: string[]): string[] {
  const outputCounts = new Map<string, number>();
  for (const marker of outputMarkers) {
    outputCounts.set(marker, (outputCounts.get(marker) || 0) + 1);
  }

  const missing: string[] = [];
  for (const marker of requiredMarkers) {
    const count = outputCounts.get(marker) || 0;
    if (count <= 0) {
      missing.push(marker);
    } else {
      outputCounts.set(marker, count - 1);
    }
  }
  return missing;
}

function hasCitationMarkers(text: string): boolean {
  return (
    extractSquareBracketCitations(text).length > 0 || extractAuthorYearCitations(text).length > 0
  );
}

function getValidationResult(inputText: string, outputText: string): ValidationResult {
  const issues: string[] = [];
  let qualityScore = 100;

  const normalizedInput = inputText.trim().toLowerCase();
  const normalizedOutput = outputText.trim().toLowerCase();
  const inputWordCount = Math.max(1, countWords(inputText));
  const outputWordCount = Math.max(1, countWords(outputText));
  const lengthRatio = outputWordCount / inputWordCount;
  const similarity = getJaccardSimilarity(inputText, outputText);
  const rewriteChangeRatio = 1 - similarity;

  if (normalizedInput === normalizedOutput) {
    issues.push("Output is unchanged from input.");
    qualityScore -= 55;
  }

  if (rewriteChangeRatio < MIN_REWRITE_CHANGE_RATIO) {
    issues.push("Rewrite is too close to the original text.");
    qualityScore -= 30;
  }

  if (lengthRatio < 0.55 || lengthRatio > 1.8) {
    issues.push("Output length diverges too much from input.");
    qualityScore -= 20;
  }

  const lowerOutput = outputText.toLowerCase();
  const bannedMatches = BANNED_PHRASES.filter((phrase) => lowerOutput.includes(phrase));
  if (bannedMatches.length > 0) {
    issues.push(`Contains banned AI-like phrase(s): ${bannedMatches.join(", ")}.`);
    qualityScore -= Math.min(30, bannedMatches.length * 8);
  }

  const repeatedPattern = /(\b\w+\b)(?:\s+\1){2,}/i;
  if (repeatedPattern.test(outputText)) {
    issues.push("Contains repetitive phrasing artifacts.");
    qualityScore -= 10;
  }

  const emDashMatches = outputText.match(/—/g);
  const emDashCount = emDashMatches ? emDashMatches.length : 0;
  if (emDashCount > MAX_EM_DASH_COUNT) {
    issues.push(`Uses too many em dashes (${emDashCount}).`);
    qualityScore -= Math.min(20, (emDashCount - MAX_EM_DASH_COUNT) * 6);
  }

  const sentenceStarts = outputText
    .split(/[.!?]+\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence) => sentence.toLowerCase().split(/\s+/)[0] || "");
  const repeatedStarts = sentenceStarts.filter(
    (word, index) =>
      index > 0 && word.length > 0 && word === sentenceStarts[index - 1],
  );
  if (repeatedStarts.length >= 2) {
    issues.push("Too many repeated sentence openings.");
    qualityScore -= 10;
  }

  const inputSquareCitations = extractSquareBracketCitations(inputText);
  const outputSquareCitations = extractSquareBracketCitations(outputText);
  const missingSquareCitations = getMissingMarkers(inputSquareCitations, outputSquareCitations);
  if (missingSquareCitations.length > 0) {
    issues.push(
      `Missing citation marker(s): ${[...new Set(missingSquareCitations)].slice(0, 8).join(", ")}.`,
    );
    qualityScore -= Math.min(55, 14 + missingSquareCitations.length * 6);
  }

  const inputAuthorYear = extractAuthorYearCitations(inputText);
  const outputAuthorYear = extractAuthorYearCitations(outputText);
  const missingAuthorYear = getMissingMarkers(inputAuthorYear, outputAuthorYear);
  if (missingAuthorYear.length > 0) {
    issues.push(
      `Missing in-text reference(s): ${[...new Set(missingAuthorYear)].slice(0, 5).join(", ")}.`,
    );
    qualityScore -= Math.min(35, 10 + missingAuthorYear.length * 5);
  }

  if (inputSquareCitations.length === 0 && outputSquareCitations.length > 0) {
    issues.push("Output introduced citation marker(s) that were not present in input.");
    qualityScore -= Math.min(35, 12 + outputSquareCitations.length * 4);
  }

  if (inputAuthorYear.length === 0 && outputAuthorYear.length > 0) {
    issues.push("Output introduced in-text reference(s) that were not present in input.");
    qualityScore -= Math.min(35, 10 + outputAuthorYear.length * 4);
  }

  return {
    qualityScore: Math.max(0, Math.min(100, qualityScore)),
    issues,
  };
}

function sanitizeOutputText(outputText: string): string {
  const lines = outputText
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, arr) => {
      if (index < 2) {
        return true;
      }
      return !(line && line === arr[index - 1] && line === arr[index - 2]);
    });

  let cleaned = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  let seenEmDash = 0;
  cleaned = cleaned.replace(/—/g, () => {
    seenEmDash += 1;
    return seenEmDash <= MAX_EM_DASH_COUNT ? "—" : ",";
  });

  return cleaned;
}

function getGenerationConfigForTone(
  strengthConfig: GenerationConfig,
  tone: string,
): GenerationConfig {
  const profile = TONE_PROFILES[tone];
  if (!profile) {
    return strengthConfig;
  }
  const calibration = TONE_CALIBRATION.tones[tone];
  const temperatureDelta = calibration
    ? calibration.temperatureDelta
    : profile.defaultDecoding.temperatureDelta;
  const topPDelta = calibration ? calibration.topPDelta : profile.defaultDecoding.topPDelta;

  const adjustedTemperature = Math.max(
    0.1,
    Math.min(0.9, strengthConfig.temperature + temperatureDelta),
  );
  const adjustedTopP = Math.max(0.7, Math.min(0.98, strengthConfig.topP + topPDelta));

  return {
    temperature: adjustedTemperature,
    topP: adjustedTopP,
    maxTokens: strengthConfig.maxTokens,
  };
}

async function callMistral({
  mistralApiKey,
  model,
  messages,
  generationConfig,
}: {
  mistralApiKey: string;
  model: string;
  messages: MistralMessage[];
  generationConfig: GenerationConfig;
}): Promise<string> {
  const maxRetries = Number(process.env.MISTRAL_MAX_RETRIES || "4");
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const mistralResponse = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mistralApiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: generationConfig.temperature,
        top_p: generationConfig.topP,
        max_tokens: generationConfig.maxTokens,
        messages,
      }),
    });

    if (mistralResponse.ok) {
      const mistralPayload = (await mistralResponse.json()) as MistralResponse;
      const outputText = mistralPayload.choices?.[0]?.message?.content?.trim();
      if (!outputText) {
        throw new Error("Model returned an empty response.");
      }
      return outputText;
    }

    const details = await mistralResponse.text();
    const isRateLimited = mistralResponse.status === 429;
    if (!isRateLimited || attempt === maxRetries) {
      throw new Error(`Mistral request failed (${mistralResponse.status}): ${details}`);
    }

    const retryAfterSeconds = Number(mistralResponse.headers.get("retry-after") || "0");
    const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;
    const jitterMs = Math.floor(Math.random() * 700);
    const exponentialBackoffMs = Math.min(20000, 1200 * 2 ** attempt);
    const waitMs = Math.max(retryAfterMs, exponentialBackoffMs + jitterMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error("Mistral request failed after retries.");
}

async function refineCandidate({
  mistralApiKey,
  model,
  inputText,
  candidateText,
  tone,
  strength,
  toneProfile,
  generationConfig,
  preserveCitationMarkers,
}: {
  mistralApiKey: string;
  model: string;
  inputText: string;
  candidateText: string;
  tone: string;
  strength: string;
  toneProfile: ToneProfile;
  generationConfig: GenerationConfig;
  preserveCitationMarkers: boolean;
}): Promise<string> {
  const refinementPrompt = [
    "You are performing a deliberate second-pass refinement.",
    "Review the candidate rewrite thoughtfully against all rules.",
    "Improve only where needed and keep factual meaning intact.",
    preserveCitationMarkers ? "Preserve all citation markers exactly." : null,
    `Tone target: ${tone}. ${toneProfile.instruction}`,
    `Rewrite strength: ${strength}.`,
    `Required style rules: ${toneProfile.requiredStyleRules.join(" ")}`,
    `Avoid these patterns: ${toneProfile.blockedPatterns.join("; ")}.`,
    "",
    "Original input:",
    inputText,
    "",
    "Candidate rewrite:",
    candidateText,
    "",
    "Return only the refined final rewrite.",
  ]
    .filter(Boolean)
    .join("\n");

  const refined = await callMistral({
    mistralApiKey,
    model,
    generationConfig,
    messages: [
      {
        role: "system",
        content: HUMANIZER_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: refinementPrompt,
      },
    ],
  });

  return sanitizeOutputText(refined);
}

export async function POST(request: Request) {
  try {
    const token = getBearerToken(request);
    if (!token) {
      return NextResponse.json(
        { error: "Missing access token. Please sign in again." },
        { status: 401 },
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabasePublicKey =
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabasePublicKey) {
      return NextResponse.json(
        {
          error:
            "Supabase env vars are missing on the server. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).",
        },
        { status: 500 },
      );
    }

    const supabase = createClient(supabaseUrl, supabasePublicKey);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return NextResponse.json(
        { error: "Session is invalid. Please sign in again." },
        { status: 401 },
      );
    }

    const rawBody = await request.json();
    const parsedBody = requestSchema.safeParse(rawBody);

    if (!parsedBody.success) {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }

    const inputText = parsedBody.data.text.trim();
    const tone = parsedBody.data.tone ?? "professional";
    const strengthLevel = clampStrengthLevel(parsedBody.data.strengthLevel ?? 50);
    const strength = parsedBody.data.strength ?? getStrengthModeFromLevel(strengthLevel);
    const styleProfileInstruction = getStyleProfileInstruction(parsedBody.data.styleProfile);
    const preserveCitationMarkers = hasCitationMarkers(inputText);
    const inputWordCount = countWords(inputText);

    if (inputWordCount > MAX_WORDS_PER_REQUEST) {
      return NextResponse.json(
        {
          error: `Input exceeds ${MAX_WORDS_PER_REQUEST} words. Current count: ${inputWordCount}.`,
        },
        { status: 400 },
      );
    }

    const mistralApiKey = process.env.MISTRAL_API_KEY;
    if (!mistralApiKey) {
      return NextResponse.json(
        { error: "MISTRAL_API_KEY is missing on the server." },
        { status: 500 },
      );
    }

    const model = process.env.MISTRAL_MODEL || "mistral-large-latest";
    const strengthConfig = getGenerationConfigForStrengthLevel(strengthLevel);
    const toneProfile = TONE_PROFILES[tone] || TONE_PROFILES.professional;
    const generationConfig = getGenerationConfigForTone(strengthConfig, tone);
    let outputText = "";
    let validationResult: ValidationResult = { qualityScore: 0, issues: ["No output generated."] };
    let previousAttemptOutput = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const messages: MistralMessage[] = [
        {
          role: "system",
          content: HUMANIZER_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content:
            attempt === 1
              ? [
                  "Humanize the following text.",
                  `Tone target: ${tone}. ${toneProfile.instruction}`,
                  `Rewrite strength: ${strength} (${Math.round(strengthLevel)} / 100). ${STRENGTH_INSTRUCTIONS[strength]}`,
                  `Required style rules: ${toneProfile.requiredStyleRules.join(" ")}`,
                  `Avoid these patterns: ${toneProfile.blockedPatterns.join("; ")}.`,
                  styleProfileInstruction
                    ? `Voice profile hint: ${styleProfileInstruction}`
                    : null,
                  preserveCitationMarkers
                    ? "Preserve all citation markers exactly (e.g., [2], [3], [4,7], [8-10], and in-text references)."
                    : "Do not add citation markers or in-text references that do not exist in the source.",
                  "",
                  inputText,
                ]
                    .filter(Boolean)
                    .join("\n")
              : [
                  "Rewrite the same input again with stricter natural-writing cleanup.",
                  "Previous output failed quality checks.",
                  `Tone target: ${tone}. ${toneProfile.instruction}`,
                  `Rewrite strength: ${strength} (${Math.round(strengthLevel)} / 100). ${STRENGTH_INSTRUCTIONS[strength]}`,
                  `Required style rules: ${toneProfile.requiredStyleRules.join(" ")}`,
                  `Avoid these patterns: ${toneProfile.blockedPatterns.join("; ")}.`,
                  styleProfileInstruction
                    ? `Voice profile hint: ${styleProfileInstruction}`
                    : null,
                  `Detected issues: ${validationResult.issues.join(" | ")}`,
                  preserveCitationMarkers
                    ? "Fix all issues, preserve every citation marker exactly, avoid em-dash overuse, and return only final rewritten text."
                    : "Fix all issues, do not introduce citation markers/references, avoid em-dash overuse, and return only final rewritten text.",
                  "",
                  `Original input:\n${inputText}`,
                  "",
                  `Previous output:\n${previousAttemptOutput}`,
                ]
                    .filter(Boolean)
                    .join("\n"),
        },
      ];

      outputText = await callMistral({ mistralApiKey, model, messages, generationConfig });
      outputText = sanitizeOutputText(outputText);
      outputText = await refineCandidate({
        mistralApiKey,
        model,
        inputText,
        candidateText: outputText,
        tone,
        strength,
        toneProfile,
        generationConfig,
        preserveCitationMarkers,
      });
      validationResult = getValidationResult(inputText, outputText);

      if (validationResult.qualityScore >= MIN_QUALITY_SCORE) {
        break;
      }

      previousAttemptOutput = outputText;
    }

    if (validationResult.qualityScore < MIN_QUALITY_SCORE) {
      return NextResponse.json(
        {
          error:
            "Humanization quality checks failed after multiple attempts. Please retry with slightly different input.",
          qualityScore: validationResult.qualityScore,
          failedChecks: validationResult.issues,
        },
        { status: 422 },
      );
    }

    const userScopedSupabase = createClient(supabaseUrl, supabasePublicKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const outputWordCount = countWords(outputText);

    await userScopedSupabase.from("rewrites").insert({
      user_id: user.id,
      input_text: inputText,
      input_word_count: inputWordCount,
      output_text: outputText,
      output_word_count: outputWordCount,
      model,
      quality_score: validationResult.qualityScore,
    });

    return NextResponse.json({
      output: outputText,
      model,
      tone,
      strength,
      strengthLevel,
      generationConfig,
      toneProfile: {
        instruction: toneProfile.instruction,
        requiredStyleRules: toneProfile.requiredStyleRules,
      },
      calibrationSource: TONE_CALIBRATION.source,
      calibrationUpdatedAt: TONE_CALIBRATION.updatedAt,
      inputWordCount,
      outputWordCount,
      qualityScore: validationResult.qualityScore,
      styleProfileApplied: Boolean(parsedBody.data.styleProfile),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error occurred.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
