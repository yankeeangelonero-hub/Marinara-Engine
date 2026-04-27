// ──────────────────────────────────────────────
// Schema: Gravity Chat State (one row per chat)
// ──────────────────────────────────────────────
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { chats } from "./chats.ts";

export const gravityChatState = sqliteTable("gravity_chat_state", {
  chatId: text("chat_id").primaryKey().references(() => chats.id, { onDelete: "cascade" }),
  mode: text("mode").notNull().default("regular"),
  pendingCorrections: text("pending_corrections"),
  acceptedMessageId: text("accepted_message_id"),
  acceptedSwipeIndex: integer("accepted_swipe_index"),
  nextTxSeq: integer("next_tx_seq").notNull().default(1),
  userTurnsSinceLastDirector: integer("user_turns_since_last_director").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
