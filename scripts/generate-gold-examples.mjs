import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const outputPath = path.join(projectRoot, "calibration", "gold-examples.jsonl");
const examplesPerTone = Number(process.env.EXAMPLES_PER_TONE || "30");

const topics = [
  "diabetic retinopathy screening workflow",
  "remote team release coordination",
  "customer onboarding optimization",
  "university assignment feedback quality",
  "B2B analytics dashboard adoption",
  "primary care follow-up compliance",
  "content marketing editorial planning",
  "product requirement review process",
  "supply chain delay communication",
  "student research writing clarity",
  "quality assurance defect triage",
  "clinical documentation consistency",
];

const tones = [
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

function createInput({ topic, tone, index }) {
  const value = 60 + (index % 17);
  const lag = 2 + (index % 5);
  return `The ${tone} draft about ${topic} explains that teams are facing repeated friction because handoffs are unclear and response expectations are inconsistent. It says performance dropped by about ${value}% during peak workload windows, and decisions were delayed by nearly ${lag} days because ownership was not explicit. The paragraph asks for a practical rewrite that keeps the facts but sounds more human and easier to follow.`;
}

function rewriteByTone(input, tone, index) {
  const cadenceLine = index % 2 === 0
    ? "It keeps the same facts but improves flow between sentences."
    : "It preserves the claims while making the writing feel more natural.";

  switch (tone) {
    case "casual":
      return `Here is the same point in plain language: teams keep getting stuck because handoffs are fuzzy and nobody is fully sure who replies next. During busy periods, performance drops and decisions can lag by a few days. ${cadenceLine} The goal is still practical clarity, just written like a real person instead of a template.`;
    case "professional":
      return `The core issue is unclear handoff ownership and inconsistent response expectations. During high-load periods, this leads to measurable performance decline and slower decisions. ${cadenceLine} A structured rewrite should retain all facts while improving readability and execution clarity.`;
    case "creative":
      return `The process does not fail all at once; it frays at the seams where ownership should be obvious. Handoffs blur, replies stall, and timelines drift. ${cadenceLine} The rewrite should keep the numbers and outcomes intact while giving the paragraph a cleaner rhythm and stronger momentum.`;
    case "academic":
      return `The paragraph identifies ambiguous handoff ownership and inconsistent response expectations as recurrent operational constraints. Under peak workload conditions, these constraints are associated with observable performance decline and delayed decision cycles [2]. ${cadenceLine} The revision should preserve empirical claims and improve textual coherence without altering evidentiary intent [3].`;
    case "linkedin":
      return `A recurring execution problem is not effort; it is ownership clarity. When handoffs are vague, response time slows and performance drops under load. ${cadenceLine} The rewrite should keep evidence intact and communicate the lesson in a concise, practical voice.`;
    case "blog":
      return `Most workflow slowdowns begin at the handoff layer. If ownership is vague, teams hesitate, response windows expand, and decisions move later than expected. ${cadenceLine} This rewrite keeps the numbers but presents the argument in a clearer reader-first structure.`;
    case "email":
      return `The draft highlights a recurring issue with unclear handoffs and inconsistent response expectations. During busy windows, performance decreases and decision timelines extend. ${cadenceLine} The revised version should keep all facts and make the message easier for stakeholders to act on.`;
    case "simplify":
      return `The problem is simple: handoffs are unclear. People do not know who should reply, so work slows down. During busy periods, performance falls and decisions come later. ${cadenceLine} The rewrite keeps the same facts and uses shorter, clearer sentences.`;
    case "human-like":
      return `The paragraph is pointing to a practical problem: teams lose speed when handoff ownership is not explicit. Under pressure, that uncertainty turns into slower replies and delayed decisions. ${cadenceLine} The rewrite should keep the evidence, reduce robotic phrasing, and read like careful human writing.`;
    default:
      return input;
  }
}

async function main() {
  const lines = [];
  let idCounter = 1;

  for (const tone of tones) {
    for (let i = 0; i < examplesPerTone; i += 1) {
      const topic = topics[i % topics.length];
      const input = createInput({ topic, tone, index: i });
      const reference = rewriteByTone(input, tone, i);
      const id = `${tone}-${String(idCounter).padStart(3, "0")}`;
      lines.push(JSON.stringify({ id, tone, input, reference }));
      idCounter += 1;
    }
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`Generated ${lines.length} gold examples at ${outputPath}.\n`);
}

main().catch((error) => {
  process.stderr.write(`Failed to generate gold examples: ${error.message}\n`);
  process.exit(1);
});
