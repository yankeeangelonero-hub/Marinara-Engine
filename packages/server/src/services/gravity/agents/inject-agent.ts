/**
 * inject-agent.ts — Gravity Ledger pre-generation inject agent.
 *
 * Reads the last-accepted state cache and returns the formatted state view
 * + mode nudge for injection into the generation context. Runs as a
 * pre_generation agent (gravity-ledger-inject).
 */

import { eq } from "drizzle-orm";
import type { DB } from "../../../db/connection.ts";
import { gravityChatState } from "../../../db/schema/index.ts";
import { createStateCacheStore } from "../engine/state-cache.ts";
import { createLedgerStore } from "../engine/ledger-store.ts";
import { computeState } from "../engine/state-compute.ts";
import { buildNudge } from "../engine/state-view.ts";
import type { TurnMode } from "../engine/types.ts";
import { logger } from "../../../lib/logger.ts";

export interface GravityInjectResult {
  text: string;
  archiveVersion: string;
  mode: TurnMode;
}

export function createInjectAgent(db: DB) {
  const stateCacheStore = createStateCacheStore(db);
  const ledgerStore = createLedgerStore(db);

  return {
    async loadGravityInjectForChat(chatId: string): Promise<GravityInjectResult | null> {
      const [chatState] = await db
        .select()
        .from(gravityChatState)
        .where(eq(gravityChatState.chatId, chatId))
        .limit(1);

      if (!chatState) {
        logger.debug("[gravity-inject] no chat state for chat %s — chat not initialized", chatId);
        return null;
      }

      if (!chatState.acceptedMessageId) {
        logger.debug("[gravity-inject] no accepted turn yet for chat %s", chatId);
        return null;
      }

      const cache = await stateCacheStore.getAcceptedCache(chatId);
      if (!cache) {
        logger.warn("[gravity-inject] state-cache missing for chat %s — state-cache rebuild needed", chatId);
        return null;
      }

      const mode = chatState.mode as TurnMode;

      // Rebuild state from accepted transactions to pass to buildNudge
      const acceptedTxns = await ledgerStore.getAcceptedTransactions(chatId);
      const state = computeState(null, acceptedTxns);
      const nudge = buildNudge(mode, state);
      const text = `${cache.stateView}\n\n${nudge}`;

      return { text, archiveVersion: cache.archiveVersion, mode };
    },
  };
}
