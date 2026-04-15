import fs from "node:fs/promises";
import path from "node:path";

function getArg(flag, fallback = "") {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx === process.argv.length - 1) {
    return fallback;
  }
  return process.argv[idx + 1];
}

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function scoreText(text) {
  const tokens = tokenize(text);
  const diversity = tokens.length === 0 ? 0 : new Set(tokens).size / tokens.length;
  const sentences = splitSentences(text);
  const starts = sentences.map((item) => item.split(/\s+/)[0]?.toLowerCase() || "");
  let repeats = 0;
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i] && starts[i] === starts[i - 1]) {
      repeats += 1;
    }
  }
  const repetition = starts.length <= 1 ? 0 : repeats / (starts.length - 1);
  const score = Math.max(0, Math.min(1, (1 - diversity) * 0.7 + repetition * 0.3));
  return Number(score.toFixed(6));
}

function toPrediction(score) {
  if (score >= 0.5) {
    return "ai";
  }
  return "human";
}

function parseJsonl(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  const inputPath = getArg("--input");
  const outputPath = getArg("--out", "calibration/reports/detect-eval-results.jsonl");

  if (!inputPath) {
    throw new Error("Missing --input path. Example: pnpm run detect:eval --input fixtures.jsonl --out results.jsonl");
  }

  const absoluteInput = path.resolve(inputPath);
  const absoluteOutput = path.resolve(outputPath);
  const content = await fs.readFile(absoluteInput, "utf8");
  const rows = parseJsonl(content);

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let disagreementCount = 0;

  const results = rows.map((row) => {
    const score = scoreText(row.text || "");
    const prediction = toPrediction(score);
    const label = String(row.label || "").toLowerCase();
    const isAiLabel = label === "ai";
    const agrees = (prediction === "ai") === isAiLabel;
    if (!agrees) {
      disagreementCount += 1;
    }
    if (prediction === "ai" && isAiLabel) tp += 1;
    if (prediction === "ai" && !isAiLabel) fp += 1;
    if (prediction === "human" && !isAiLabel) tn += 1;
    if (prediction === "human" && isAiLabel) fn += 1;
    return {
      ...row,
      score,
      prediction,
      agrees,
    };
  });

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const disagreementRate = results.length === 0 ? 0 : disagreementCount / results.length;
  const accuracy = results.length === 0 ? 0 : (tp + tn) / results.length;

  await fs.mkdir(path.dirname(absoluteOutput), { recursive: true });
  const outputJsonl = results.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await fs.writeFile(absoluteOutput, outputJsonl, "utf8");

  console.log(`Wrote ${results.length} rows to ${absoluteOutput}`);
  console.log(`precision=${precision.toFixed(4)}`);
  console.log(`recall=${recall.toFixed(4)}`);
  console.log(`accuracy=${accuracy.toFixed(4)}`);
  console.log(`disagreement_rate=${disagreementRate.toFixed(4)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

