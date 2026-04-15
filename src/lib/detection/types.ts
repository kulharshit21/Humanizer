export type DetectionMode = "general" | "academic" | "publishing";

export type PrivacyMode = "no_log" | "hash_only" | "full_text_opt_in";

export type DetectorStatus = "ok" | "failed" | "timeout" | "skipped";

export type DetectorLabel = "likely_human" | "mixed" | "likely_ai" | "inconclusive";

export type DetectorResult = {
  id: string;
  name: string;
  status: DetectorStatus;
  label: DetectorLabel;
  confidence: number | null;
  latencyMs: number;
  score: number | null;
  errorCode?: string;
  errorMessage?: string;
  details?: Record<string, unknown>;
};

export type ExplainabilitySignals = {
  predictability: number;
  variation: number;
  repetition: number;
  domainMismatch: number;
};

export type DetectionSummary = {
  riskBand: "low" | "medium" | "high" | "inconclusive";
  ensembleScore: number;
  disagreement: number;
  calibratorVersion: string;
};

export type SentenceHighlight = {
  sentence: string;
  risk: number;
  reason: string;
};

export type DetectResponse = {
  summary: DetectionSummary;
  detectors: DetectorResult[];
  explainabilitySignals: ExplainabilitySignals;
  sentenceHighlights: SentenceHighlight[];
  disclaimer: string;
  reducedDetail: boolean;
  telemetry: {
    detectorFailures: number;
    detectorTimeouts: number;
    completedDetectors: number;
  };
};

