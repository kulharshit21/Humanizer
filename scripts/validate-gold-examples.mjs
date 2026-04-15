import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const datasetPath =
  process.env.GOLD_PATH || path.join(projectRoot, "calibration", "gold-examples.jsonl");
const minPerTone = Number(process.env.MIN_PER_TONE || "30");

const ALLOWED_TONES = new Set([
  "casual",
  "professional",
  "creative",
  "academic",
  "linkedin",
  "blog",
  "email",
  "simplify",
  "human-like",
]);

function countWords(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return 0;
  }
  return normalized.split(/\s+/).length;
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function isTodoPlaceholder(text) {
  return /TODO_(INPUT|REFERENCE)_/i.test(String(text || ""));
}

async function main() {
  const raw = await readFile(datasetPath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const errors = [];
  const toneCounts = new Map();
  const seenIds = new Set();
  const seenInputHashes = new Set();

  lines.forEach((line, lineIndex) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      errors.push(`Line ${lineIndex + 1}: invalid JSON (${error.message}).`);
      return;
    }

    const { id, tone, input, reference } = record;
    if (!id || typeof id !== "string") {
      errors.push(`Line ${lineIndex + 1}: missing/invalid "id".`);
    } else if (seenIds.has(id)) {
      errors.push(`Line ${lineIndex + 1}: duplicate id "${id}".`);
    } else {
      seenIds.add(id);
    }

    if (!ALLOWED_TONES.has(tone)) {
      errors.push(`Line ${lineIndex + 1}: invalid tone "${tone}".`);
    } else {
      toneCounts.set(tone, (toneCounts.get(tone) || 0) + 1);
    }

    if (!input || typeof input !== "string") {
      errors.push(`Line ${lineIndex + 1}: missing/invalid "input".`);
    } else {
      const inputWords = countWords(input);
      if (inputWords < 20) {
        errors.push(`Line ${lineIndex + 1}: input too short (${inputWords} words, min 20).`);
      }
      if (isTodoPlaceholder(input)) {
        errors.push(`Line ${lineIndex + 1}: input contains TODO placeholder.`);
      }
      const hash = hashText(input.toLowerCase());
      if (seenInputHashes.has(hash)) {
        errors.push(`Line ${lineIndex + 1}: duplicate input text detected.`);
      } else {
        seenInputHashes.add(hash);
      }
    }

    if (!reference || typeof reference !== "string") {
      errors.push(`Line ${lineIndex + 1}: missing/invalid "reference".`);
    } else {
      const referenceWords = countWords(reference);
      if (referenceWords < 20) {
        errors.push(
          `Line ${lineIndex + 1}: reference too short (${referenceWords} words, min 20).`,
        );
      }
      if (isTodoPlaceholder(reference)) {
        errors.push(`Line ${lineIndex + 1}: reference contains TODO placeholder.`);
      }
    }
  });

  for (const tone of ALLOWED_TONES) {
    const count = toneCounts.get(tone) || 0;
    if (count < minPerTone) {
      errors.push(`Tone "${tone}" has ${count} examples (min required: ${minPerTone}).`);
    }
  }

  const summary = {
    datasetPath,
    totalExamples: lines.length,
    minPerToneRequired: minPerTone,
    toneCounts: Object.fromEntries(toneCounts.entries()),
    errors: errors.length,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (errors.length > 0) {
    process.stdout.write("\nValidation errors:\n");
    for (const error of errors.slice(0, 200)) {
      process.stdout.write(`- ${error}\n`);
    }
    process.exit(1);
  }

  process.stdout.write("\nGold dataset validation passed.\n");
}

main().catch((error) => {
  process.stderr.write(`Validation failed: ${error.message}\n`);
  process.exit(1);
});
