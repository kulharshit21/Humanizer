import { createHash } from "node:crypto";
import type { DetectorLabel } from "@/lib/detection/types";

export function hashTextSha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function normalizeForHash(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

export function detectLanguageHeuristic(text: string): "en" | "unknown" {
  const asciiLetters = (text.match(/[a-z]/gi) || []).length;
  const allLetters = (text.match(/\p{L}/gu) || []).length;
  if (allLetters === 0) {
    return "unknown";
  }
  const ratio = asciiLetters / allLetters;
  return ratio > 0.75 ? "en" : "unknown";
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreToLabel(score: number | null): DetectorLabel {
  if (score === null) {
    return "inconclusive";
  }
  if (score >= 0.67) {
    return "likely_ai";
  }
  if (score >= 0.36) {
    return "mixed";
  }
  return "likely_human";
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function lexicalDiversity(text: string): number {
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return 0;
  }
  return new Set(tokens).size / tokens.length;
}

