import type {
  DetectResponse,
  DetectorResult,
  ExplainabilitySignals,
  SentenceHighlight,
} from "@/lib/detection/types";
import {
  clamp01,
  lexicalDiversity,
  scoreToLabel,
  splitSentences,
  tokenize,
} from "@/lib/detection/utils";
import { randomUUID } from "node:crypto";

const CALIBRATOR_VERSION = "rule-v1";

const DETECTION_TIMEOUT_MS = 6000;
const DETECTION_RETRIES = 1;

export type OrchestratorInput = {
  text: string;
  mode: "general" | "academic" | "publishing";
  language: string;
  vendorConsent: boolean;
  detailsEnabled: boolean;
  reducedDetail: boolean;
};

export type DetectorAdapter = {
  id: string;
  name: string;
  run: (args: OrchestratorInput) => Promise<DetectorResult>;
};

const telemetryCounters = {
  calls: 0,
  detectorFailures: 0,
  detectorTimeouts: 0,
};

function sentenceVariationScore(text: string): number {
  const sentences = splitSentences(text);
  if (sentences.length < 2) {
    return 0;
  }
  const lengths = sentences.map((sentence) => tokenize(sentence).length);
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  if (mean === 0) {
    return 0;
  }
  const variance =
    lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length;
  const stdDev = Math.sqrt(variance);
  return clamp01(stdDev / (mean + 1));
}

function repetitionScore(text: string): number {
  const starts = splitSentences(text).map((sentence) => sentence.split(/\s+/)[0]?.toLowerCase() || "");
  if (starts.length < 2) {
    return 0;
  }
  let repeats = 0;
  for (let index = 1; index < starts.length; index += 1) {
    if (starts[index] && starts[index] === starts[index - 1]) {
      repeats += 1;
    }
  }
  return clamp01(repeats / (starts.length - 1));
}

function getExplainabilitySignals(input: OrchestratorInput): ExplainabilitySignals {
  const diversity = lexicalDiversity(input.text);
  const variation = sentenceVariationScore(input.text);
  const repetition = repetitionScore(input.text);
  const predictability = clamp01((1 - diversity) * 0.65 + repetition * 0.35);
  const domainMismatch = clamp01(
    input.mode === "academic" && diversity < 0.33 ? 0.62 : input.mode === "publishing" && variation < 0.2 ? 0.55 : 0.28,
  );

  return {
    predictability: Number((predictability * 100).toFixed(2)),
    variation: Number((variation * 100).toFixed(2)),
    repetition: Number((repetition * 100).toFixed(2)),
    domainMismatch: Number((domainMismatch * 100).toFixed(2)),
  };
}

function scoreFromSignals(signals: ExplainabilitySignals): number {
  return clamp01(
    (signals.predictability / 100) * 0.4 +
      (signals.repetition / 100) * 0.25 +
      (1 - signals.variation / 100) * 0.25 +
      (signals.domainMismatch / 100) * 0.1,
  );
}

function detectHighlights(input: OrchestratorInput, signals: ExplainabilitySignals): SentenceHighlight[] {
  const sentences = splitSentences(input.text);
  if (sentences.length === 0) {
    return [];
  }
  return sentences
    .map((sentence) => {
      const sentenceTokens = tokenize(sentence).length;
      const hasRepeatedConnector = /\b(furthermore|moreover|in conclusion|additionally)\b/i.test(sentence);
      const sentenceRisk = clamp01(
        (signals.predictability / 100) * 0.5 +
          (sentenceTokens > 28 ? 0.25 : 0) +
          (hasRepeatedConnector ? 0.25 : 0),
      );
      return {
        sentence,
        risk: Number((sentenceRisk * 100).toFixed(1)),
        reason: hasRepeatedConnector
          ? "Template-like transition usage"
          : sentenceTokens > 28
            ? "Long predictable sentence structure"
            : "Low lexical variety pattern",
      };
    })
    .filter((item) => item.risk >= 55)
    .slice(0, input.reducedDetail ? 0 : 8);
}

function makeLocalAdapter(id: string, name: string, score: number): DetectorResult {
  return {
    id,
    name,
    status: "ok",
    label: scoreToLabel(score),
    confidence: Number((0.6 + Math.abs(0.5 - score) * 0.5).toFixed(2)),
    latencyMs: 0,
    score: Number(score.toFixed(4)),
  };
}

function getVendorEnabledEnv(detectorId: string): boolean {
  return process.env[`DETECTOR_ENABLE_${detectorId.toUpperCase()}`] === "true";
}

function extractNumericScore(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1 && value <= 100) {
      return clamp01(value / 100);
    }
    return clamp01(value);
  }
  return null;
}

function getConfidenceFromScore(score: number): number {
  return Number((0.55 + Math.abs(score - 0.5) * 0.8).toFixed(2));
}

async function parseJsonSafe(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Non-JSON response (${response.status}): ${raw.slice(0, 240)}`);
  }
}

function getAuthHeadersForVendor(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-api-key": apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
}

function buildSuccessResult(
  detectorId: string,
  name: string,
  startedAt: number,
  score: number,
  details?: Record<string, unknown>,
): DetectorResult {
  return {
    id: detectorId,
    name,
    status: "ok",
    label: scoreToLabel(score),
    confidence: getConfidenceFromScore(score),
    latencyMs: Date.now() - startedAt,
    score: Number(score.toFixed(4)),
    details,
  };
}

function buildFailureResult(
  detectorId: string,
  name: string,
  startedAt: number,
  code: string,
  message: string,
): DetectorResult {
  return {
    id: detectorId,
    name,
    status: "failed",
    label: "inconclusive",
    confidence: null,
    latencyMs: Date.now() - startedAt,
    score: null,
    errorCode: code,
    errorMessage: message,
  };
}

async function runGptZeroAdapter(
  detectorId: string,
  name: string,
  startedAt: number,
  args: OrchestratorInput,
  apiKey: string,
): Promise<DetectorResult> {
  const endpoint = process.env.GPTZERO_ENDPOINT || "https://api.gptzero.me/v2/predict/text";
  const version = process.env.GPTZERO_MODEL_VERSION || "2024-11-20";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      document: args.text,
      version,
    }),
  });
  if (!response.ok) {
    const details = await response.text();
    return buildFailureResult(detectorId, name, startedAt, `http_${response.status}`, details);
  }
  const payload = await parseJsonSafe(response);
  const classification = String(payload.document_classification || "INCONCLUSIVE").toUpperCase();
  const probabilities = (payload.class_probabilities || {}) as Record<string, unknown>;
  const aiScore =
    extractNumericScore(probabilities.ai) ??
    extractNumericScore(probabilities.ai_only) ??
    extractNumericScore(probabilities.AI_ONLY) ??
    (classification === "AI_ONLY" ? 0.9 : classification === "MIXED" ? 0.55 : 0.15);

  return buildSuccessResult(detectorId, name, startedAt, aiScore, {
    confidenceCategory: payload.confidence_category,
    documentClassification: classification,
    highlights: payload.highlight_sentence_for_ai,
  });
}

async function runOriginalityAdapter(
  detectorId: string,
  name: string,
  startedAt: number,
  args: OrchestratorInput,
  apiKey: string,
): Promise<DetectorResult> {
  const endpoint = process.env.ORIGINALITYAI_ENDPOINT || "https://api.originality.ai/api/v3/scan/ai";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...getAuthHeadersForVendor(apiKey),
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      content: args.text,
      title: "Humanizer authenticity scan",
      language: args.language || "en",
    }),
  });
  if (!response.ok) {
    const details = await response.text();
    return buildFailureResult(detectorId, name, startedAt, `http_${response.status}`, details);
  }
  const payload = await parseJsonSafe(response);
  const aiScore =
    extractNumericScore(payload.ai) ??
    extractNumericScore(payload.ai_score) ??
    extractNumericScore((payload.score as Record<string, unknown> | undefined)?.ai) ??
    extractNumericScore((payload.results as Record<string, unknown> | undefined)?.ai) ??
    extractNumericScore(payload.score) ??
    null;
  if (aiScore === null) {
    return buildFailureResult(
      detectorId,
      name,
      startedAt,
      "unmapped_response",
      "Could not extract AI score from Originality.ai response.",
    );
  }
  return buildSuccessResult(detectorId, name, startedAt, aiScore, {
    scanId: payload.id ?? payload.scan_id,
    model: payload.model ?? payload.version,
  });
}

let copyleaksTokenCache: { token: string; expiresAt: number } | null = null;

async function getCopyleaksToken(email: string, apiKey: string): Promise<string> {
  if (copyleaksTokenCache && Date.now() < copyleaksTokenCache.expiresAt) {
    return copyleaksTokenCache.token;
  }
  const loginEndpoint = process.env.COPYLEAKS_AUTH_ENDPOINT || "https://id.copyleaks.com/v3/account/login/api";
  const response = await fetch(loginEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, key: apiKey }),
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Copyleaks auth failed (${response.status}): ${details}`);
  }
  const payload = await parseJsonSafe(response);
  const token = String(payload.access_token || "");
  if (!token) {
    throw new Error("Copyleaks auth succeeded but access_token was missing.");
  }
  // Copyleaks docs indicate 48h token validity; refresh earlier for safety.
  copyleaksTokenCache = {
    token,
    expiresAt: Date.now() + 47 * 60 * 60 * 1000,
  };
  return token;
}

async function runCopyleaksAdapter(
  detectorId: string,
  name: string,
  startedAt: number,
  args: OrchestratorInput,
  apiKey: string,
): Promise<DetectorResult> {
  const email = process.env.COPYLEAKS_EMAIL;
  if (!email) {
    return buildFailureResult(
      detectorId,
      name,
      startedAt,
      "missing_email",
      "COPYLEAKS_EMAIL not configured",
    );
  }
  let token: string;
  try {
    token = await getCopyleaksToken(email, apiKey);
  } catch (error) {
    return buildFailureResult(
      detectorId,
      name,
      startedAt,
      "auth_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const scanId = randomUUID().replace(/-/g, "").slice(0, 24);
  const endpoint =
    process.env.COPYLEAKS_DETECT_ENDPOINT || `https://api.copyleaks.com/v2/writer-detector/${scanId}/check`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      text: args.text,
      language: args.language || "en",
      explain: Boolean(args.detailsEnabled),
      sensitivity: Number(process.env.COPYLEAKS_SENSITIVITY || "2"),
      sandbox: process.env.COPYLEAKS_SANDBOX === "true",
    }),
  });
  if (!response.ok) {
    const details = await response.text();
    return buildFailureResult(detectorId, name, startedAt, `http_${response.status}`, details);
  }
  const payload = await parseJsonSafe(response);
  const summary = (payload.summary || {}) as Record<string, unknown>;
  const aiScore =
    extractNumericScore(summary.ai) ??
    extractNumericScore(payload.ai) ??
    extractNumericScore((payload.results as Array<Record<string, unknown>> | undefined)?.[0]?.probability) ??
    null;
  if (aiScore === null) {
    return buildFailureResult(
      detectorId,
      name,
      startedAt,
      "unmapped_response",
      "Could not extract AI score from Copyleaks response.",
    );
  }
  return buildSuccessResult(detectorId, name, startedAt, aiScore, {
    modelVersion: payload.modelVersion,
    scanId: (payload.scannedDocument as Record<string, unknown> | undefined)?.scanId,
  });
}

async function runSaplingAdapter(
  detectorId: string,
  name: string,
  startedAt: number,
  args: OrchestratorInput,
  apiKey: string,
): Promise<DetectorResult> {
  const endpoint = process.env.SAPLING_ENDPOINT || "https://api.sapling.ai/api/v1/aidetect";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      key: apiKey,
      text: args.text,
      sent_scores: Boolean(args.detailsEnabled),
      score_string: false,
    }),
  });
  if (!response.ok) {
    const details = await response.text();
    return buildFailureResult(detectorId, name, startedAt, `http_${response.status}`, details);
  }
  const payload = await parseJsonSafe(response);
  const aiScore = extractNumericScore(payload.score);
  if (aiScore === null) {
    return buildFailureResult(
      detectorId,
      name,
      startedAt,
      "unmapped_response",
      "Could not extract AI score from Sapling response.",
    );
  }
  return buildSuccessResult(detectorId, name, startedAt, aiScore, {
    sentenceScores: payload.sentence_scores,
  });
}

function vendorAdapter(detectorId: string, name: string): DetectorAdapter {
  return {
    id: detectorId,
    name,
    run: async (args) => {
      const startedAt = Date.now();
      if (!args.vendorConsent || !getVendorEnabledEnv(detectorId)) {
        return {
          id: detectorId,
          name,
          status: "skipped",
          label: "inconclusive",
          confidence: null,
          latencyMs: Date.now() - startedAt,
          score: null,
          details: { reason: "disabled_or_no_consent" },
        };
      }

      const apiKey = process.env[`${detectorId.toUpperCase()}_API_KEY`];
      if (!apiKey) {
        return buildFailureResult(
          detectorId,
          name,
          startedAt,
          "missing_api_key",
          `${detectorId.toUpperCase()}_API_KEY not configured`,
        );
      }

      if (detectorId === "gptzero") {
        return runGptZeroAdapter(detectorId, name, startedAt, args, apiKey);
      }
      if (detectorId === "originalityai") {
        return runOriginalityAdapter(detectorId, name, startedAt, args, apiKey);
      }
      if (detectorId === "copyleaks") {
        return runCopyleaksAdapter(detectorId, name, startedAt, args, apiKey);
      }
      if (detectorId === "sapling") {
        return runSaplingAdapter(detectorId, name, startedAt, args, apiKey);
      }

      return buildFailureResult(
        detectorId,
        name,
        startedAt,
        "unsupported_detector",
        `Unsupported vendor detector: ${detectorId}`,
      );
    },
  };
}

function localDetectorAdapters(input: OrchestratorInput): DetectorAdapter[] {
  const signals = getExplainabilitySignals(input);
  return [
    {
      id: "binoculars",
      name: "Binoculars (local heuristic)",
      run: async () => {
        const startedAt = Date.now();
        const score = scoreFromSignals(signals);
        const result = makeLocalAdapter("binoculars", "Binoculars (local heuristic)", score);
        return { ...result, latencyMs: Date.now() - startedAt };
      },
    },
    {
      id: "detectgpt",
      name: "DetectGPT-style perturbation proxy",
      run: async () => {
        const startedAt = Date.now();
        if (process.env.DETECTOR_ENABLE_DETECTGPT !== "true") {
          return {
            id: "detectgpt",
            name: "DetectGPT-style perturbation proxy",
            status: "skipped",
            label: "inconclusive",
            confidence: null,
            latencyMs: Date.now() - startedAt,
            score: null,
            details: { reason: "feature_flag_disabled" },
          };
        }
        const score = clamp01((signals.predictability / 100) * 0.55 + (signals.repetition / 100) * 0.45);
        const result = makeLocalAdapter("detectgpt", "DetectGPT-style perturbation proxy", score);
        return { ...result, latencyMs: Date.now() - startedAt };
      },
    },
    {
      id: "gltr",
      name: "GLTR-style token pattern analysis",
      run: async () => {
        const startedAt = Date.now();
        const score = clamp01((signals.predictability / 100) * 0.45 + (1 - signals.variation / 100) * 0.55);
        const result = makeLocalAdapter("gltr", "GLTR-style token pattern analysis", score);
        return {
          ...result,
          latencyMs: Date.now() - startedAt,
          details: {
            predictability: signals.predictability,
            variation: signals.variation,
            repetition: signals.repetition,
          },
        };
      },
    },
  ];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function runWithRetry(adapter: DetectorAdapter, args: OrchestratorInput): Promise<DetectorResult> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= DETECTION_RETRIES; attempt += 1) {
    try {
      const startedAt = Date.now();
      const result = await withTimeout(adapter.run(args), DETECTION_TIMEOUT_MS);
      return { ...result, latencyMs: result.latencyMs || Date.now() - startedAt };
    } catch (error) {
      lastError = error;
      if (attempt === DETECTION_RETRIES) {
        const isTimeout = error instanceof Error && error.message === "timeout";
        telemetryCounters.detectorFailures += 1;
        if (isTimeout) {
          telemetryCounters.detectorTimeouts += 1;
        }
        return {
          id: adapter.id,
          name: adapter.name,
          status: isTimeout ? "timeout" : "failed",
          label: "inconclusive",
          confidence: null,
          latencyMs: DETECTION_TIMEOUT_MS,
          score: null,
          errorCode: isTimeout ? "timeout" : "run_failed",
          errorMessage: error instanceof Error ? error.message : String(lastError),
        };
      }
    }
  }
  return {
    id: adapter.id,
    name: adapter.name,
    status: "failed",
    label: "inconclusive",
    confidence: null,
    latencyMs: DETECTION_TIMEOUT_MS,
    score: null,
    errorCode: "unexpected_fallback",
    errorMessage: "Unexpected detector fallback.",
  };
}

function getDisagreement(scores: number[]): number {
  if (scores.length <= 1) {
    return 0;
  }
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const variance = scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / scores.length;
  return clamp01(Math.sqrt(variance) / 0.5);
}

function computeRiskBand(ensembleScore: number, disagreement: number, completedDetectors: number) {
  if (completedDetectors < 2) {
    return "inconclusive" as const;
  }
  if (disagreement > 0.48) {
    return "inconclusive" as const;
  }
  if (ensembleScore >= 0.67) {
    return "high" as const;
  }
  if (ensembleScore >= 0.4) {
    return "medium" as const;
  }
  return "low" as const;
}

export async function runDetectionOrchestrator(input: OrchestratorInput): Promise<DetectResponse> {
  telemetryCounters.calls += 1;
  const localAdapters = localDetectorAdapters(input);
  const adapters: DetectorAdapter[] = [
    ...localAdapters,
    vendorAdapter("gptzero", "GPTZero"),
    vendorAdapter("originalityai", "Originality.ai"),
    vendorAdapter("copyleaks", "Copyleaks"),
    vendorAdapter("sapling", "Sapling"),
  ];

  const detectorResults = await Promise.all(adapters.map((adapter) => runWithRetry(adapter, input)));
  const scored = detectorResults.filter((item) => item.status === "ok" && typeof item.score === "number");
  const scoredValues = scored.map((item) => item.score as number);
  const explainabilitySignals = getExplainabilitySignals(input);
  const localSignalScore = scoreFromSignals(explainabilitySignals);
  const ensembleScore = scoredValues.length
    ? scoredValues.reduce((sum, value) => sum + value, 0) / scoredValues.length
    : localSignalScore;
  const disagreement = getDisagreement(scoredValues);
  const completedDetectors = scored.length;
  const detectorFailures = detectorResults.filter((item) => item.status === "failed").length;
  const detectorTimeouts = detectorResults.filter((item) => item.status === "timeout").length;

  const response: DetectResponse = {
    summary: {
      riskBand: computeRiskBand(ensembleScore, disagreement, completedDetectors),
      ensembleScore: Number((ensembleScore * 100).toFixed(2)),
      disagreement: Number((disagreement * 100).toFixed(2)),
      calibratorVersion: CALIBRATOR_VERSION,
    },
    detectors: input.reducedDetail
      ? detectorResults.map((item) => ({
          ...item,
          details: undefined,
          errorMessage: item.status === "ok" ? undefined : item.errorMessage,
        }))
      : detectorResults,
    explainabilitySignals,
    sentenceHighlights: detectHighlights(input, explainabilitySignals),
    disclaimer:
      "Authenticity signals are probabilistic and may vary by domain, language, and text length. They are not proof of authorship.",
    reducedDetail: input.reducedDetail,
    telemetry: {
      detectorFailures,
      detectorTimeouts,
      completedDetectors,
    },
  };

  return response;
}

