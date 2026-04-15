import { afterEach, describe, expect, it, vi } from "vitest";
import { runDetectionOrchestrator } from "@/lib/detection/orchestrator";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DETECTOR_ENABLE_GPTZERO;
  delete process.env.GPTZERO_API_KEY;
  delete process.env.DETECTOR_ENABLE_COPYLEAKS;
  delete process.env.COPYLEAKS_API_KEY;
  delete process.env.COPYLEAKS_EMAIL;
});

describe("runDetectionOrchestrator", () => {
  it("returns deterministic schema shape", async () => {
    const result = await runDetectionOrchestrator({
      text: "This is a short paragraph with normal sentence variety. It is written by hand.",
      mode: "general",
      language: "en",
      vendorConsent: false,
      detailsEnabled: true,
      reducedDetail: false,
    });

    expect(result.summary.calibratorVersion).toBe("rule-v1");
    expect(result.detectors.length).toBeGreaterThanOrEqual(3);
    expect(result.summary.ensembleScore).toBeGreaterThanOrEqual(0);
    expect(result.summary.ensembleScore).toBeLessThanOrEqual(100);
    expect(result.explainabilitySignals.predictability).toBeGreaterThanOrEqual(0);
    expect(result.explainabilitySignals.predictability).toBeLessThanOrEqual(100);
  });

  it("redacts detail payload when reducedDetail is true", async () => {
    const result = await runDetectionOrchestrator({
      text: "In conclusion, this section is intentionally repetitive. In conclusion, this section is intentionally repetitive.",
      mode: "academic",
      language: "en",
      vendorConsent: false,
      detailsEnabled: true,
      reducedDetail: true,
    });

    expect(result.reducedDetail).toBe(true);
    expect(result.sentenceHighlights).toHaveLength(0);
  });

  it("handles vendor detector partial failure without crashing", async () => {
    process.env.DETECTOR_ENABLE_GPTZERO = "true";
    delete process.env.GPTZERO_API_KEY;

    const result = await runDetectionOrchestrator({
      text: "This draft paragraph uses straightforward writing style and should still return schema-safe output.",
      mode: "publishing",
      language: "en",
      vendorConsent: true,
      detailsEnabled: false,
      reducedDetail: false,
    });

    const gptzero = result.detectors.find((detector) => detector.id === "gptzero");
    expect(gptzero).toBeTruthy();
    expect(gptzero?.status).toBe("failed");
  });

  it("maps GPTZero response into normalized detector schema", async () => {
    process.env.DETECTOR_ENABLE_GPTZERO = "true";
    process.env.GPTZERO_API_KEY = "test-gptzero-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("api.gptzero.me")) {
          return new Response(
            JSON.stringify({
              document_classification: "MIXED",
              class_probabilities: { ai: 0.62, human: 0.38 },
              confidence_category: "medium",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not-found", { status: 404 });
      }),
    );

    const result = await runDetectionOrchestrator({
      text: "This paragraph is being analyzed for detector mapping.",
      mode: "general",
      language: "en",
      vendorConsent: true,
      detailsEnabled: false,
      reducedDetail: false,
    });

    const gptzero = result.detectors.find((detector) => detector.id === "gptzero");
    expect(gptzero?.status).toBe("ok");
    expect(gptzero?.score).toBe(0.62);
  });

  it("maps Copyleaks auth + detection flow", async () => {
    process.env.DETECTOR_ENABLE_COPYLEAKS = "true";
    process.env.COPYLEAKS_API_KEY = "test-copyleaks-key";
    process.env.COPYLEAKS_EMAIL = "test@example.com";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("id.copyleaks.com/v3/account/login/api")) {
          return new Response(JSON.stringify({ access_token: "copyleaks-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("api.copyleaks.com/v2/writer-detector/")) {
          return new Response(
            JSON.stringify({
              modelVersion: "v5",
              summary: { ai: 0.71, human: 0.29 },
              scannedDocument: { scanId: "abc123" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not-found", { status: 404 });
      }),
    );

    const result = await runDetectionOrchestrator({
      text: "This paragraph is being analyzed for copyleaks flow mapping and summary conversion.",
      mode: "general",
      language: "en",
      vendorConsent: true,
      detailsEnabled: true,
      reducedDetail: false,
    });

    const copyleaks = result.detectors.find((detector) => detector.id === "copyleaks");
    expect(copyleaks?.status).toBe("ok");
    expect(copyleaks?.score).toBe(0.71);
  });
});

