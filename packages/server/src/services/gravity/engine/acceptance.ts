/**
 * acceptance.ts — Gravity turn acceptance helper.
 *
 * Marks a swipe's staged transactions as accepted and advances the chat-state
 * counters. Called from generate.routes.ts alongside gameStateStore.commit()
 * when the user confirms the response.
 */

import { eq, and, sql } from "drizzle-orm";
import type { DB } from "../../../db/connection.ts";
import { gravityTransactions, gravityChatState } from "../../../db/schema/index.ts";
import { logger } from "../../../lib/logger.ts";

export function createGravityAcceptance(db: DB) {
  return {
    /**
     * Mark a swipe's staged transactions as accepted and advance the run-interval counter.
     * Call from generate.routes.ts alongside gameStateStore.commit().
     */
    async commitAcceptedGravityTurn(
      chatId: string,
      messageId: string,
      swipeIndex: number,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(gravityTransactions)
          .set({ accepted: 1 })
          .where(
            and(
              eq(gravityTransactions.chatId, chatId),
              eq(gravityTransactions.messageId, messageId),
              eq(gravityTransactions.swipeIndex, swipeIndex),
            ),
          );
        await tx
          .update(gravityChatState)
          .set({
            acceptedMessageId: messageId,
            acceptedSwipeIndex: swipeIndex,
            userTurnsSinceLastDirector: sql`user_turns_since_last_director + 1`,
          })
          .where(eq(gravityChatState.chatId, chatId));
      });
      logger.debug("gravity: committed turn %s swipe %d for chat %s", messageId, swipeIndex, chatId);
    },
  };
}
