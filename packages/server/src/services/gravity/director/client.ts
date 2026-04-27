/**
 * client.ts — Director LLM client.
 *
 * Wraps the BaseLLMProvider call to the director model, handles JSON extraction
 * from the response, and returns a typed DirectorProposal.
 */

import type { BaseLLMProvider, ChatMessage } from "../../llm/base-provider.ts";
import { buildDirectorSystemPrompt } from "./prompt.ts";
import { renderDirectorUserPrompt } from "./input.ts";
import type { DirectorInput } from "./input.ts";
import { logger } from "../../../lib/logger.ts";

export interface DirectorProposal {
  transactions: unknown[];
  notes: string;
  confidence: "high" | "medium" | "low";
  model: string;
  durationMs: number;
}

/** Extract JSON from a response that may have markdown fences or leading prose. */
function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

export async function callDirector(
  input: DirectorInput,
  provider: BaseLLMProvider,
  model: string,
  promptTemplate: string | undefined,
  signal: AbortSignal,
): Promise<DirectorProposal> {
  const t0 = Date.now();
  const systemPrompt = buildDirectorSystemPrompt(promptTemplate);
  const userPrompt = renderDirectorUserPrompt(input);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  logger.debug(
    "[gravity-director] calling model %s (%d chars system, %d chars user)",
    model,
    systemPrompt.length,
    userPrompt.length,
  );

  const result = await provider.chatComplete(messages, {
    model,
    temperature: 0.3,
    // Director JSON output is rarely over 800 tokens; 1500 is a safe ceiling.
    // Lowering this reduces reserved capacity on hosted APIs and speeds scheduling.
    maxTokens: 1500,
    stream: false,
    responseFormat: { type: "json_object" },
    signal,
  });

  const raw = result.content?.trim() ?? "";
  const durationMs = Date.now() - t0;

  let parsed: { transactions?: unknown[]; notes?: string; confidence?: string };
  try {
    parsed = JSON.parse(extractJson(raw)) as { transactions?: unknown[]; notes?: string; confidence?: string };
  } catch {
    logger.warn("[gravity-director] JSON parse failed, raw=%s", raw.slice(0, 200));
    parsed = { transactions: [], notes: "parse error", confidence: "low" };
  }

  return {
    transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
    confidence: (parsed.confidence as "high" | "medium" | "low") ?? "low",
    model,
    durationMs,
  };
}
