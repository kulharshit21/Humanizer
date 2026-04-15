"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BriefcaseBusiness,
  Check,
  Command,
  Copy,
  FileDown,
  HeartHandshake,
  Info,
  Lock,
  Loader2,
  LogOut,
  MessageCircle,
  Moon,
  Palette,
  Save,
  ShieldCheck,
  Sparkles,
  Sun,
  User,
  Wand2,
  X,
} from "lucide-react";
import { type Session } from "@supabase/supabase-js";
import { countWords, MAX_WORDS_PER_REQUEST } from "@/lib/constants";
import { getSupabaseBrowserClient } from "@/lib/supabase";

type AuthMode = "signin" | "signup";
type ToneMode =
  | "casual"
  | "professional"
  | "creative"
  | "academic"
  | "linkedin"
  | "blog"
  | "email"
  | "simplify"
  | "human-like";
type StrengthMode = "minimal" | "balanced" | "strong" | "maximum";
type ThemeMode = "light" | "dark" | "system";

type HumanizeResponse = {
  output: string;
  model: string;
  inputWordCount: number;
  outputWordCount: number;
  qualityScore?: number;
  tone?: ToneMode;
  strength?: StrengthMode;
  strengthLevel?: number;
  styleProfileApplied?: boolean;
};

type PrivacyMode = "no_log" | "hash_only" | "full_text_opt_in";

type DetectResponse = {
  summary: {
    riskBand: "low" | "medium" | "high" | "inconclusive";
    ensembleScore: number;
    disagreement: number;
    calibratorVersion: string;
  };
  detectors: Array<{
    id: string;
    name: string;
    status: "ok" | "failed" | "timeout" | "skipped";
    label: "likely_human" | "mixed" | "likely_ai" | "inconclusive";
    confidence: number | null;
    latencyMs: number;
    errorMessage?: string;
  }>;
  explainabilitySignals: {
    predictability: number;
    variation: number;
    repetition: number;
    domainMismatch: number;
  };
  sentenceHighlights: Array<{
    sentence: string;
    risk: number;
    reason: string;
  }>;
  disclaimer: string;
  reducedDetail: boolean;
  limitations?: string;
};

type WritingProfile = {
  sampleCount: number;
  avgSentenceLength: number;
  lexicalDiversity: number;
  preferredTone: ToneMode;
  updatedAt: string;
};

type DiffSegment = {
  text: string;
  kind: "same" | "added" | "space";
};

type ProfileForm = {
  email: string;
  display_name: string;
  full_name: string;
  role_title: string;
  company: string;
  website: string;
  bio: string;
};

type RewriteHistoryItem = {
  id: string;
  input_text: string;
  output_text: string;
  model: string;
  input_word_count: number;
  output_word_count: number;
  quality_score: number | null;
  created_at: string;
};

const EMPTY_PROFILE_FORM: ProfileForm = {
  email: "",
  display_name: "",
  full_name: "",
  role_title: "",
  company: "",
  website: "",
  bio: "",
};

const TONE_OPTIONS: Array<{ value: ToneMode; label: string }> = [
  { value: "casual", label: "Casual" },
  { value: "professional", label: "Professional" },
  { value: "creative", label: "Creative" },
  { value: "academic", label: "Academic" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "blog", label: "Blog" },
  { value: "email", label: "Email" },
  { value: "simplify", label: "Simplify" },
  { value: "human-like", label: "Human-like" },
];

const SAMPLE_INPUTS: Array<{ label: string; text: string; tone: ToneMode }> = [
  {
    label: "Academic",
    tone: "academic",
    text: "This study examines how distributed teams coordinate across time zones. While asynchronous collaboration reduces scheduling friction, it often introduces ambiguity in ownership and response expectations. A structured communication protocol can improve clarity, reduce rework, and increase project velocity without increasing meeting load.",
  },
  {
    label: "Email",
    tone: "email",
    text: "Hi team, I wanted to follow up on the release timeline. We are currently blocked on QA sign-off for two modules, and that dependency may push launch by two business days. If we can align on final approval by Wednesday, we should still be able to ship this sprint.",
  },
  {
    label: "Blog",
    tone: "blog",
    text: "Most teams do not have a productivity problem. They have a prioritization problem. When every task is urgent, context switching consumes the day. A better system is to define one outcome per week, break it into visible milestones, and protect deep work time on the calendar.",
  },
  {
    label: "Robotic",
    tone: "human-like",
    text: "In conclusion, it is important to note that leveraging innovative solutions can significantly enhance operational efficiency. Furthermore, organizations should additionally prioritize strategic alignment to ensure optimal outcomes in today's fast-paced world.",
  },
];

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function getSentenceLengths(text: string): number[] {
  return splitSentences(text).map((sentence) => tokenizeWords(sentence).length).filter(Boolean);
}

function getLexicalDiversity(text: string): number {
  const words = tokenizeWords(text);
  if (words.length === 0) {
    return 0;
  }
  return (new Set(words).size / words.length) * 100;
}

function getVariationScore(text: string): number {
  const lengths = getSentenceLengths(text);
  if (lengths.length < 2) {
    return 0;
  }
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  if (mean === 0) {
    return 0;
  }
  const variance = lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length;
  const stdDev = Math.sqrt(variance);
  return Math.min(100, (stdDev / mean) * 100);
}

function estimateSyllables(word: string): number {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!cleaned) {
    return 1;
  }
  const groups = cleaned.match(/[aeiouy]+/g)?.length ?? 1;
  return Math.max(1, groups);
}

function getReadabilityScore(text: string): number {
  const words = tokenizeWords(text);
  const sentences = splitSentences(text);
  if (words.length === 0 || sentences.length === 0) {
    return 0;
  }
  const syllables = words.reduce((sum, word) => sum + estimateSyllables(word), 0);
  const flesch = 206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syllables / words.length);
  return Math.max(0, Math.min(100, flesch));
}

function getJaccardSimilarityPercent(left: string, right: string): number {
  const leftSet = new Set(tokenizeWords(left));
  const rightSet = new Set(tokenizeWords(right));
  if (leftSet.size === 0 && rightSet.size === 0) {
    return 100;
  }

  let intersectionCount = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersectionCount += 1;
    }
  }

  const unionCount = new Set([...leftSet, ...rightSet]).size;
  if (unionCount === 0) {
    return 0;
  }

  return (intersectionCount / unionCount) * 100;
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

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeDiffToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9']/g, "");
}

function buildDiffSegments(inputText: string, outputText: string): {
  segments: DiffSegment[];
  removedTokens: string[];
} {
  const inputTokens = inputText.match(/\S+|\s+/g) || [];
  const outputTokens = outputText.match(/\S+|\s+/g) || [];
  const inputCount = new Map<string, number>();
  const outputCount = new Map<string, number>();

  inputTokens.forEach((token) => {
    if (/^\s+$/.test(token)) {
      return;
    }
    const normalized = normalizeDiffToken(token);
    if (!normalized) {
      return;
    }
    inputCount.set(normalized, (inputCount.get(normalized) || 0) + 1);
  }, []);

  const segments = outputTokens.map((token) => {
    if (/^\s+$/.test(token)) {
      return { text: token, kind: "space" as const };
    }
    const normalized = normalizeDiffToken(token);
    if (!normalized) {
      return { text: token, kind: "same" as const };
    }
    const remainingInputCount = inputCount.get(normalized) || 0;
    const consumedOutputCount = outputCount.get(normalized) || 0;
    outputCount.set(normalized, consumedOutputCount + 1);
    return {
      text: token,
      kind: consumedOutputCount < remainingInputCount ? ("same" as const) : ("added" as const),
    };
  });

  const removedTokens: string[] = [];
  for (const [token, count] of inputCount.entries()) {
    const producedCount = outputCount.get(token) || 0;
    const missing = Math.max(0, count - producedCount);
    for (let index = 0; index < missing; index += 1) {
      removedTokens.push(token);
    }
  }

  return { segments, removedTokens };
}

function getSafeAuthMessage(error: unknown, mode: AuthMode): string {
  if (!(error instanceof Error)) {
    return "Authentication failed. Please try again.";
  }

  const message = error.message.toLowerCase();

  if (message.includes("invalid login credentials")) {
    return "Invalid email or password.";
  }

  if (message.includes("email not confirmed")) {
    return "Please verify your email before signing in.";
  }

  if (message.includes("user already registered")) {
    return "This email is already registered. Please sign in instead.";
  }

  if (message.includes("password")) {
    return mode === "signup"
      ? "Password does not meet requirements. Use at least 8 characters."
      : "Invalid email or password.";
  }

  if (message.includes("database error saving new user")) {
    return "Signup failed due to a Supabase database trigger issue. Run the SQL migration and try again.";
  }

  if (message.includes("invalid api key")) {
    return "Supabase key is invalid. Check NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local.";
  }

  return "Authentication failed. Please try again.";
}

export default function Home() {
  const outputStreamRef = useRef(0);
  const [session, setSession] = useState<Session | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [inputText, setInputText] = useState("");
  const [outputText, setOutputText] = useState("");
  const [requestMeta, setRequestMeta] = useState("");
  const [humanizeLoading, setHumanizeLoading] = useState(false);
  const [humanizeError, setHumanizeError] = useState("");
  const [copied, setCopied] = useState(false);
  const [missingEnvMessage, setMissingEnvMessage] = useState("");
  const [profileForm, setProfileForm] = useState<ProfileForm>(EMPTY_PROFILE_FORM);
  const [profileMessage, setProfileMessage] = useState("");
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyClearing, setHistoryClearing] = useState(false);
  const [historyMessage, setHistoryMessage] = useState("");
  const [historyItems, setHistoryItems] = useState<RewriteHistoryItem[]>([]);
  const [toneMode, setToneMode] = useState<ToneMode>("professional");
  const [humanizeLevel, setHumanizeLevel] = useState(50);
  const [isProfileWindowOpen, setIsProfileWindowOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [qualityScore, setQualityScore] = useState<number | null>(null);
  const [loadingStepIndex, setLoadingStepIndex] = useState(0);
  const [speechRate, setSpeechRate] = useState(1);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [showAuthenticityPanel, setShowAuthenticityPanel] = useState(false);
  const [authenticityLoading, setAuthenticityLoading] = useState(false);
  const [authenticityError, setAuthenticityError] = useState("");
  const [authenticityData, setAuthenticityData] = useState<DetectResponse | null>(null);
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode>("hash_only");
  const [detailsEnabled, setDetailsEnabled] = useState(false);
  const [vendorConsent, setVendorConsent] = useState(false);
  const [showIntegrityModal, setShowIntegrityModal] = useState(false);
  const [streamedOutputText, setStreamedOutputText] = useState("");
  const [isStreamingOutput, setIsStreamingOutput] = useState(false);
  const [streamingPhase, setStreamingPhase] = useState<"draft" | "refine" | null>(null);
  const [showDiffPreview, setShowDiffPreview] = useState(true);
  const [writingProfile, setWritingProfile] = useState<WritingProfile | null>(null);
  const [matchMyVoice, setMatchMyVoice] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");

  const visibleOutputText = streamedOutputText || outputText;
  const hasOutput = visibleOutputText.trim().length > 0;
  const strengthMode = useMemo(() => getStrengthModeFromLevel(humanizeLevel), [humanizeLevel]);
  const wordCount = useMemo(() => countWords(inputText), [inputText]);
  const overLimit = wordCount > MAX_WORDS_PER_REQUEST;
  const isDarkMode = themeMode === "system" ? systemPrefersDark : themeMode === "dark";
  const sparkleDots = useMemo(
    () =>
      Array.from({ length: 26 }, (_, index) => ({
        id: index,
        left: `${(index * 37) % 100}%`,
        top: `${(index * 19) % 100}%`,
        delay: `${(index % 7) * 0.35}s`,
        duration: `${2.2 + (index % 5) * 0.6}s`,
      })),
    [],
  );
  const loadingSteps = [
    "Analyzing tone...",
    "Rewriting naturally...",
    "Polishing readability...",
    "Finalizing humanized output...",
  ];
  const activeText = visibleOutputText || inputText;
  const readingTimeMinutes = useMemo(
    () => Math.max(1, Math.ceil((countWords(activeText) || 0) / 200)),
    [activeText],
  );
  const charCount = useMemo(() => activeText.length, [activeText]);
  const sentenceCount = useMemo(() => splitSentences(activeText).length, [activeText]);
  const avgSentenceLength = useMemo(() => {
    if (sentenceCount === 0) {
      return 0;
    }
    return Math.round((countWords(activeText) / sentenceCount) * 10) / 10;
  }, [activeText, sentenceCount]);
  const lexicalDiversity = useMemo(() => getLexicalDiversity(activeText), [activeText]);
  const outputReadability = useMemo(() => getReadabilityScore(visibleOutputText), [visibleOutputText]);
  const inputReadability = useMemo(() => getReadabilityScore(inputText), [inputText]);
  const outputVariation = useMemo(() => getVariationScore(visibleOutputText), [visibleOutputText]);
  const inputVariation = useMemo(() => getVariationScore(inputText), [inputText]);
  const faithfulnessScore = useMemo(
    () => getJaccardSimilarityPercent(inputText, visibleOutputText),
    [inputText, visibleOutputText],
  );
  const changedWordEstimate = useMemo(() => {
    if (!inputText.trim() || !visibleOutputText.trim()) {
      return 0;
    }
    const inputWords = Math.max(1, countWords(inputText));
    return Math.round(((100 - faithfulnessScore) / 100) * inputWords);
  }, [faithfulnessScore, inputText, visibleOutputText]);
  const styleSignals = useMemo(
    () => [
      { label: "Naturalness", value: hasOutput ? qualityScore : null },
      { label: "Readability", value: hasOutput ? outputReadability : null },
      { label: "Variation", value: hasOutput ? outputVariation : null },
      { label: "Faithfulness", value: hasOutput ? faithfulnessScore : null },
    ],
    [faithfulnessScore, hasOutput, outputReadability, outputVariation, qualityScore],
  );
  const headerNavItems = useMemo(
    () =>
      session
        ? ["Home", "Features", "Pricing"]
        : ["Home", "Features", "Pricing", "Login"],
    [session],
  );
  const explainChanges = useMemo(() => {
    if (!inputText.trim() || !visibleOutputText.trim()) {
      return [];
    }
    const inputWords = countWords(inputText);
    const outputWords = countWords(visibleOutputText);
    const delta = outputWords - inputWords;
    const inputSentences = splitSentences(inputText).length;
    const outputSentences = splitSentences(visibleOutputText).length;
    const inputLexical = getLexicalDiversity(inputText);
    const outputLexical = getLexicalDiversity(visibleOutputText);
    const readabilityDelta = outputReadability - inputReadability;
    const variationDelta = outputVariation - inputVariation;
    return [
      `Words changed from ${inputWords} to ${outputWords} (${delta >= 0 ? "+" : ""}${delta}).`,
      `Sentence count changed from ${inputSentences} to ${outputSentences}.`,
      `Readability score changed by ${Math.round(readabilityDelta * 10) / 10} points.`,
      `Lexical diversity moved from ${Math.round(inputLexical)}% to ${Math.round(outputLexical)}%.`,
      `Sentence variation changed by ${Math.round(variationDelta * 10) / 10} points.`,
      delta !== 0
        ? `Rewrite intensity applied with ${Math.abs(delta)} word difference.`
        : "Length stayed close to original.",
    ];
  }, [inputReadability, inputText, inputVariation, outputReadability, outputVariation, visibleOutputText]);

  const diffPreview = useMemo(
    () => buildDiffSegments(inputText, outputText),
    [inputText, outputText],
  );

  const commandActions = [
    {
      id: "humanize",
      label: "Humanize current input",
      keywords: "rewrite run generate",
      run: () => void handleHumanize(),
    },
    {
      id: "detect",
      label: "Run authenticity signals",
      keywords: "detect scan authenticity",
      run: () => void handleRunAuthenticityScan(),
    },
    {
      id: "copy",
      label: "Copy clean output",
      keywords: "copy output",
      run: () => void handleCopy(),
    },
    {
      id: "copy-highlight",
      label: "Copy output with highlights",
      keywords: "copy diff highlights",
      run: () => void handleCopyWithHighlights(),
    },
    {
      id: "download",
      label: "Download TXT",
      keywords: "export txt",
      run: () => handleDownloadTxt(),
    },
    {
      id: "cycle-tone",
      label: `Cycle tone (current: ${toneMode})`,
      keywords: "tone mode",
      run: () => {
        const toneIndex = TONE_OPTIONS.findIndex((item) => item.value === toneMode);
        const nextIndex = (toneIndex + 1) % TONE_OPTIONS.length;
        setToneMode(TONE_OPTIONS[nextIndex].value);
      },
    },
    {
      id: "load-template",
      label: "Load Academic template",
      keywords: "template sample academic",
      run: () => {
        const sample = SAMPLE_INPUTS[0];
        if (sample) {
          setInputText(sample.text);
          setToneMode(sample.tone);
        }
      },
    },
    {
      id: "toggle-match-voice",
      label: matchMyVoice ? "Disable Match my voice" : "Enable Match my voice",
      keywords: "voice profile personalization",
      run: () => setMatchMyVoice((prev) => !prev),
    },
  ];

  const filteredCommandActions = (() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) {
      return commandActions;
    }
    return commandActions.filter(
      (action) =>
        action.label.toLowerCase().includes(query) || action.keywords.toLowerCase().includes(query),
    );
  })();

  const loadUserData = useCallback(async (activeSession: Session) => {
    const supabase = getSupabaseBrowserClient();
    setProfileLoading(true);
    setHistoryLoading(true);

    const [profileResult, historyResult] = await Promise.all([
      supabase
        .from("profiles")
        .select("email, display_name, full_name, role_title, company, website, bio")
        .eq("user_id", activeSession.user.id)
        .maybeSingle(),
      supabase
        .from("rewrites")
        .select(
          "id, input_text, output_text, model, input_word_count, output_word_count, quality_score, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    if (profileResult.error) {
      setProfileMessage(
        "Could not load profile details. Run the SQL migration in supabase/migrations.",
      );
    } else {
      setProfileForm({
        email: profileResult.data?.email || activeSession.user.email || "",
        display_name: profileResult.data?.display_name || "",
        full_name: profileResult.data?.full_name || "",
        role_title: profileResult.data?.role_title || "",
        company: profileResult.data?.company || "",
        website: profileResult.data?.website || "",
        bio: profileResult.data?.bio || "",
      });
    }

    if (!historyResult.error && historyResult.data) {
      setHistoryItems(historyResult.data);
    }

    setProfileLoading(false);
    setHistoryLoading(false);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemPrefersDark(mediaQuery.matches);

    const onSystemThemeChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };
    mediaQuery.addEventListener("change", onSystemThemeChange);

    const savedTheme = window.localStorage.getItem("humanizer-theme");
    if (savedTheme === "light" || savedTheme === "dark" || savedTheme === "system") {
      setThemeMode(savedTheme);
    } else {
      setThemeMode("system");
    }

    return () => mediaQuery.removeEventListener("change", onSystemThemeChange);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("humanizer-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    const rawProfile = window.localStorage.getItem("humanizer-writing-profile");
    if (!rawProfile) {
      return;
    }
    try {
      const parsedProfile = JSON.parse(rawProfile) as WritingProfile;
      if (
        typeof parsedProfile.sampleCount === "number" &&
        typeof parsedProfile.avgSentenceLength === "number" &&
        typeof parsedProfile.lexicalDiversity === "number" &&
        typeof parsedProfile.preferredTone === "string"
      ) {
        setWritingProfile(parsedProfile);
      }
    } catch {
      window.localStorage.removeItem("humanizer-writing-profile");
    }
  }, []);

  useEffect(() => {
    if (!writingProfile) {
      return;
    }
    window.localStorage.setItem("humanizer-writing-profile", JSON.stringify(writingProfile));
  }, [writingProfile]);

  useEffect(() => {
    if (!humanizeLoading) {
      setLoadingStepIndex(0);
      return;
    }

    const intervalId = window.setInterval(() => {
      setLoadingStepIndex((prev) => (prev + 1) % loadingSteps.length);
    }, 1300);

    return () => window.clearInterval(intervalId);
  }, [humanizeLoading, loadingSteps.length]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isPrimary = event.ctrlKey || event.metaKey;
      if (isPrimary && event.key === "Enter") {
        event.preventDefault();
        void handleHumanize();
      }
      if (isPrimary && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      }
      if (isPrimary && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void handleCopy();
      }
      if (event.key === "Escape") {
        setIsProfileWindowOpen(false);
        setIsCommandPaletteOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    try {
      const supabase = getSupabaseBrowserClient();

      supabase.auth.getSession().then(({ data }) => {
        if (!cancelled) {
          setSession(data.session);
        }
      });

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, nextSession) => {
        if (!cancelled) {
          setSession(nextSession);
          if (nextSession) {
            void loadUserData(nextSession);
          } else {
            setProfileForm(EMPTY_PROFILE_FORM);
            setHistoryItems([]);
            setProfileMessage("");
          }
        }
      });

      return () => {
        cancelled = true;
        subscription.unsubscribe();
      };
    } catch (error) {
      setMissingEnvMessage(
        error instanceof Error
          ? error.message
          : "Supabase environment variables are missing.",
      );
    }
  }, [loadUserData]);

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthMessage("");
    setAuthLoading(true);

    try {
      const supabase = getSupabaseBrowserClient();

      if (authMode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) {
          throw error;
        }
        setAuthMessage(
          "Account created. Check your email for verification if required by your Supabase settings.",
        );
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          throw error;
        }
        setAuthMessage("Signed in successfully.");
      }
    } catch (error) {
      setAuthMessage(getSafeAuthMessage(error, authMode));
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleSignOut() {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    setOutputText("");
    setInputText("");
    setRequestMeta("");
    setQualityScore(null);
    setHumanizeError("");
    setProfileMessage("");
    setAuthenticityData(null);
    setAuthenticityError("");
    setStreamedOutputText("");
    setIsStreamingOutput(false);
    setStreamingPhase(null);
  }

  function updateWritingProfileFromOutput(nextOutput: string) {
    if (!nextOutput.trim()) {
      return;
    }
    const nextSentenceLengths = getSentenceLengths(nextOutput);
    const nextAvgSentenceLength =
      nextSentenceLengths.length > 0
        ? nextSentenceLengths.reduce((sum, value) => sum + value, 0) / nextSentenceLengths.length
        : 0;
    const nextLexicalDiversity = getLexicalDiversity(nextOutput);

    setWritingProfile((prev) => {
      if (!prev) {
        return {
          sampleCount: 1,
          avgSentenceLength: Number(nextAvgSentenceLength.toFixed(2)),
          lexicalDiversity: Number(nextLexicalDiversity.toFixed(2)),
          preferredTone: toneMode,
          updatedAt: new Date().toISOString(),
        };
      }
      const sampleCount = prev.sampleCount + 1;
      return {
        sampleCount,
        avgSentenceLength: Number(
          ((prev.avgSentenceLength * prev.sampleCount + nextAvgSentenceLength) / sampleCount).toFixed(2),
        ),
        lexicalDiversity: Number(
          ((prev.lexicalDiversity * prev.sampleCount + nextLexicalDiversity) / sampleCount).toFixed(2),
        ),
        preferredTone: toneMode,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  const streamOutputInPhases = useCallback(async (finalOutput: string) => {
    const streamRunId = outputStreamRef.current + 1;
    outputStreamRef.current = streamRunId;

    const chunks = finalOutput.match(/\S+\s*/g) || [finalOutput];
    if (chunks.length < 8) {
      setStreamedOutputText(finalOutput);
      setIsStreamingOutput(false);
      setStreamingPhase(null);
      return;
    }

    setIsStreamingOutput(true);
    const draftTokenCount = Math.max(1, Math.floor(chunks.length * 0.62));
    const reveal = async (start: number, end: number, step: number, phase: "draft" | "refine") => {
      setStreamingPhase(phase);
      for (let index = start; index < end; index += step) {
        if (outputStreamRef.current !== streamRunId) {
          return;
        }
        const sliceEnd = Math.min(end, index + step);
        setStreamedOutputText(chunks.slice(0, sliceEnd).join(""));
        await sleep(phase === "draft" ? 45 : 70);
      }
    };

    await reveal(0, draftTokenCount, 4, "draft");
    await sleep(240);
    await reveal(draftTokenCount, chunks.length, 2, "refine");

    if (outputStreamRef.current === streamRunId) {
      setStreamedOutputText(finalOutput);
      setIsStreamingOutput(false);
      setStreamingPhase(null);
    }
  }, []);

  async function handleHumanize() {
    setHumanizeError("");
    setOutputText("");
    setStreamedOutputText("");
    outputStreamRef.current += 1;
    setIsStreamingOutput(false);
    setStreamingPhase(null);
    setRequestMeta("");
    setCopied(false);
    setQualityScore(null);
    setAuthenticityData(null);
    setAuthenticityError("");

    if (!session) {
      setHumanizeError("Please sign in first.");
      return;
    }

    if (!inputText.trim()) {
      setHumanizeError("Enter text to humanize.");
      return;
    }

    if (overLimit) {
      setHumanizeError(`Input must be ${MAX_WORDS_PER_REQUEST} words or less.`);
      return;
    }

    setHumanizeLoading(true);

    try {
      const response = await fetch("/api/humanize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          text: inputText,
          tone: toneMode,
          strength: strengthMode,
          strengthLevel: humanizeLevel,
          styleProfile:
            matchMyVoice && writingProfile
              ? {
                  avgSentenceLength: writingProfile.avgSentenceLength,
                  lexicalDiversity: writingProfile.lexicalDiversity,
                  preferredTone: writingProfile.preferredTone,
                }
              : undefined,
        }),
      });

      const payload = (await response.json()) as HumanizeResponse & {
        error?: string;
        details?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "Humanization failed.");
      }

      setOutputText(payload.output);
      setStreamedOutputText("");
      void streamOutputInPhases(payload.output);
      updateWritingProfileFromOutput(payload.output);
      if (typeof payload.strengthLevel === "number") {
        setHumanizeLevel(payload.strengthLevel);
      }
      setQualityScore(payload.qualityScore ?? null);
      setRequestMeta(
        `Humanized successfully. ${payload.outputWordCount} words generated.${
          payload.styleProfileApplied ? " Voice profile guidance applied." : ""
        }`,
      );
      if (session) {
        void loadUserData(session);
      }
    } catch (error) {
      setHumanizeError(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setHumanizeLoading(false);
    }
  }

  async function handleCopy() {
    if (!outputText.trim()) {
      return;
    }

    await navigator.clipboard.writeText(outputText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function handleCopyWithHighlights() {
    if (!outputText.trim()) {
      return;
    }
    const highlighted = diffPreview.segments
      .map((segment) => {
        if (segment.kind !== "added") {
          return segment.text;
        }
        return `[[+${segment.text.trim()}]]${segment.text.endsWith(" ") ? " " : ""}`;
      })
      .join("");
    await navigator.clipboard.writeText(highlighted);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function handleAcceptAllChanges() {
    if (!outputText.trim()) {
      return;
    }
    setInputText(outputText);
    setRequestMeta("Accepted rewrite as your new source text.");
  }

  function handleDownloadTxt() {
    if (!outputText) {
      return;
    }

    const blob = new Blob([outputText], { type: "text/plain;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `humanized-${new Date().toISOString().slice(0, 10)}.txt`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  }

  async function handleRunAuthenticityScan() {
    setAuthenticityError("");
    setAuthenticityData(null);

    if (!session) {
      setAuthenticityError("Please sign in first.");
      return;
    }

    const scanText = outputText.trim() || inputText.trim();
    if (!scanText) {
      setAuthenticityError("Generate output (or provide text) before running authenticity signals.");
      return;
    }

    setAuthenticityLoading(true);
    try {
      const response = await fetch("/api/detect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          text: scanText,
          context: {
            language: "en",
            mode: toneMode === "academic" ? "academic" : "general",
          },
          privacy_mode: privacyMode,
          details_enabled: detailsEnabled,
          vendor_consent: vendorConsent,
        }),
      });

      const payload = (await response.json()) as DetectResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Could not run authenticity scan.");
      }

      setAuthenticityData(payload);
      if (toneMode === "academic") {
        setShowIntegrityModal(true);
      }
    } catch (error) {
      setAuthenticityError(error instanceof Error ? error.message : "Authenticity scan failed.");
    } finally {
      setAuthenticityLoading(false);
    }
  }

  function handleDownloadAuthReport() {
    if (!authenticityData) {
      return;
    }
    const report = {
      createdAt: new Date().toISOString(),
      mode: toneMode,
      privacyMode,
      disclaimer: authenticityData.disclaimer,
      limitations: authenticityData.limitations,
      summary: authenticityData.summary,
      detectors: authenticityData.detectors.map((detector) => ({
        name: detector.name,
        status: detector.status,
        label: detector.label,
        confidence: detector.confidence,
        latencyMs: detector.latencyMs,
      })),
      explainabilitySignals: authenticityData.explainabilitySignals,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `authenticity-signals-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  }

  function handleSpeak() {
    if (!outputText || typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(outputText);
    utterance.rate = speechRate;
    utterance.onend = () => {
      setIsSpeaking(false);
      setIsPaused(false);
    };
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
    setIsPaused(false);
  }

  function handlePauseSpeech() {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }
    if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
      window.speechSynthesis.pause();
      setIsPaused(true);
    } else if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      setIsPaused(false);
    }
  }

  function handleStopSpeech() {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
    setIsPaused(false);
  }

  async function handleSaveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) {
      return;
    }

    setProfileSaving(true);
    setProfileMessage("");

    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.from("profiles").upsert(
        {
          user_id: session.user.id,
          email: session.user.email || profileForm.email || null,
          display_name: profileForm.display_name || null,
          full_name: profileForm.full_name || null,
          role_title: profileForm.role_title || null,
          company: profileForm.company || null,
          website: profileForm.website || null,
          bio: profileForm.bio || null,
        },
        { onConflict: "user_id" },
      );

      if (error) {
        throw error;
      }

      setProfileMessage("Profile updated.");
    } catch {
      setProfileMessage(
        "Could not save profile. Confirm you ran supabase/migrations/001_user_profiles_and_rewrites.sql.",
      );
    } finally {
      setProfileSaving(false);
    }
  }

  async function handleClearHistoryPermanently() {
    if (!session || historyClearing) {
      return;
    }

    const confirmed = window.confirm(
      "Permanently delete all rewrite history? This cannot be undone.",
    );
    if (!confirmed) {
      return;
    }

    setHistoryClearing(true);
    setHistoryMessage("");
    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.from("rewrites").delete().eq("user_id", session.user.id);
      if (error) {
        throw error;
      }
      setHistoryItems([]);
      setHistoryMessage("All rewrite history has been permanently deleted.");
    } catch {
      setHistoryMessage("Could not clear history right now. Please try again.");
    } finally {
      setHistoryClearing(false);
    }
  }

  if (missingEnvMessage) {
    return (
      <main className="min-h-screen bg-slate-950 p-6 text-slate-100 md:p-10">
        <div className="mx-auto max-w-3xl rounded-3xl border border-white/10 bg-slate-900/70 p-8 shadow-2xl shadow-black/30 backdrop-blur">
          <h1 className="text-2xl font-semibold tracking-tight">Configuration required</h1>
          <p className="mt-4 text-sm leading-6 text-slate-300">{missingEnvMessage}</p>
          <p className="mt-2 text-sm text-zinc-400">
            Create a <code className="rounded bg-black/30 px-1">.env.local</code> file
            from <code className="rounded bg-black/30 px-1">.env.example</code>.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main
      className={`relative min-h-screen overflow-hidden ${
        isDarkMode
          ? "bg-[radial-gradient(circle_at_top,_#1b1b46_0%,_#0f1030_40%,_#08081f_100%)] text-slate-100"
          : "bg-[linear-gradient(165deg,_#f3f7ff_0%,_#edf4ff_35%,_#eff5ff_100%)] text-slate-900"
      }`}
    >
      <div
        className={`pointer-events-none absolute inset-0 ${
          isDarkMode
            ? "bg-[radial-gradient(circle_at_20%_10%,rgba(105,95,255,0.25),transparent_35%),radial-gradient(circle_at_80%_18%,rgba(99,204,255,0.22),transparent_32%),radial-gradient(circle_at_50%_80%,rgba(73,56,179,0.28),transparent_40%)]"
            : "bg-[radial-gradient(circle_at_20%_10%,rgba(63,131,248,0.18),transparent_35%),radial-gradient(circle_at_80%_18%,rgba(59,130,246,0.14),transparent_32%),radial-gradient(circle_at_50%_80%,rgba(167,139,250,0.14),transparent_40%)]"
        }`}
      />
      <div
        className={`animate-drift pointer-events-none absolute -left-16 top-36 h-72 w-72 rounded-full blur-3xl ${
          isDarkMode ? "bg-indigo-500/25" : "bg-blue-300/35"
        }`}
      />
      <div
        className={`animate-drift pointer-events-none absolute -right-20 top-24 h-80 w-80 rounded-full blur-3xl ${
          isDarkMode ? "bg-fuchsia-500/20" : "bg-cyan-300/30"
        }`}
        style={{ animationDelay: "1.2s" }}
      />
      <div className="pointer-events-none absolute inset-0">
        {sparkleDots.map((dot) => (
          <span
            key={dot.id}
            className={`animate-twinkle absolute h-1.5 w-1.5 rounded-full ${
              isDarkMode ? "bg-indigo-100/70" : "bg-blue-400/45"
            }`}
            style={{
              left: dot.left,
              top: dot.top,
              animationDelay: dot.delay,
              animationDuration: dot.duration,
            }}
          />
        ))}
      </div>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 md:py-8">
        <header
          className={`relative overflow-hidden rounded-3xl px-5 py-6 text-white sm:px-8 ${
            isDarkMode
              ? "border border-indigo-300/20 bg-[radial-gradient(circle_at_10%_20%,_#2a2c7e_0%,_#20236a_25%,_#171c55_50%,_#0f1445_100%)] shadow-2xl shadow-black/40"
              : "border border-blue-200 bg-[radial-gradient(circle_at_10%_20%,_#4c89ff_0%,_#3b6ff0_26%,_#365fdb_52%,_#2f53c2_100%)] shadow-2xl shadow-blue-900/20"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="inline-flex items-center gap-2 text-xl font-semibold">
              <span className="rounded-xl bg-white/15 p-1.5">
                <Sparkles size={16} />
              </span>
              Humanizer
            </p>
            <nav
              className={`hidden items-center gap-10 text-base font-semibold md:flex ${
                isDarkMode ? "text-indigo-100" : "text-blue-100"
              }`}
            >
              {headerNavItems.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    if (item === "Login") {
                      setAuthMode("signin");
                      document.getElementById("auth-panel")?.scrollIntoView({ behavior: "smooth" });
                    }
                  }}
                  className="transition hover:text-white"
                >
                  {item}
                </button>
              ))}
            </nav>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsCommandPaletteOpen(true)}
                className="inline-flex items-center gap-2 rounded-full border border-white/35 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/20"
              >
                <Command size={15} />
                Cmd
              </button>
              <button
                type="button"
                onClick={() =>
                  setThemeMode((prev) =>
                    prev === "light" ? "dark" : prev === "dark" ? "system" : "light",
                  )
                }
                className="inline-flex items-center gap-2 rounded-full border border-white/35 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/20"
              >
                {themeMode === "light" ? (
                  <Sun size={15} />
                ) : themeMode === "dark" ? (
                  <Moon size={15} />
                ) : (
                  <Sparkles size={15} />
                )}
                {themeMode === "light" ? "Light" : themeMode === "dark" ? "Dark" : "System"}
              </button>
              {session ? (
                <>
                  <button
                    type="button"
                    onClick={() => setIsProfileWindowOpen(true)}
                    className="rounded-full border border-white/30 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/20"
                  >
                    Profile Window
                  </button>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="inline-flex items-center gap-2 rounded-full bg-[linear-gradient(90deg,_#2f56ef_0%,_#5878ff_45%,_#d366cf_100%)] px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-950/30 transition hover:opacity-90"
                  >
                    <LogOut size={15} />
                    Sign Out
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-16 hidden h-44 md:block">
            <div
              className={`animate-float-slow absolute left-3 top-6 rounded-3xl border p-3 ${
                isDarkMode
                  ? "border-indigo-200/20 bg-indigo-900/20"
                  : "border-white/25 bg-white/15"
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="animate-pulse-glow grid h-20 w-20 place-items-center rounded-full bg-[radial-gradient(circle_at_30%_30%,#ffffff_0%,#f8ccff_22%,#9f7aea_52%,#4f46e5_100%)] text-4xl shadow-lg shadow-black/25">
                  👩
                </div>
                <div className="text-xs font-medium text-white/85">
                  <p>AI Writing Assistant</p>
                  <p className="mt-1 text-white/70">Live humanization engine</p>
                </div>
              </div>
            </div>
            <div
              className={`animate-float-slow absolute right-5 top-10 rounded-3xl border px-4 py-3 ${
                isDarkMode
                  ? "border-indigo-200/20 bg-indigo-900/20"
                  : "border-white/25 bg-white/15"
              }`}
              style={{ animationDelay: "0.6s" }}
            >
              <div className="flex items-center gap-2 text-white/90">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-white/20 text-lg">💬</span>
                <span className="grid h-10 w-10 place-items-center rounded-full bg-white/20 text-lg">✨</span>
                <span className="grid h-10 w-10 place-items-center rounded-full bg-white/20 text-lg">🚀</span>
              </div>
            </div>
          </div>
          <div className="mt-8 text-center">
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Humanize Your Text</h1>
            <p className="mx-auto mt-3 max-w-2xl text-sm text-blue-50 sm:text-base">
              Paste your text and we&apos;ll transform it into natural, human-like content.
            </p>
          </div>
        </header>

        {!session ? (
          <section
            id="auth-panel"
            className={`mx-auto w-full max-w-md rounded-3xl p-6 shadow-xl ${
              isDarkMode
                ? "border border-indigo-400/25 bg-slate-900/80 shadow-black/30"
                : "border border-blue-200 bg-white shadow-blue-100"
            }`}
          >
            <h2
              className={`mb-1 text-xl font-semibold tracking-tight ${
                isDarkMode ? "text-slate-100" : "text-slate-900"
              }`}
            >
              Welcome back
            </h2>
            <p className={`mb-6 text-sm ${isDarkMode ? "text-slate-300" : "text-slate-400"}`}>
              Sign in to rewrite text and manage your profile.
            </p>
            <div
              className={`mb-6 flex rounded-xl p-1 ${
                isDarkMode ? "bg-slate-800/70" : "bg-slate-100"
              }`}
            >
              <button
                type="button"
                onClick={() => setAuthMode("signin")}
                className={`w-1/2 rounded-lg px-3 py-2 text-sm font-medium ${
                  authMode === "signin"
                    ? "bg-indigo-500 text-white shadow-sm shadow-indigo-950/50"
                    : isDarkMode
                      ? "text-slate-300 hover:text-white"
                      : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => setAuthMode("signup")}
                className={`w-1/2 rounded-lg px-3 py-2 text-sm font-medium ${
                  authMode === "signup"
                    ? "bg-indigo-500 text-white shadow-sm shadow-indigo-950/50"
                    : isDarkMode
                      ? "text-slate-300 hover:text-white"
                      : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Sign up
              </button>
            </div>

            <form className="space-y-4" onSubmit={handleAuthSubmit}>
              <label className="block text-sm">
                <span className={`mb-1 block ${isDarkMode ? "text-zinc-300" : "text-slate-600"}`}>
                  Email
                </span>
                <input
                  required
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className={`w-full rounded-xl px-3 py-2.5 outline-none ring-indigo-300 transition focus:ring-2 ${
                    isDarkMode
                      ? "border border-white/10 bg-slate-800/80 text-slate-100"
                      : "border border-slate-200 bg-slate-50 text-slate-800"
                  }`}
                  placeholder="you@example.com"
                />
              </label>

              <label className="block text-sm">
                <span className={`mb-1 block ${isDarkMode ? "text-zinc-300" : "text-slate-600"}`}>
                  Password
                </span>
                <input
                  required
                  minLength={8}
                  type="password"
                  autoComplete={authMode === "signin" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className={`w-full rounded-xl px-3 py-2.5 outline-none ring-indigo-300 transition focus:ring-2 ${
                    isDarkMode
                      ? "border border-white/10 bg-slate-800/80 text-slate-100"
                      : "border border-slate-200 bg-slate-50 text-slate-800"
                  }`}
                  placeholder="Minimum 8 characters"
                />
              </label>

              <button
                type="submit"
                disabled={authLoading}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-500 px-4 py-2.5 font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {authLoading ? <Loader2 size={16} className="animate-spin" /> : null}
                {authMode === "signin" ? "Sign in" : "Create account"}
              </button>
            </form>

            {authMessage ? (
              <p
                className={`mt-4 rounded-lg px-3 py-2 text-xs ${
                  isDarkMode
                    ? "border border-white/10 bg-slate-800/80 text-slate-300"
                    : "border border-slate-200 bg-slate-50 text-slate-600"
                }`}
              >
                {authMessage}
              </p>
            ) : null}
            <p className={`mt-3 text-center text-[11px] ${isDarkMode ? "text-zinc-400" : "text-slate-500"}`}>
              No seeded/demo accounts. All authentication uses your live Supabase project.
            </p>
          </section>
        ) : (
          <section className="space-y-6">
            <article
              className={`rounded-3xl p-5 shadow-xl sm:p-7 ${
                isDarkMode
                  ? "border border-indigo-400/20 bg-[#121737]/90 shadow-black/30"
                  : "border border-blue-200 bg-white shadow-blue-100"
              }`}
            >
              <div className="mb-3 flex items-center justify-between">
                <h2
                  className={`text-lg font-semibold tracking-tight ${
                    isDarkMode ? "text-slate-100" : "text-slate-800"
                  }`}
                >
                  Input Text
                </h2>
                <p
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    overLimit
                      ? isDarkMode
                        ? "bg-red-500/20 text-red-200"
                        : "bg-red-100 text-red-600"
                      : isDarkMode
                        ? "bg-indigo-500/25 text-indigo-100"
                        : "bg-blue-100 text-blue-700"
                  }`}
                >
                  Words: {wordCount}/{MAX_WORDS_PER_REQUEST}
                </p>
              </div>
              <textarea
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                placeholder={`Paste up to ${MAX_WORDS_PER_REQUEST} words here...`}
                aria-label="Input text to humanize"
                className={`h-56 w-full resize-none rounded-2xl px-4 py-3 text-sm leading-6 outline-none transition focus:ring-2 ${
                  isDarkMode
                    ? "border border-indigo-300/20 bg-[#0b1030] text-slate-100 ring-indigo-300"
                    : "border border-slate-200 bg-slate-50 text-slate-700 ring-blue-300"
                }`}
              />
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={handleHumanize}
                  disabled={humanizeLoading || overLimit || !inputText.trim()}
                  aria-label="Humanize text"
                  className="inline-flex min-w-64 items-center justify-center gap-2 rounded-full bg-[linear-gradient(90deg,_#3458ef_0%,_#5a7cff_45%,_#d96ace_100%)] px-7 py-3 text-base font-semibold text-white shadow-lg shadow-blue-200 transition hover:scale-[1.01] hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {humanizeLoading ? (
                    <Loader2 className="animate-spin" size={16} />
                  ) : (
                    <Wand2 size={16} />
                  )}
                  Humanize Text
                </button>
              </div>
              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <p className={isDarkMode ? "text-slate-300" : "text-slate-600"}>
                    Humanization strength:{" "}
                    <span className="font-semibold capitalize">
                      {strengthMode} ({humanizeLevel}/100)
                    </span>
                  </p>
                  <p className={isDarkMode ? "text-slate-400" : "text-slate-500"}>
                    Ctrl/Cmd + Enter to run | Ctrl/Cmd + K for palette
                  </p>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={humanizeLevel}
                  onChange={(event) => setHumanizeLevel(Number(event.target.value))}
                  className="w-full accent-indigo-500"
                  aria-label="Humanization strength slider"
                />
              </div>
              <div
                className={`mt-3 rounded-2xl border p-3 ${
                  isDarkMode ? "border-indigo-300/20 bg-[#141a40]" : "border-slate-200 bg-slate-50"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    className={`inline-flex items-center gap-2 text-xs font-medium ${
                      isDarkMode ? "text-slate-200" : "text-slate-700"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={matchMyVoice}
                      onChange={(event) => setMatchMyVoice(event.target.checked)}
                    />
                    Match my voice
                  </label>
                  <button
                    type="button"
                    onClick={() => updateWritingProfileFromOutput(outputText)}
                    disabled={!outputText.trim()}
                    className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-50 ${
                      isDarkMode
                        ? "border border-indigo-300/20 bg-[#151b42] text-slate-200 hover:bg-[#1a2250]"
                        : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    Save profile from output
                  </button>
                </div>
                <p className={`mt-2 text-[11px] ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                  {writingProfile
                    ? `Profile learned from ${writingProfile.sampleCount} rewrites | Avg sentence ${writingProfile.avgSentenceLength} words | Lexical diversity ${Math.round(writingProfile.lexicalDiversity)}%.`
                    : "No profile yet. Generate and save a few outputs to personalize rewrite style."}
                </p>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {TONE_OPTIONS.map((toneOption) => (
                  <button
                    key={toneOption.value}
                    type="button"
                    onClick={() => setToneMode(toneOption.value)}
                    className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition ${
                      toneMode === toneOption.value
                        ? isDarkMode
                          ? "border-indigo-300/50 bg-indigo-400/20 text-indigo-100 shadow-[0_0_22px_rgba(99,102,241,0.18)]"
                          : "border-blue-300 bg-blue-50 text-blue-700"
                        : isDarkMode
                          ? "border-indigo-300/20 bg-[#151b42] text-slate-200 hover:bg-[#1a2250]"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                    aria-pressed={toneMode === toneOption.value}
                  >
                    {toneOption.value === "casual" ? <MessageCircle size={15} /> : null}
                    {toneOption.value === "professional" ? <BriefcaseBusiness size={15} /> : null}
                    {toneOption.value === "creative" ? <Palette size={15} /> : null}
                    {toneOption.label}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {SAMPLE_INPUTS.map((sample) => (
                  <button
                    key={sample.label}
                    type="button"
                    onClick={() => {
                      setInputText(sample.text);
                      setToneMode(sample.tone);
                    }}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                      isDarkMode
                        ? "border-indigo-300/25 bg-[#141a40] text-slate-200 hover:bg-[#1a2250]"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    Try {sample.label}
                  </button>
                ))}
              </div>
              {humanizeLoading ? (
                <p className={`mt-3 text-center text-sm ${isDarkMode ? "text-indigo-200" : "text-blue-700"}`}>
                  {loadingSteps[loadingStepIndex]}
                </p>
              ) : null}
              {inputText.trim().length === 0 ? (
                <p className={`mt-3 text-xs ${isDarkMode ? "text-slate-400" : "text-slate-500"}`}>
                  Paste text or try a sample above. Tip: press Ctrl/Cmd+Shift+C to copy output quickly.
                </p>
              ) : null}
              {humanizeError ? (
                <p
                  className={`mt-3 rounded-lg px-3 py-2 text-xs ${
                    isDarkMode
                      ? "border border-red-400/25 bg-red-500/10 text-red-200"
                      : "border border-red-200 bg-red-50 text-red-600"
                  }`}
                >
                  {humanizeError}
                </p>
              ) : null}
            </article>

            <article
              className={`rounded-3xl shadow-xl ${
                isDarkMode
                  ? "border border-indigo-400/20 bg-[#121737]/90 shadow-black/30"
                  : "border border-blue-200 bg-white shadow-blue-100"
              }`}
            >
              <div
                className={`flex flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-6 ${
                  isDarkMode ? "border-b border-indigo-300/15" : "border-b border-slate-100"
                }`}
              >
                <div>
                  <h3 className={`text-2xl font-semibold ${isDarkMode ? "text-slate-100" : "text-slate-800"}`}>
                    Humanized Text
                  </h3>
                  {isStreamingOutput ? (
                    <p className={`mt-1 text-xs ${isDarkMode ? "text-indigo-200" : "text-blue-700"}`}>
                      Live rewrite mode: {streamingPhase === "draft" ? "drafting" : "refining"}...
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleAcceptAllChanges}
                    disabled={!outputText.trim()}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                      isDarkMode
                        ? "border border-indigo-300/20 bg-[#151b42] text-slate-200 hover:bg-[#1a2250]"
                        : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    Accept all
                  </button>
                  <button
                    type="button"
                    onClick={handleCopy}
                    disabled={!outputText.trim()}
                    className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                      isDarkMode
                        ? "border border-indigo-300/20 bg-[#151b42] text-slate-200 hover:bg-[#1a2250]"
                        : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    <Copy size={13} />
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyWithHighlights}
                    disabled={!outputText.trim()}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                      isDarkMode
                        ? "border border-indigo-300/20 bg-[#151b42] text-slate-200 hover:bg-[#1a2250]"
                        : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    Copy + Highlights
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadTxt}
                    disabled={!outputText.trim()}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                      isDarkMode
                        ? "border border-indigo-300/20 bg-[#151b42] text-slate-200 hover:bg-[#1a2250]"
                        : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    Download TXT
                  </button>
                </div>
              </div>
              <div className="grid gap-0 sm:grid-cols-2">
                <div
                  className={`p-5 sm:border-b-0 sm:border-r ${
                    isDarkMode
                      ? "border-b border-indigo-300/15 sm:border-r-indigo-300/15"
                      : "border-b border-slate-100"
                  }`}
                >
                  <p
                    className={`text-xs font-semibold uppercase tracking-wide ${
                      isDarkMode ? "text-indigo-200/80" : "text-slate-400"
                    }`}
                  >
                    Source Preview
                  </p>
                  <textarea
                    readOnly
                    value={inputText}
                    placeholder="Your source text preview appears here..."
                    aria-label="Source text preview"
                    className={`mt-3 h-72 w-full resize-none rounded-xl px-3 py-2 text-sm leading-6 outline-none ${
                      isDarkMode
                        ? "border border-indigo-300/20 bg-[#0b1030] text-slate-200"
                        : "border border-slate-200 bg-slate-50 text-slate-700"
                    }`}
                  />
                </div>
                <div className="p-5">
                  <p
                    className={`text-xs font-semibold uppercase tracking-wide ${
                      isDarkMode ? "text-indigo-200/80" : "text-slate-400"
                    }`}
                  >
                    Your Humanized Content
                  </p>
                  <textarea
                    readOnly
                    value={visibleOutputText}
                    placeholder="Your humanized text will appear here..."
                    aria-label="Humanized output"
                    className={`mt-3 h-72 w-full resize-none rounded-xl px-3 py-2 text-sm leading-6 outline-none ${
                      isDarkMode
                        ? "border border-indigo-300/20 bg-[#0b1030] text-slate-100"
                        : "border border-slate-200 bg-slate-50 text-slate-700"
                    }`}
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                        isDarkMode
                          ? "border border-indigo-300/25 bg-indigo-500/10 text-indigo-100"
                          : "border border-slate-200 bg-slate-50 text-slate-600"
                      }`}
                    >
                      Input: {countWords(inputText)} words
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                        isDarkMode
                          ? "border border-indigo-300/25 bg-indigo-500/10 text-indigo-100"
                          : "border border-slate-200 bg-slate-50 text-slate-600"
                      }`}
                    >
                      Output: {countWords(visibleOutputText)} words
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                        isDarkMode
                          ? "border border-indigo-300/25 bg-indigo-500/10 text-indigo-100"
                          : "border border-slate-200 bg-slate-50 text-slate-600"
                      }`}
                    >
                      Estimated changed words: {changedWordEstimate}
                    </span>
                  </div>
                  {(humanizeLoading || isStreamingOutput) && (
                    <p className={`mt-3 text-xs ${isDarkMode ? "text-indigo-200" : "text-blue-700"}`}>
                      {humanizeLoading
                        ? loadingSteps[loadingStepIndex]
                        : `Streaming ${streamingPhase === "draft" ? "draft" : "refined"} rewrite...`}
                    </p>
                  )}
                </div>
              </div>
              {showDiffPreview && outputText.trim() ? (
                <div className="px-5 pb-3 sm:px-6">
                  <div
                    className={`rounded-xl border p-3 text-xs ${
                      isDarkMode ? "border-indigo-300/20 bg-[#151b42]" : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className={`font-semibold ${isDarkMode ? "text-slate-100" : "text-slate-700"}`}>
                        Before vs after diff
                      </p>
                      <button
                        type="button"
                        onClick={() => setShowDiffPreview(false)}
                        className={`${isDarkMode ? "text-slate-300 hover:text-slate-100" : "text-slate-500 hover:text-slate-700"}`}
                      >
                        Hide
                      </button>
                    </div>
                    <p className={`leading-6 ${isDarkMode ? "text-slate-200" : "text-slate-700"}`}>
                      {diffPreview.segments.map((segment, index) => (
                        <span
                          key={`${segment.kind}-${index}`}
                          className={
                            segment.kind === "added"
                              ? isDarkMode
                                ? "rounded bg-emerald-500/20 px-0.5 text-emerald-200 transition-all"
                                : "rounded bg-emerald-100 px-0.5 text-emerald-700 transition-all"
                              : undefined
                          }
                        >
                          {segment.text}
                        </span>
                      ))}
                    </p>
                    {diffPreview.removedTokens.length > 0 && (
                      <p className={`mt-2 ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                        Removed tokens (sample): {diffPreview.removedTokens.slice(0, 12).join(", ")}
                        {diffPreview.removedTokens.length > 12 ? "..." : ""}
                      </p>
                    )}
                  </div>
                </div>
              ) : outputText.trim() ? (
                <div className="px-5 pb-3 text-right sm:px-6">
                  <button
                    type="button"
                    onClick={() => setShowDiffPreview(true)}
                    className={`text-xs font-medium ${
                      isDarkMode ? "text-indigo-200 hover:text-indigo-100" : "text-blue-700 hover:text-blue-600"
                    }`}
                  >
                    Show diff preview
                  </button>
                </div>
              ) : null}
              <p className={`px-5 pb-4 text-xs sm:px-6 ${isDarkMode ? "text-slate-300" : "text-slate-500"}`}>
                {requestMeta}
              </p>
              <div className="px-5 pb-5 sm:px-6">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSpeak}
                    disabled={!outputText.trim()}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                      isDarkMode
                        ? "border border-indigo-300/20 bg-[#151b42] text-slate-200 hover:bg-[#1a2250]"
                        : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    Read Aloud
                  </button>
                  <button
                    type="button"
                    onClick={handlePauseSpeech}
                    disabled={!isSpeaking}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                      isDarkMode
                        ? "border border-indigo-300/20 bg-[#151b42] text-slate-200 hover:bg-[#1a2250]"
                        : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {isPaused ? "Resume" : "Pause"}
                  </button>
                  <button
                    type="button"
                    onClick={handleStopSpeech}
                    disabled={!isSpeaking}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                      isDarkMode
                        ? "border border-indigo-300/20 bg-[#151b42] text-slate-200 hover:bg-[#1a2250]"
                        : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    Stop
                  </button>
                  <label className={`ml-auto inline-flex items-center gap-2 text-xs ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                    Speed
                    <input
                      type="range"
                      min={0.6}
                      max={1.4}
                      step={0.1}
                      value={speechRate}
                      onChange={(event) => setSpeechRate(Number(event.target.value))}
                    />
                  </label>
                </div>
              </div>
            </article>

            <div className={`grid gap-3 text-sm font-medium sm:grid-cols-3 ${isDarkMode ? "text-slate-200" : "text-slate-600"}`}>
              <div
                className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 shadow-sm ${
                  isDarkMode
                    ? "border border-indigo-300/20 bg-[#121737]/90"
                    : "border border-slate-200 bg-white"
                }`}
              >
                <ShieldCheck size={16} className="text-blue-600" />
                Enhanced Readability
              </div>
              <div
                className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 shadow-sm ${
                  isDarkMode
                    ? "border border-indigo-300/20 bg-[#121737]/90"
                    : "border border-slate-200 bg-white"
                }`}
              >
                <Sparkles size={16} className="text-pink-600" />
                Natural Tone
              </div>
              <div
                className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 shadow-sm ${
                  isDarkMode
                    ? "border border-indigo-300/20 bg-[#121737]/90"
                    : "border border-slate-200 bg-white"
                }`}
              >
                <HeartHandshake size={16} className="text-blue-600" />
                Human Touch
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: "Characters", value: charCount },
                { label: "Reading time", value: `${readingTimeMinutes} min` },
                { label: "Sentence complexity", value: `${avgSentenceLength || 0} w/sentence` },
                { label: "Lexical diversity", value: `${Math.round(lexicalDiversity)}%` },
              ].map((metric) => (
                <article
                  key={metric.label}
                  className={`rounded-2xl border px-4 py-3 ${
                    isDarkMode
                      ? "border-indigo-300/20 bg-[#121737]/90 text-slate-100"
                      : "border-slate-200 bg-white text-slate-700"
                  }`}
                >
                  <p className={`text-xs ${isDarkMode ? "text-slate-300" : "text-slate-500"}`}>{metric.label}</p>
                  <p className="mt-1 text-lg font-semibold">{metric.value}</p>
                </article>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <article
                className={`rounded-2xl border p-4 ${
                  isDarkMode
                    ? "border-indigo-300/20 bg-[#121737]/90 text-slate-100"
                    : "border-slate-200 bg-white text-slate-700"
                }`}
              >
                <h4 className="text-sm font-semibold">Explain Changes</h4>
                <ul className={`mt-3 space-y-2 text-sm ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                  {!hasOutput ? (
                    <>
                      <li className={isDarkMode ? "text-slate-400" : "text-slate-500"}>
                        Generate output to see writing improvements and change rationale.
                      </li>
                      <li className={isDarkMode ? "text-slate-500" : "text-slate-400"}>
                        - Word delta: --
                      </li>
                      <li className={isDarkMode ? "text-slate-500" : "text-slate-400"}>
                        - Readability delta: --
                      </li>
                    </>
                  ) : (
                    explainChanges.map((line) => <li key={line}>- {line}</li>)
                  )}
                </ul>
              </article>
              <article
                className={`rounded-2xl border p-4 ${
                  isDarkMode
                    ? "border-indigo-300/20 bg-[#121737]/90 text-slate-100"
                    : "border-slate-200 bg-white text-slate-700"
                }`}
              >
                <h4 className="text-sm font-semibold">Writing-style signals</h4>
                <div className="mt-3 space-y-2">
                  {styleSignals.map((signal) => (
                    <div key={signal.label}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className={isDarkMode ? "text-slate-300" : "text-slate-600"}>{signal.label}</span>
                        <span className={isDarkMode ? "text-slate-300" : "text-slate-600"}>
                          {typeof signal.value === "number" ? `${Math.round(signal.value)}%` : "--"}
                        </span>
                      </div>
                      <div className={`h-2 rounded-full ${isDarkMode ? "bg-indigo-950/60" : "bg-slate-100"}`}>
                        <div
                          className={`h-2 rounded-full ${
                            typeof signal.value === "number"
                              ? "bg-[linear-gradient(90deg,#4f46e5,#22d3ee,#f472b6)]"
                              : "bg-transparent"
                          }`}
                          style={{
                            width: `${
                              typeof signal.value === "number"
                                ? Math.max(0, Math.min(100, signal.value))
                                : 0
                            }%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            </div>

            <article
              className={`rounded-2xl border p-4 ${
                isDarkMode
                  ? "border-indigo-300/20 bg-[#121737]/90 text-slate-100"
                  : "border-slate-200 bg-white text-slate-700"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold">Authenticity signals</h4>
                  <p className={`mt-1 text-xs ${isDarkMode ? "text-slate-300" : "text-slate-500"}`}>
                    Probabilistic indicators only - not proof of authorship or misconduct.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAuthenticityPanel((prev) => !prev)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    isDarkMode
                      ? "border border-indigo-300/20 bg-[#151b42] text-slate-200 hover:bg-[#1a2250]"
                      : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {showAuthenticityPanel ? "Hide panel" : "Open panel"}
                </button>
              </div>

              {showAuthenticityPanel ? (
                <div className="mt-4 space-y-4">
                  <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                    <label className="text-xs">
                      <span className={`mb-1 block ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                        Privacy mode
                      </span>
                      <select
                        value={privacyMode}
                        onChange={(event) => setPrivacyMode(event.target.value as PrivacyMode)}
                        className={`w-full rounded-lg px-2 py-2 text-xs ${
                          isDarkMode
                            ? "border border-indigo-300/20 bg-[#0b1030] text-slate-100"
                            : "border border-slate-200 bg-slate-50 text-slate-700"
                        }`}
                      >
                        <option value="no_log">No log</option>
                        <option value="hash_only">Hash only</option>
                        <option value="full_text_opt_in">Full text (opt-in)</option>
                      </select>
                    </label>
                    <label
                      className={`inline-flex items-center gap-2 rounded-lg px-2 py-2 text-xs ${
                        isDarkMode ? "border border-indigo-300/20 bg-[#151b42]" : "border border-slate-200 bg-slate-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={detailsEnabled}
                        onChange={(event) => setDetailsEnabled(event.target.checked)}
                      />
                      Enable details
                    </label>
                    <label
                      className={`inline-flex items-center gap-2 rounded-lg px-2 py-2 text-xs ${
                        isDarkMode ? "border border-indigo-300/20 bg-[#151b42]" : "border border-slate-200 bg-slate-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={vendorConsent}
                        onChange={(event) => setVendorConsent(event.target.checked)}
                      />
                      Consent to vendor APIs
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleRunAuthenticityScan}
                        disabled={authenticityLoading}
                        className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
                      >
                        {authenticityLoading ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                        Analyze
                      </button>
                      <button
                        type="button"
                        onClick={handleDownloadAuthReport}
                        disabled={!authenticityData}
                        className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-50 ${
                          isDarkMode
                            ? "border border-indigo-300/20 bg-[#151b42] text-slate-200"
                            : "border border-slate-200 bg-slate-50 text-slate-600"
                        }`}
                      >
                        <FileDown size={14} />
                        Report JSON
                      </button>
                    </div>
                  </div>

                  {authenticityError ? (
                    <p
                      className={`rounded-lg px-3 py-2 text-xs ${
                        isDarkMode
                          ? "border border-red-400/25 bg-red-500/10 text-red-200"
                          : "border border-red-200 bg-red-50 text-red-600"
                      }`}
                    >
                      {authenticityError}
                    </p>
                  ) : null}

                  {authenticityData ? (
                    <div className="space-y-4">
                      <div
                        className={`rounded-xl px-3 py-2 text-xs ${
                          authenticityData.summary.riskBand === "high"
                            ? isDarkMode
                              ? "border border-amber-300/30 bg-amber-500/10 text-amber-100"
                              : "border border-amber-200 bg-amber-50 text-amber-700"
                            : authenticityData.summary.riskBand === "medium"
                              ? isDarkMode
                                ? "border border-blue-300/30 bg-blue-500/10 text-blue-100"
                                : "border border-blue-200 bg-blue-50 text-blue-700"
                              : isDarkMode
                                ? "border border-emerald-300/30 bg-emerald-500/10 text-emerald-100"
                                : "border border-emerald-200 bg-emerald-50 text-emerald-700"
                        }`}
                      >
                        <p className="font-semibold capitalize">
                          Risk band: {authenticityData.summary.riskBand} | Ensemble:{" "}
                          {Math.round(authenticityData.summary.ensembleScore)}%
                        </p>
                        <p className="mt-1">
                          {authenticityData.disclaimer} Disagreement:{" "}
                          {Math.round(authenticityData.summary.disagreement)}%.
                        </p>
                        {authenticityData.summary.disagreement >= 45 ? (
                          <p className="mt-1 inline-flex items-center gap-1 font-medium">
                            <AlertTriangle size={12} />
                            Detectors disagree noticeably. Treat this as inconclusive guidance.
                          </p>
                        ) : null}
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {authenticityData.detectors.map((detector) => (
                          <article
                            key={detector.id}
                            className={`rounded-xl border px-3 py-2 text-xs ${
                              isDarkMode
                                ? "border-indigo-300/20 bg-[#151b42]"
                                : "border-slate-200 bg-slate-50"
                            }`}
                          >
                            <p className="font-semibold">{detector.name}</p>
                            <p className={`mt-1 ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                              Status: {detector.status} | Label: {detector.label}
                            </p>
                            <p className={`mt-1 ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                              Confidence:{" "}
                              {typeof detector.confidence === "number"
                                ? `${Math.round(detector.confidence * 100)}%`
                                : "--"}{" "}
                              | Latency: {detector.latencyMs}ms
                            </p>
                          </article>
                        ))}
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        {[
                          {
                            key: "predictability",
                            label: "Predictability",
                            tooltip: "Higher can indicate repetitive next-token patterns.",
                            value: authenticityData.explainabilitySignals.predictability,
                          },
                          {
                            key: "variation",
                            label: "Variation",
                            tooltip: "Measures sentence-length and rhythm diversity.",
                            value: authenticityData.explainabilitySignals.variation,
                          },
                          {
                            key: "repetition",
                            label: "Repetition",
                            tooltip: "Captures recurring openers and phrase reuse.",
                            value: authenticityData.explainabilitySignals.repetition,
                          },
                          {
                            key: "domainMismatch",
                            label: "Domain mismatch risk",
                            tooltip: "Flags style mismatch for selected context mode.",
                            value: authenticityData.explainabilitySignals.domainMismatch,
                          },
                        ].map((signal) => (
                          <div key={signal.key}>
                            <div className="mb-1 flex items-center justify-between text-xs">
                              <span title={signal.tooltip} className="inline-flex items-center gap-1 font-medium">
                                {signal.label}
                                <Info size={12} />
                              </span>
                              <span>{Math.round(signal.value)}%</span>
                            </div>
                            <div className={`h-2 rounded-full ${isDarkMode ? "bg-indigo-950/60" : "bg-slate-100"}`}>
                              <div
                                className="h-2 rounded-full bg-[linear-gradient(90deg,#4f46e5,#22d3ee,#f472b6)]"
                                style={{ width: `${Math.max(0, Math.min(100, signal.value))}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>

                      {detailsEnabled ? (
                        authenticityData.reducedDetail ? (
                          <p className={`text-xs ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                            Detail view is temporarily reduced due to repeated near-identical rescans.
                          </p>
                        ) : (
                          <div>
                            <p className="text-xs font-semibold">Sentence highlights</p>
                            <div className="mt-2 space-y-2">
                              {authenticityData.sentenceHighlights.length === 0 ? (
                                <p className={`text-xs ${isDarkMode ? "text-slate-400" : "text-slate-500"}`}>
                                  No high-risk sentence patterns flagged for this scan.
                                </p>
                              ) : (
                                authenticityData.sentenceHighlights.map((item, index) => (
                                  <p
                                    key={`${item.reason}-${index}`}
                                    className={`rounded-lg px-2 py-1.5 text-xs ${
                                      isDarkMode
                                        ? "border border-indigo-300/20 bg-[#151b42] text-slate-200"
                                        : "border border-slate-200 bg-slate-50 text-slate-600"
                                    }`}
                                  >
                                    <span className="font-semibold">Risk {Math.round(item.risk)}%</span> - {item.reason}
                                  </p>
                                ))
                              )}
                            </div>
                          </div>
                        )
                      ) : null}

                      <div
                        className={`rounded-xl px-3 py-2 text-xs ${
                          isDarkMode
                            ? "border border-indigo-300/20 bg-[#151b42] text-slate-300"
                            : "border border-slate-200 bg-slate-50 text-slate-600"
                        }`}
                      >
                        <p className="font-semibold">Authorship evidence (stub)</p>
                        <p className="mt-1">
                          If writing-session telemetry is enabled in a future release, export can include typing session
                          metadata. Current export contains scan metadata and disclaimers only.
                        </p>
                      </div>
                    </div>
                  ) : null}

                  <div className={`rounded-xl px-3 py-2 text-xs ${isDarkMode ? "bg-[#151b42]/70 text-slate-300" : "bg-slate-50 text-slate-600"}`}>
                    <p className="inline-flex items-center gap-1 font-medium">
                      <Lock size={12} />
                      Privacy default: hash/metrics logging only unless full-text opt-in is enabled.
                    </p>
                  </div>
                </div>
              ) : null}
            </article>

            <article
              className={`rounded-2xl border px-4 py-3 text-sm ${
                isDarkMode
                  ? "border-indigo-300/20 bg-[#121737]/90 text-slate-300"
                  : "border-slate-200 bg-white text-slate-600"
              }`}
            >
              Your text is processed per request through your configured provider. Review and edit outputs before final use.
            </article>

          </section>
        )}
      </div>
      {session && isProfileWindowOpen ? (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm ${
            isDarkMode ? "bg-slate-950/65" : "bg-slate-950/35"
          }`}
        >
          <div
            className={`max-h-[90vh] w-full max-w-6xl overflow-y-auto rounded-3xl p-4 shadow-2xl sm:p-5 ${
              isDarkMode
                ? "border border-indigo-300/20 bg-[#0f1433]"
                : "border border-slate-200 bg-[#edf2fa]"
            }`}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className={`text-lg font-semibold ${isDarkMode ? "text-slate-100" : "text-slate-800"}`}>
                Profile Window
              </h2>
              <button
                type="button"
                onClick={() => setIsProfileWindowOpen(false)}
                className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm ${
                  isDarkMode
                    ? "border border-indigo-300/20 bg-[#151b42] text-slate-200 hover:bg-[#1a2250]"
                    : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                <X size={15} />
                Close
              </button>
            </div>
            <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
              <article
                className={`rounded-3xl p-5 shadow-sm ${
                  isDarkMode
                    ? "border border-indigo-300/20 bg-[#121737]"
                    : "border border-slate-200 bg-white"
                }`}
              >
                <div className="mb-4 flex items-center gap-2">
                  <User size={16} className="text-blue-600" />
                  <h2
                    className={`text-lg font-semibold tracking-tight ${
                      isDarkMode ? "text-slate-100" : "text-slate-800"
                    }`}
                  >
                    Profile details
                  </h2>
                </div>
                <form className="space-y-3" onSubmit={handleSaveProfile}>
                  <label className={`block text-xs ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                    Display name
                    <input
                      value={profileForm.display_name}
                      onChange={(event) =>
                        setProfileForm((prev) => ({ ...prev, display_name: event.target.value }))
                      }
                      className={`mt-1 w-full rounded-xl px-3 py-2 text-sm outline-none ring-blue-300 focus:ring-2 ${
                        isDarkMode
                          ? "border border-indigo-300/20 bg-[#0b1030] text-slate-100"
                          : "border border-slate-200 bg-slate-50"
                      }`}
                      placeholder="How should we address you?"
                    />
                  </label>
                  <label className={`block text-xs ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                    Full name
                    <input
                      value={profileForm.full_name}
                      onChange={(event) =>
                        setProfileForm((prev) => ({ ...prev, full_name: event.target.value }))
                      }
                      className={`mt-1 w-full rounded-xl px-3 py-2 text-sm outline-none ring-blue-300 focus:ring-2 ${
                        isDarkMode
                          ? "border border-indigo-300/20 bg-[#0b1030] text-slate-100"
                          : "border border-slate-200 bg-slate-50"
                      }`}
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className={`block text-xs ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                      Role
                      <input
                        value={profileForm.role_title}
                        onChange={(event) =>
                          setProfileForm((prev) => ({ ...prev, role_title: event.target.value }))
                        }
                        className={`mt-1 w-full rounded-xl px-3 py-2 text-sm outline-none ring-blue-300 focus:ring-2 ${
                          isDarkMode
                            ? "border border-indigo-300/20 bg-[#0b1030] text-slate-100"
                            : "border border-slate-200 bg-slate-50"
                        }`}
                      />
                    </label>
                    <label className={`block text-xs ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                      Company
                      <input
                        value={profileForm.company}
                        onChange={(event) =>
                          setProfileForm((prev) => ({ ...prev, company: event.target.value }))
                        }
                        className={`mt-1 w-full rounded-xl px-3 py-2 text-sm outline-none ring-blue-300 focus:ring-2 ${
                          isDarkMode
                            ? "border border-indigo-300/20 bg-[#0b1030] text-slate-100"
                            : "border border-slate-200 bg-slate-50"
                        }`}
                      />
                    </label>
                  </div>
                  <label className={`block text-xs ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                    Website
                    <input
                      value={profileForm.website}
                      onChange={(event) =>
                        setProfileForm((prev) => ({ ...prev, website: event.target.value }))
                      }
                      className={`mt-1 w-full rounded-xl px-3 py-2 text-sm outline-none ring-blue-300 focus:ring-2 ${
                        isDarkMode
                          ? "border border-indigo-300/20 bg-[#0b1030] text-slate-100"
                          : "border border-slate-200 bg-slate-50"
                      }`}
                      placeholder="https://..."
                    />
                  </label>
                  <label className={`block text-xs ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
                    Bio
                    <textarea
                      value={profileForm.bio}
                      onChange={(event) =>
                        setProfileForm((prev) => ({ ...prev, bio: event.target.value }))
                      }
                      className={`mt-1 h-20 w-full resize-none rounded-xl px-3 py-2 text-sm outline-none ring-blue-300 focus:ring-2 ${
                        isDarkMode
                          ? "border border-indigo-300/20 bg-[#0b1030] text-slate-100"
                          : "border border-slate-200 bg-slate-50"
                      }`}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={profileSaving || profileLoading}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {profileSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                    Save profile
                  </button>
                  {profileMessage ? (
                    <p
                      className={`rounded-lg px-3 py-2 text-xs ${
                        isDarkMode
                          ? "border border-indigo-300/20 bg-[#151b42] text-slate-200"
                          : "border border-slate-200 bg-slate-50 text-slate-600"
                      }`}
                    >
                      {profileMessage}
                    </p>
                  ) : null}
                </form>
              </article>

              <article
                className={`rounded-3xl p-5 shadow-sm ${
                  isDarkMode
                    ? "border border-indigo-300/20 bg-[#121737]"
                    : "border border-slate-200 bg-white"
                }`}
              >
                <div className="mb-3 flex items-center justify-between">
                  <h2
                    className={`text-lg font-semibold tracking-tight ${
                      isDarkMode ? "text-slate-100" : "text-slate-800"
                    }`}
                  >
                    Recent rewrites
                  </h2>
                  <div className="flex items-center gap-2">
                    {historyLoading ? (
                      <Loader2 className="animate-spin text-slate-400" size={15} />
                    ) : (
                      <span className="text-xs text-slate-400">{historyItems.length} items</span>
                    )}
                    <button
                      type="button"
                      onClick={handleClearHistoryPermanently}
                      disabled={historyItems.length === 0 || historyClearing}
                      className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                        isDarkMode
                          ? "border border-red-400/25 bg-red-500/10 text-red-200 hover:bg-red-500/15"
                          : "border border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                      }`}
                    >
                      {historyClearing ? "Clearing..." : "Clear all permanently"}
                    </button>
                  </div>
                </div>
                {historyMessage ? (
                  <p
                    className={`mb-3 rounded-lg px-3 py-2 text-xs ${
                      isDarkMode
                        ? "border border-indigo-300/20 bg-[#151b42] text-slate-200"
                        : "border border-slate-200 bg-slate-50 text-slate-600"
                    }`}
                  >
                    {historyMessage}
                  </p>
                ) : null}
                <div className="max-h-[380px] space-y-3 overflow-y-auto pr-1">
                  {historyItems.length === 0 ? (
                    <p
                      className={`rounded-xl px-3 py-2 text-xs ${
                        isDarkMode
                          ? "border border-indigo-300/20 bg-[#151b42] text-slate-300"
                          : "border border-slate-200 bg-slate-50 text-slate-500"
                      }`}
                    >
                      No history yet. Generate your first rewrite.
                    </p>
                  ) : (
                    historyItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setInputText(item.input_text);
                          setOutputText(item.output_text);
                          setStreamedOutputText(item.output_text);
                          setIsStreamingOutput(false);
                          setStreamingPhase(null);
                          setQualityScore(item.quality_score);
                          setRequestMeta(
                            `Loaded saved rewrite. ${item.output_word_count} words.`,
                          );
                        }}
                        className={`w-full rounded-xl p-3 text-left transition ${
                          isDarkMode
                            ? "border border-indigo-300/20 bg-[#151b42] hover:border-indigo-300/45 hover:bg-[#1a2250]"
                            : "border border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/40"
                        }`}
                      >
                        <p className={`line-clamp-2 text-xs ${isDarkMode ? "text-slate-200" : "text-slate-600"}`}>
                          {item.input_text}
                        </p>
                        <p className={`mt-2 text-[11px] ${isDarkMode ? "text-slate-400" : "text-slate-400"}`}>
                          {new Date(item.created_at).toLocaleString()} | {item.model}
                        </p>
                      </button>
                    ))
                  )}
                </div>
              </article>
            </div>
          </div>
        </div>
      ) : null}
      {showIntegrityModal ? (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm ${
            isDarkMode ? "bg-slate-950/65" : "bg-slate-950/35"
          }`}
        >
          <div
            className={`w-full max-w-xl rounded-2xl p-5 ${
              isDarkMode ? "border border-indigo-300/20 bg-[#0f1433]" : "border border-slate-200 bg-white"
            }`}
          >
            <h3 className={`text-lg font-semibold ${isDarkMode ? "text-slate-100" : "text-slate-800"}`}>
              Policy & Integrity (Academic mode)
            </h3>
            <p className={`mt-2 text-sm ${isDarkMode ? "text-slate-300" : "text-slate-600"}`}>
              Use these signals to support transparent review, not to evade policies. Always follow institutional
              authorship guidelines, cite sources accurately, and disclose AI assistance where required.
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setShowIntegrityModal(false)}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  isDarkMode
                    ? "border border-indigo-300/20 bg-[#151b42] text-slate-200 hover:bg-[#1a2250]"
                    : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                }`}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {isCommandPaletteOpen ? (
        <div
          className={`fixed inset-0 z-50 flex items-start justify-center p-4 pt-24 backdrop-blur-sm ${
            isDarkMode ? "bg-slate-950/65" : "bg-slate-950/35"
          }`}
          onClick={() => setIsCommandPaletteOpen(false)}
        >
          <div
            className={`w-full max-w-2xl rounded-2xl border p-4 ${
              isDarkMode ? "border-indigo-300/20 bg-[#0f1433]" : "border-slate-200 bg-white"
            }`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-2">
              <Command size={16} className={isDarkMode ? "text-indigo-200" : "text-blue-700"} />
              <p className={`text-sm font-semibold ${isDarkMode ? "text-slate-100" : "text-slate-800"}`}>
                Command palette
              </p>
            </div>
            <input
              autoFocus
              value={commandQuery}
              onChange={(event) => setCommandQuery(event.target.value)}
              placeholder="Search actions..."
              className={`w-full rounded-xl px-3 py-2 text-sm outline-none ring-indigo-300 focus:ring-2 ${
                isDarkMode
                  ? "border border-indigo-300/20 bg-[#0b1030] text-slate-100"
                  : "border border-slate-200 bg-slate-50 text-slate-700"
              }`}
            />
            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
              {filteredCommandActions.length === 0 ? (
                <p className={`text-xs ${isDarkMode ? "text-slate-400" : "text-slate-500"}`}>
                  No matching actions.
                </p>
              ) : (
                filteredCommandActions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    onClick={() => {
                      action.run();
                      setIsCommandPaletteOpen(false);
                      setCommandQuery("");
                    }}
                    className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm transition ${
                      isDarkMode
                        ? "border-indigo-300/20 bg-[#151b42] text-slate-100 hover:bg-[#1a2250]"
                        : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    <span>{action.label}</span>
                    <Check size={14} className={isDarkMode ? "text-indigo-200" : "text-blue-600"} />
                  </button>
                ))
              )}
            </div>
            <p className={`mt-3 text-[11px] ${isDarkMode ? "text-slate-400" : "text-slate-500"}`}>
              Tip: press Ctrl/Cmd + K to open, Esc to close.
            </p>
          </div>
        </div>
      ) : null}
    </main>
  );
}
