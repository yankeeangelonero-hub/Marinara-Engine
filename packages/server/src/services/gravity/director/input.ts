/**
 * input.ts — Director input builder.
 *
 * Assembles the structured input for the director LLM call from the
 * current state cache, pending corrections, and conversation context.
 */

import type { TurnMode } from "../engine/types.ts";

export const MAX_CORRECTION_ATTEMPTS = 3;

export interface CorrectionEntry {
  txId: string;
  rejectedTx: unknown;
  reason: string;
  attempt: number;
}

export interface CorrectionsPayload {
  entries: CorrectionEntry[];
  generatedAt: number;
}

export interface DirectorInput {
  mode: TurnMode;
  assistantMessage: string;
  stateView: string;
  recentTail: string;
  pendingCorrections: CorrectionsPayload | null;
  chatSummary: string | null;
  activatedLorebookTitles: string[];
}

export function buildDirectorInput(params: {
  mode: TurnMode;
  assistantMessage: string;
  stateView: string;
  recentTail: string;
  pendingCorrections: CorrectionsPayload | null;
  chatSummary?: string | null;
  activatedLorebookTitles?: string[];
}): DirectorInput {
  return {
    mode: params.mode,
    assistantMessage: params.assistantMessage,
    stateView: params.stateView,
    recentTail: params.recentTail,
    pendingCorrections: params.pendingCorrections,
    chatSummary: params.chatSummary ?? null,
    activatedLorebookTitles: params.activatedLorebookTitles ?? [],
  };
}

export function renderDirectorUserPrompt(input: DirectorInput): string {
  const parts: string[] = [];
  parts.push(`MODE: ${input.mode}`);
  parts.push(`\n---PROSE---\n${input.assistantMessage}\n---END PROSE---`);
  parts.push(`\n---STATE---\n${input.stateView}\n---END STATE---`);
  if (input.recentTail) parts.push(`\n---RECENT TX---\n${input.recentTail}\n---END RECENT TX---`);
  if (input.pendingCorrections?.entries.length) {
    parts.push(
      `\n---CORRECTIONS NEEDED---\n${JSON.stringify(input.pendingCorrections.entries, null, 2)}\n---END CORRECTIONS---`,
    );
  }
  if (input.chatSummary) parts.push(`\n---SUMMARY---\n${input.chatSummary}\n---END SUMMARY---`);
  if (input.activatedLorebookTitles.length) {
    parts.push(`\nActive lore: ${input.activatedLorebookTitles.join(", ")}`);
  }
  return parts.join("\n");
}
