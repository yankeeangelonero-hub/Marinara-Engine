/**
 * ledger-store.ts — DB-backed append-only ledger storage.
 *
 * Replaces the ST chatMetadata-backed ledger with Drizzle DB calls.
 * All accepted transactions are stored in gravity_transactions; chat state
 * (including the rolling seq counter) lives in gravity_chat_state.
 */

import { eq, and, asc } from "drizzle-orm";
import type { DB } from "../../../db/connection.ts";
import { gravityTransactions, gravityChatState } from "../../../db/schema/index.ts";
import type { RawTransaction } from "./types.ts";
import { computeState } from "./state-compute.ts";

export function createLedgerStore(db: DB) {
  return {
    /** All accepted transactions for a chat, in seq order. */
    async getAcceptedTransactions(chatId: string): Promise<RawTransaction[]> {
      const rows = await db
        .select()
        .from(gravityTransactions)
        .where(and(eq(gravityTransactions.chatId, chatId), eq(gravityTransactions.accepted, 1)))
        .orderBy(asc(gravityTransactions.seq));
      return rows.map((r) => JSON.parse(r.payload) as RawTransaction);
    },

    /** All transactions for a specific swipe (accepted or not). */
    async getSwipeTransactions(
      chatId: string,
      messageId: string,
      swipeIndex: number,
    ): Promise<RawTransaction[]> {
      const rows = await db
        .select()
        .from(gravityTransactions)
        .where(
          and(
            eq(gravityTransactions.chatId, chatId),
            eq(gravityTransactions.messageId, messageId),
            eq(gravityTransactions.swipeIndex, swipeIndex),
          ),
        )
        .orderBy(asc(gravityTransactions.seq));
      return rows.map((r) => JSON.parse(r.payload) as RawTransaction);
    },

    /**
     * Allocate seq numbers and stage transactions. Must run inside an outer
     * db.transaction() call — pass the transaction object as `tx`.
     */
    async stageTransactions(
      tx: DB,
      chatId: string,
      messageId: string,
      swipeIndex: number,
      txns: RawTransaction[],
    ): Promise<void> {
      if (txns.length === 0) return;

      const [current] = await tx
        .select({ nextTxSeq: gravityChatState.nextTxSeq })
        .from(gravityChatState)
        .where(eq(gravityChatState.chatId, chatId));
      const startSeq = current?.nextTxSeq ?? 1;

      await tx
        .update(gravityChatState)
        .set({ nextTxSeq: startSeq + txns.length })
        .where(eq(gravityChatState.chatId, chatId));

      await tx.insert(gravityTransactions).values(
        txns.map((t, i) => ({
          id: crypto.randomUUID(),
          chatId,
          messageId,
          swipeIndex,
          seq: startSeq + i,
          op: t.op,
          payload: JSON.stringify(t),
          accepted: 0,
        })),
      );
    },

    /** Replay accepted transactions to get the current authoritative state. */
    async computeAcceptedState(chatId: string) {
      const txns = await this.getAcceptedTransactions(chatId);
      return computeState(null, txns);
    },
  };
}
