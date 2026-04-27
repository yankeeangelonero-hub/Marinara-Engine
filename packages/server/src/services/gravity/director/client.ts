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

/**
 * Strip visible reasoning blocks emitted by models like DeepSeek R1 / Qwen.
 * These appear as <think>…</think> or <thinking>…</thinking> before the JSON
 * and add significant latency without contributing useful output.
 */
function stripThinkingBlocks(text: string): string {
  return text.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, "").trim();
}

/** Extract JSON from a response that may have markdown fences or leading prose. */
function extractJson(text: string): string {
  const stripped = stripThinkingBlocks(text);
  const fenceMatch = stripped.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start !== -1 && end > start) return stripped.slice(start, end + 1);
  return stripped;
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

  // Log output size and whether a thinking block was present — this is the
  // primary diagnostic for "director is slow": if thinkingChars >> jsonChars,
  // the model is spending most of its time reasoning before emitting JSON.
  // Switch to a non-reasoning model (Haiku, 4o-mini, Flash) to fix it.
  const thinkMatch = raw.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
  const thinkingChars = thinkMatch ? thinkMatch[0].length : 0;
  const jsonChars = raw.length - thinkingChars;
  logger.info(
    "[gravity-director] raw response: %d chars total, %d thinking, %d json, %dms model=%s",
    raw.length,
    thinkingChars,
    jsonChars,
    durationMs,
    model,
  );

  let parsed: { transactions?: unknown[]; notes?: string; confidence?: string };
  try {
    parsed = JSON.parse(extractJson(raw)) as { transactions?: unknown[]; notes?: string; confidence?: string };
  } catch {
    logger.warn("[gravity-director] JSON parse failed, raw=%s", raw.slice(0, 300));
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
