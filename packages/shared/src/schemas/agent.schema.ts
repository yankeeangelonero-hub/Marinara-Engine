// ──────────────────────────────────────────────
// Agent Zod Schemas
// ──────────────────────────────────────────────
import { z } from "zod";

export const agentPhaseSchema = z.enum(["pre_generation", "parallel", "post_processing"]);

export const agentResultTypeSchema = z.enum([
  "game_state_update",
  "text_rewrite",
  "sprite_change",
  "echo_message",
  "quest_update",
  "image_prompt",
  "context_injection",
  "continuity_check",
  "director_event",
  "lorebook_update",
  "character_card_update",
  "prompt_review",
  "background_change",
  "character_tracker_update",
  "persona_stats_update",
  "chat_summary",
  "spotify_control",
  "secret_plot",
  "thread_weaver_update",
]);

export const createAgentConfigSchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().default(""),
  phase: agentPhaseSchema,
  enabled: z.boolean().default(true),
  connectionId: z.string().nullable().default(null),
  promptTemplate: z.string().default(""),
  settings: z.record(z.unknown()).default({}),
});

export const updateAgentConfigSchema = createAgentConfigSchema.partial();

export type CreateAgentConfigInput = z.infer<typeof createAgentConfigSchema>;
export type UpdateAgentConfigInput = z.infer<typeof updateAgentConfigSchema>;
