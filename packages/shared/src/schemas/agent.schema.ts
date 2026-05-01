// ──────────────────────────────────────────────
// Agent Zod Schemas
// ──────────────────────────────────────────────
import { z } from "zod";

export const agentPhaseSchema = z.enum(["pre_generation", "parallel", "post_processing"]);

// NOTE: this enum is intentionally a subset of the AgentResultType union — entries
// like `custom_tracker_update`, `haptic_command`, `cyoa_choices`, and the game-mode
// result types are not yet mirrored here. If you add a new entry, also confirm
// whether it needs to be present in the union in `types/agent.ts`. Tracking the
// drift is out of scope for the Thread Weaver work; see project tech-debt.
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
