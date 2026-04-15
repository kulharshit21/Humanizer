import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const TONE_PROFILE_PATH = path.join(projectRoot, "src", "lib", "tone-profiles.json");
const CALIBRATION_PATH = path.join(projectRoot, "src", "lib", "tone-calibration.json");
const GOLD_PATH = path.join(projectRoot, "calibration", "gold-examples.jsonl");
const REPORTS_DIR = path.join(projectRoot, "calibration", "reports");
const CHECKPOINT_PATH = path.join(REPORTS_DIR, "tone-calibration.checkpoint.json");

const BASE_DECODING_PRESETS = {
  minimal: { temperature: 0.28, topP: 0.86, maxTokens: 1400 },
  balanced: { temperature: 0.42, topP: 0.9, maxTokens: 1500 },
  strong: { temperature: 0.55, topP: 0.93, maxTokens: 1600 },
  maximum: { temperature: 0.62, topP: 0.95, maxTokens: 1700 },
};

const DEFAULT_TEMPERATURE_DELTAS = [-0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.12];
const DEFAULT_TOP_P_DELTAS = [-0.08, -0.05, -0.02, 0, 0.02, 0.05, 0.08];
const FAST_TEMPERATURE_DELTAS = [-0.08, 0, 0.08];
const FAST_TOP_P_DELTAS = [-0.05, 0, 0.05];

const SYSTEM_PROMPT = `
You are an expert human writing editor.
Rewrite text into natural human writing while preserving meaning and factual integrity.
Do not add unsupported claims.
Preserve all citation markers exactly (e.g., [2], [3], [4,7], [8-10], and in-text references).
Return only rewritten text.
`.trim();

let adaptiveDelayMs = Number(process.env.CALIBRATION_ADAPTIVE_DELAY_MS || "0");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });
}

function tokenizeWords(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function sentenceStarts(text) {
  return text
    .split(/[.!?]+\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.split(/\s+/)[0]?.toLowerCase() || "");
}

function jaccard(left, right) {
  const leftSet = new Set(tokenizeWords(left));
  const rightSet = new Set(tokenizeWords(right));
  if (leftSet.size === 0 && rightSet.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function lexicalDiversity(text) {
  const words = tokenizeWords(text);
  if (words.length === 0) {
    return 0;
  }
  return new Set(words).size / words.length;
}

function extractSquareCitations(text) {
  const matches = text.match(/\[(?:\d+(?:\s*[-,]\s*\d+)*)\]/g);
  return (matches || []).map((item) => item.replace(/\s+/g, ""));
}

function citationRecall(inputText, outputText) {
  const inputCitations = extractSquareCitations(inputText);
  if (inputCitations.length === 0) {
    return 1;
  }
  const outputCitations = extractSquareCitations(outputText);
  let found = 0;
  for (const citation of inputCitations) {
    if (outputCitations.includes(citation)) {
      found += 1;
    }
  }
  return found / inputCitations.length;
}

function repetitionPenalty(text) {
  const starts = sentenceStarts(text);
  if (starts.length < 3) {
    return 0;
  }
  let repeats = 0;
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i] && starts[i] === starts[i - 1]) {
      repeats += 1;
    }
  }
  return Math.min(1, repeats / Math.max(1, starts.length - 1));
}

function buildUserPrompt(example, toneProfile, strength) {
  return [
    "Humanize the following text.",
    `Tone target: ${example.tone}. ${toneProfile.instruction}`,
    `Rewrite strength: ${strength}.`,
    `Required style rules: ${toneProfile.requiredStyleRules.join(" ")}`,
    `Avoid these patterns: ${toneProfile.blockedPatterns.join("; ")}.`,
    "Preserve all citations exactly.",
    "",
    example.input,
  ].join("\n");
}

async function generateCandidate({
  apiKey,
  model,
  input,
  temperature,
  topP,
  maxTokens,
}) {
  const maxRetries = Number(process.env.CALIBRATION_MAX_RETRIES || "6");
  const requestDelayMs = Number(process.env.CALIBRATION_REQUEST_DELAY_MS || "900");
  const maxAdaptiveDelayMs = Number(process.env.CALIBRATION_MAX_ADAPTIVE_DELAY_MS || "7000");

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    try {
      response = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature,
          top_p: topP,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: input },
          ],
        }),
      });
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(`Mistral request failed after retries: ${error.message}`);
      }
      const networkBackoffMs = Math.min(30000, 1200 * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, networkBackoffMs));
      continue;
    }

    if (response.ok) {
      const payload = await response.json();
      const text = payload?.choices?.[0]?.message?.content?.trim();
      if (!text) {
        throw new Error("Empty model output during calibration.");
      }
      adaptiveDelayMs = Math.max(0, adaptiveDelayMs - 120);
      await sleep(requestDelayMs + adaptiveDelayMs);
      return text;
    }

    const details = await response.text();
    const isRateLimited = response.status === 429;
    if (!isRateLimited || attempt === maxRetries) {
      throw new Error(`Mistral request failed (${response.status}): ${details}`);
    }
    adaptiveDelayMs = Math.min(maxAdaptiveDelayMs, adaptiveDelayMs + 350);
    const retryAfterSeconds = Number(response.headers.get("retry-after") || "0");
    const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;
    const jitterMs = Math.floor(Math.random() * 900);
    const backoffMs = Math.min(45000, 1500 * 2 ** attempt + adaptiveDelayMs + jitterMs);
    const waitMs = Math.max(backoffMs, retryAfterMs);
    process.stdout.write(
      `[calibration] rate-limited attempt=${attempt + 1}/${maxRetries + 1} wait_ms=${waitMs} adaptive_delay_ms=${adaptiveDelayMs}\n`,
    );
    await sleep(waitMs);
  }

  throw new Error("Calibration request failed after retries.");
}

function scoreCandidate({ input, reference, output }) {
  const preservation = jaccard(input, output);
  const referenceMatch = jaccard(reference, output);
  const citation = citationRecall(input, output);
  const diversity = lexicalDiversity(output);
  const repetition = repetitionPenalty(output);

  return (
    preservation * 0.35 +
    referenceMatch * 0.25 +
    citation * 0.25 +
    diversity * 0.1 +
    (1 - repetition) * 0.05
  );
}

async function main() {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY is required.");
  }

  const model = process.env.MISTRAL_MODEL || "mistral-large-latest";
  const strength = process.env.CALIBRATION_STRENGTH || "balanced";
  const maxExamplesPerTone = Number(process.env.MAX_EXAMPLES_PER_TONE || "8");
  const fastMode = process.env.CALIBRATION_FAST_MODE === "1";
  const temperatureDeltas = fastMode ? FAST_TEMPERATURE_DELTAS : DEFAULT_TEMPERATURE_DELTAS;
  const topPDeltas = fastMode ? FAST_TOP_P_DELTAS : DEFAULT_TOP_P_DELTAS;
  const resumeEnabled = process.env.CALIBRATION_RESUME !== "0";

  const [toneProfilesRaw, goldRaw] = await Promise.all([
    readFile(TONE_PROFILE_PATH, "utf8"),
    readFile(GOLD_PATH, "utf8"),
  ]);

  const toneProfiles = JSON.parse(toneProfilesRaw);
  const examples = parseJsonl(goldRaw);
  const grouped = new Map();
  for (const example of examples) {
    if (!grouped.has(example.tone)) {
      grouped.set(example.tone, []);
    }
    grouped.get(example.tone).push(example);
  }

  const calibrationResult = {
    updatedAt: new Date().toISOString(),
    source: "grid-search-v1",
    tones: {},
  };
  const report = {
    model,
    strength,
    fastMode,
    evaluatedAt: calibrationResult.updatedAt,
    tones: {},
  };
  await mkdir(REPORTS_DIR, { recursive: true });

  const checkpoint = resumeEnabled ? await readJsonIfExists(CHECKPOINT_PATH) : null;
  if (
    checkpoint &&
    checkpoint.model === model &&
    checkpoint.strength === strength &&
    checkpoint.maxExamplesPerTone === maxExamplesPerTone &&
    checkpoint.fastMode === fastMode
  ) {
    process.stdout.write("[calibration] resuming from checkpoint\n");
    if (checkpoint.calibrationResult?.tones) {
      for (const [tone, value] of Object.entries(checkpoint.calibrationResult.tones)) {
        calibrationResult.tones[tone] = value;
      }
    }
    if (checkpoint.report?.tones) {
      for (const [tone, value] of Object.entries(checkpoint.report.tones)) {
        report.tones[tone] = value;
      }
    }
  }

  for (const [tone, toneExamples] of grouped.entries()) {
    const toneProfile = toneProfiles[tone];
    if (!toneProfile) {
      continue;
    }
    const selectedExamples = toneExamples.slice(0, maxExamplesPerTone);
    const basePreset = BASE_DECODING_PRESETS[strength] || BASE_DECODING_PRESETS.balanced;
    process.stdout.write(
      `[calibration] tone=${tone} samples=${selectedExamples.length} grid=${temperatureDeltas.length * topPDeltas.length}\n`,
    );
    if (calibrationResult.tones[tone]?.sampleCount === selectedExamples.length) {
      process.stdout.write(`[calibration] tone=${tone} already completed in checkpoint, skipping\n`);
      continue;
    }

    let best = { score: -1, temperatureDelta: 0, topPDelta: 0 };
    for (const temperatureDelta of temperatureDeltas) {
      for (const topPDelta of topPDeltas) {
        const temperature = Math.max(
          0.1,
          Math.min(
            0.9,
            basePreset.temperature + toneProfile.defaultDecoding.temperatureDelta + temperatureDelta,
          ),
        );
        const topP = Math.max(
          0.7,
          Math.min(0.98, basePreset.topP + toneProfile.defaultDecoding.topPDelta + topPDelta),
        );

        let total = 0;
        for (const example of selectedExamples) {
          const userPrompt = buildUserPrompt(example, toneProfile, strength);
          const output = await generateCandidate({
            apiKey,
            model,
            input: userPrompt,
            temperature,
            topP,
            maxTokens: basePreset.maxTokens,
          });
          total += scoreCandidate({
            input: example.input,
            reference: example.reference,
            output,
          });
        }
        const meanScore = total / selectedExamples.length;
        if (meanScore > best.score) {
          best = { score: meanScore, temperatureDelta, topPDelta };
        }
      }
    }

    calibrationResult.tones[tone] = {
      temperatureDelta: Number(
        (toneProfile.defaultDecoding.temperatureDelta + best.temperatureDelta).toFixed(4),
      ),
      topPDelta: Number((toneProfile.defaultDecoding.topPDelta + best.topPDelta).toFixed(4)),
      sampleCount: selectedExamples.length,
    };
    report.tones[tone] = {
      sampleCount: selectedExamples.length,
      meanScore: Number(best.score.toFixed(6)),
      appliedTemperatureDelta: calibrationResult.tones[tone].temperatureDelta,
      appliedTopPDelta: calibrationResult.tones[tone].topPDelta,
    };

    if (resumeEnabled) {
      await writeFile(
        CHECKPOINT_PATH,
        `${JSON.stringify(
          {
            updatedAt: new Date().toISOString(),
            model,
            strength,
            maxExamplesPerTone,
            fastMode,
            calibrationResult,
            report,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
  }

  for (const tone of Object.keys(toneProfiles)) {
    if (!calibrationResult.tones[tone]) {
      calibrationResult.tones[tone] = {
        temperatureDelta: toneProfiles[tone].defaultDecoding.temperatureDelta,
        topPDelta: toneProfiles[tone].defaultDecoding.topPDelta,
        sampleCount: 0,
      };
    }
  }

  await writeFile(CALIBRATION_PATH, `${JSON.stringify(calibrationResult, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(REPORTS_DIR, `tone-calibration-${Date.now()}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  process.stdout.write(
    `Tone calibration complete. Updated ${CALIBRATION_PATH} and wrote report.\n`,
  );

  if (resumeEnabled) {
    await writeFile(
      CHECKPOINT_PATH,
      `${JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          completed: true,
          model,
          strength,
          maxExamplesPerTone,
          fastMode,
          calibrationResult,
          report,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
}

main().catch((error) => {
  process.stderr.write(`Calibration failed: ${error.message}\n`);
  process.exit(1);
});
