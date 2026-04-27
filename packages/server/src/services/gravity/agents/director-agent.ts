/**
 * director-agent.ts — Gravity Ledger post-processing director agent.
 *
 * After the prose model generates a response, this agent:
 * 1. Calls the director LLM to propose ledger transactions.
 * 2. Validates and stages them in a single SQL transaction.
 * 3. Runs the engine tick (advance turns only).
 * 4. Updates the state cache for the new swipe.
 * 5. Records pending corrections for any rejected transactions.
 *
 * Runs as a post_processing agent (gravity-ledger-director).
 */

import type { DB } from "../../../db/connection.ts";
import { eq } from "drizzle-orm";
import { gravityChatState } from "../../../db/schema/index.ts";
import { createLedgerStore } from "../engine/ledger-store.ts";
import { createStateCacheStore } from "../engine/state-cache.ts";
import { validateFormat, validateTransitions } from "../engine/consistency.ts";
import { computeState } from "../engine/state-compute.ts";
import { engineTick } from "../engine/engine-tick.ts";
import { buildDirectorInput } from "../director/input.ts";
import { callDirector } from "../director/client.ts";
import type { CorrectionsPayload, CorrectionEntry } from "../director/input.ts";
import type { RawTransaction, TurnMode } from "../engine/types.ts";
import type { BaseLLMProvider } from "../../llm/base-provider.ts";
import type { AgentContext } from "@marinara-engine/shared";
import type { AgentExecConfig } from "../../agents/agent-executor.ts";
import { logger } from "../../../lib/logger.ts";

export interface GravityDirectorInput {
  chatId: string;
  messageId: string;
  swipeIndex: number;
  assistantMessage: string;
  agentConfig: AgentExecConfig;
  context: AgentContext;
  provider: BaseLLMProvider;
  model: string;
  signal: AbortSignal;
}

export interface GravityDirectorResult {
  agentId: string;
  agentType: "gravity-ledger-director";
  type: "gravity_state_update";
  data: {
    committed: number;
    rejected: number;
    errors: Record<string, unknown>;
    newArrivalIds: string[];
    durationMs: number;
    model: string;
  };
  tokensUsed: number;
  durationMs: number;
  success: boolean;
  error: string | null;
}

export function createDirectorAgent(db: DB) {
  const ledgerStore = createLedgerStore(db);
  const stateCacheStore = createStateCacheStore(db);

  return {
    async runGravityDirector(input: GravityDirectorInput): Promise<GravityDirectorResult> {
      const t0 = Date.now();
      const { chatId, messageId, swipeIndex, assistantMessage, agentConfig, context, provider, model, signal } = input;

      // ── 1. Resolve prompt template ───────────────────────────────────────────
      const promptTemplate = agentConfig.promptTemplate || undefined;

      // ── 2. Load shared state ─────────────────────────────────────────────────
      const [chatState] = await db
        .select()
        .from(gravityChatState)
        .where(eq(gravityChatState.chatId, chatId))
        .limit(1);
      const mode = (chatState?.mode ?? "regular") as TurnMode;
      const pendingCorrections = chatState?.pendingCorrections
        ? (JSON.parse(chatState.pendingCorrections) as CorrectionsPayload)
        : null;

      // ── Fix 2: honour runInterval ────────────────────────────────────────────
      // Only fire the director every N accepted turns (default 1 = every turn).
      const runInterval = (agentConfig.settings.runInterval as number | undefined) ?? 1;
      const turnsSince = chatState?.userTurnsSinceLastDirector ?? 0;
      // commitAcceptedGravityTurn already incremented the counter before the
      // director fires, so compare directly (no +1).
      if (runInterval > 1 && turnsSince < runInterval) {
        logger.debug(
          "[gravity-director] skipping turn %d/%d for chat %s",
          turnsSince,
          runInterval,
          chatId,
        );
        return makeSkipped(agentConfig, t0);
      }

      // ── 3. Load last-accepted state-cache ────────────────────────────────────
      const cache = await stateCacheStore.getAcceptedCache(chatId);
      const stateView = cache?.stateView ?? "";
      const recentTail = cache?.recentTail ?? "[]";

      // ── 4. Build director input ──────────────────────────────────────────────
      const directorInput = buildDirectorInput({
        mode,
        assistantMessage,
        stateView,
        recentTail,
        pendingCorrections,
        chatSummary: context.chatSummary ?? null,
        activatedLorebookTitles: context.activatedLorebookEntries?.map((e) => e.name) ?? [],
      });

      // ── 5. LLM call ──────────────────────────────────────────────────────────
      let proposal;
      try {
        proposal = await callDirector(directorInput, provider, model, promptTemplate, signal);
      } catch (err) {
        logger.error(err, "[gravity-director] LLM call failed for chat %s", chatId);
        return makeError(agentConfig, "LLM call failed", t0);
      }

      // ── Steps 6–9: single SQL transaction ───────────────────────────────────
      let committed = 0;
      let rejected = 0;
      let newArrivalIds: string[] = [];
      const allErrors: Record<string, unknown> = {};

      try {
        await db.transaction(async (tx) => {
          // 6. Validate format per-transaction, build format-valid list
          const formatValid: RawTransaction[] = [];
          for (let i = 0; i < proposal.transactions.length; i++) {
            const errs = validateFormat(proposal.transactions[i] as unknown, i);
            if (errs.length === 0) {
              formatValid.push(proposal.transactions[i] as RawTransaction);
            } else {
              allErrors[String(i)] = errs;
              rejected++;
            }
          }

          // Validate state-machine transitions against current accepted state
          const acceptedTxns = await ledgerStore.getAcceptedTransactions(chatId);
          const currentState = computeState(null, acceptedTxns);
          const { valid: validAfterTransitions, errors: transitionErrors } = validateTransitions(
            formatValid,
            currentState,
          );
          for (const e of transitionErrors) {
            allErrors[String(e.lineNum)] = e;
          }
          rejected += formatValid.length - validAfterTransitions.length;

          const txDb = tx as unknown as DB;
          await ledgerStore.stageTransactions(txDb, chatId, messageId, swipeIndex, validAfterTransitions);
          committed = validAfterTransitions.length;

          // 7. Engine tick
          const stagedState = computeState(null, [...acceptedTxns, ...validAfterTransitions]);
          const tickResult = engineTick(stagedState, mode);
          newArrivalIds = tickResult.newArrivalIds;
          if (tickResult.tickTxns.length > 0) {
            await ledgerStore.stageTransactions(txDb, chatId, messageId, swipeIndex, tickResult.tickTxns);
          }

          // 8. Update state cache for this swipe
          const allStagedTxns = [...acceptedTxns, ...validAfterTransitions, ...tickResult.tickTxns];
          const finalState = computeState(null, allStagedTxns);
          await stateCacheStore.upsertForSwipe(txDb, chatId, messageId, swipeIndex, finalState, allStagedTxns, mode);

          // 9. Upsert gravity_chat_state
          const newCorrections = buildNewCorrections(allErrors, proposal.transactions, pendingCorrections);
          await txDb
            .update(gravityChatState)
            .set({
              pendingCorrections: newCorrections ? JSON.stringify(newCorrections) : null,
              userTurnsSinceLastDirector: 0,
            })
            .where(eq(gravityChatState.chatId, chatId));
        });
      } catch (err) {
        logger.error(err, "[gravity-director] transaction failed for chat %s", chatId);
        return makeError(agentConfig, "DB transaction failed", t0);
      }

      const durationMs = Date.now() - t0;
      logger.info(
        "[gravity-director] chat=%s committed=%d rejected=%d arrivals=%d model=%s dur=%dms",
        chatId,
        committed,
        rejected,
        newArrivalIds.length,
        model,
        durationMs,
      );

      return {
        agentId: agentConfig.id,
        agentType: "gravity-ledger-director",
        type: "gravity_state_update",
        data: { committed, rejected, errors: allErrors, newArrivalIds, durationMs, model },
        tokensUsed: 0,
        durationMs,
        success: true,
        error: null,
      };
    },
  };
}

function makeSkipped(agentConfig: AgentExecConfig, t0: number): GravityDirectorResult {
  return {
    agentId: agentConfig.id,
    agentType: "gravity-ledger-director",
    type: "gravity_state_update",
    data: { committed: 0, rejected: 0, errors: {}, newArrivalIds: [], durationMs: Date.now() - t0, model: "" },
    tokensUsed: 0,
    durationMs: Date.now() - t0,
    success: true,
    error: null,
  };
}

function makeError(agentConfig: AgentExecConfig, message: string, t0: number): GravityDirectorResult {
  return {
    agentId: agentConfig.id,
    agentType: "gravity-ledger-director",
    type: "gravity_state_update",
    data: { committed: 0, rejected: 0, errors: {}, newArrivalIds: [], durationMs: Date.now() - t0, model: "" },
    tokensUsed: 0,
    durationMs: Date.now() - t0,
    success: false,
    error: message,
  };
}

function buildNewCorrections(
  errors: Record<string, unknown>,
  allTxns: unknown[],
  existing: CorrectionsPayload | null,
): CorrectionsPayload | null {
  const MAX = 3;
  const entries: CorrectionEntry[] = [];
  for (const [idx, errs] of Object.entries(errors)) {
    const i = Number(idx);
    const prev = existing?.entries.find((e) => e.txId === String(i));
    const attempt = (prev?.attempt ?? 0) + 1;
    if (attempt > MAX) continue;
    entries.push({
      txId: String(i),
      rejectedTx: allTxns[i],
      reason: JSON.stringify(errs),
      attempt,
    });
  }
  if (entries.length === 0) return null;
  return { entries, generatedAt: Math.floor(Date.now() / 1000) };
}
