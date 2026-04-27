// ──────────────────────────────────────────────
// Schema: Gravity Ledger Transactions
// ──────────────────────────────────────────────
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { chats } from "./chats.ts";

export const gravityTransactions = sqliteTable(
  "gravity_transactions",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    swipeIndex: integer("swipe_index").notNull().default(0),
    seq: integer("seq").notNull(),
    op: text("op").notNull(),
    payload: text("payload").notNull(),
    accepted: integer("accepted").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    byChatMsgSwipe: index("gravity_tx_chat_msg_swipe").on(t.chatId, t.messageId, t.swipeIndex),
    bySeq: index("gravity_tx_seq").on(t.chatId, t.seq),
    byAccepted: index("gravity_tx_accepted").on(t.chatId, t.accepted),
  }),
);
