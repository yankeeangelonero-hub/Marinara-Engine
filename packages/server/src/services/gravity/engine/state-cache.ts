/**
 * state-cache.ts — DB-backed state cache read/write.
 *
 * The state cache stores the rendered state view, recent transaction tail,
 * and archive version fingerprint for each (chatId, messageId, swipeIndex)
 * triple. The inject agent reads from the accepted cache; the director agent
 * writes a new row after committing transactions.
 */

import { eq, and } from "drizzle-orm";
import type { DB } from "../../../db/connection.ts";
import { gravityStateCache, gravityChatState } from "../../../db/schema/index.ts";
import { formatStateView, buildNudge, computeArchiveVersion, buildRecentTail } from "./state-view.ts";
import type { GravityState, TurnMode, RawTransaction } from "./types.ts";

export function createStateCacheStore(db: DB) {
  return {
    /** Read the state-cache row for the last accepted swipe. */
    async getAcceptedCache(chatId: string) {
      const [chatState] = await db
        .select()
        .from(gravityChatState)
        .where(eq(gravityChatState.chatId, chatId))
        .limit(1);
      if (!chatState?.acceptedMessageId) return null;

      const rows = await db
        .select()
        .from(gravityStateCache)
        .where(
          and(
            eq(gravityStateCache.chatId, chatId),
            eq(gravityStateCache.messageId, chatState.acceptedMessageId),
            eq(gravityStateCache.swipeIndex, chatState.acceptedSwipeIndex ?? 0),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    /** Re-render and upsert the state-cache row for a given swipe. */
    async upsertForSwipe(
      tx: DB,
      chatId: string,
      messageId: string,
      swipeIndex: number,
      state: GravityState,
      acceptedTxns: RawTransaction[],
      mode: TurnMode,
    ): Promise<void> {
      const stateView = formatStateView(state);
      const recentTail = buildRecentTail(acceptedTxns);
      const archiveVersion = computeArchiveVersion(state);
      // Store mode nudge alongside state view (used by inject agent)
      const nudge = buildNudge(mode, state);
      void nudge; // currently embedded in stateView; kept for future column expansion
      await tx
        .insert(gravityStateCache)
        .values({ chatId, messageId, swipeIndex, stateView, recentTail, archiveVersion })
        .onConflictDoUpdate({
          target: [gravityStateCache.chatId, gravityStateCache.messageId, gravityStateCache.swipeIndex],
          set: { stateView, recentTail, archiveVersion },
        });
    },
  };
}
