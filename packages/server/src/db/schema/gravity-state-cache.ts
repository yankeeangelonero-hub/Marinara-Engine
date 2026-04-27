// ──────────────────────────────────────────────
// Schema: Gravity State Cache (per swipe)
// ──────────────────────────────────────────────
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { chats } from "./chats.ts";

export const gravityStateCache = sqliteTable(
  "gravity_state_cache",
  {
    chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    swipeIndex: integer("swipe_index").notNull().default(0),
    stateView: text("state_view").notNull(),
    recentTail: text("recent_tail").notNull(),
    archiveVersion: text("archive_version").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.chatId, t.messageId, t.swipeIndex] }),
  }),
);
