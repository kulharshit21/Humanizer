import { z } from "zod";

export const detectRequestSchema = z.object({
  text: z.string().min(1, "Text is required.").max(15000, "Text is too long."),
  context: z
    .object({
      language: z.string().optional(),
      mode: z.enum(["general", "academic", "publishing"]).optional(),
    })
    .optional(),
  privacy_mode: z.enum(["no_log", "hash_only", "full_text_opt_in"]),
  vendor_consent: z.boolean().optional(),
  details_enabled: z.boolean().optional(),
});

export type DetectRequestInput = z.infer<typeof detectRequestSchema>;

