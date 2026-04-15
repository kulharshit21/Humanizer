import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const TONES = [
  "casual",
  "professional",
  "creative",
  "academic",
  "linkedin",
  "blog",
  "email",
  "simplify",
  "human-like",
];

const outputPath =
  process.env.OUTPUT_PATH ||
  path.join(projectRoot, "calibration", "gold-examples.todo.jsonl");
const examplesPerTone = Number(process.env.EXAMPLES_PER_TONE || "50");

function createPlaceholder(tone, index) {
  return {
    id: `${tone}-${String(index + 1).padStart(3, "0")}`,
    tone,
    input: `TODO_INPUT_${tone.toUpperCase()}_${index + 1}`,
    reference: `TODO_REFERENCE_${tone.toUpperCase()}_${index + 1}`,
    notes:
      "Replace TODO values with real source and high-quality human rewrite. Keep meaning and citations.",
  };
}

async function main() {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const lines = [];
  for (const tone of TONES) {
    for (let index = 0; index < examplesPerTone; index += 1) {
      lines.push(JSON.stringify(createPlaceholder(tone, index)));
    }
  }
  await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(
    `Scaffolded ${lines.length} placeholders at ${outputPath} (${examplesPerTone}/tone).\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`Failed to scaffold dataset: ${error.message}\n`);
  process.exit(1);
});
