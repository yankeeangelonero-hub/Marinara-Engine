// ──────────────────────────────────────────────
// Schema: Gravity Snapshots
// ──────────────────────────────────────────────
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { chats } from "./chats.ts";

export const gravitySnapshots = sqliteTable(
  "gravity_snapshots",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
    messageId: text("message_id"),
    swipeIndex: integer("swipe_index"),
    label: text("label").notNull(),
    payload: text("payload").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    byChat: index("gravity_snap_chat").on(t.chatId),
  }),
);
