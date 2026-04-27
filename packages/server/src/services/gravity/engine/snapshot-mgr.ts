/**
 * snapshot-mgr.ts — DB-backed snapshot management.
 *
 * Replaces the ST chatMetadata-backed snapshot store with Drizzle DB calls.
 * Snapshots are full GravityState payloads keyed by a UUID; they can be
 * optionally tied to a (messageId, swipeIndex) for point-in-time restores.
 */

import { eq, desc } from "drizzle-orm";
import type { DB } from "../../../db/connection.ts";
import { gravitySnapshots } from "../../../db/schema/index.ts";
import type { GravityState } from "./types.ts";

export function createSnapshotManager(db: DB) {
  return {
    async createSnapshot(
      chatId: string,
      label: string,
      state: GravityState,
      messageId?: string,
      swipeIndex?: number,
    ): Promise<string> {
      const id = crypto.randomUUID();
      await db.insert(gravitySnapshots).values({
        id,
        chatId,
        messageId: messageId ?? null,
        swipeIndex: swipeIndex ?? null,
        label,
        payload: JSON.stringify(state),
      });
      return id;
    },

    async listSnapshots(chatId: string) {
      return db
        .select()
        .from(gravitySnapshots)
        .where(eq(gravitySnapshots.chatId, chatId))
        .orderBy(desc(gravitySnapshots.createdAt));
    },

    async getSnapshot(id: string): Promise<GravityState | null> {
      const rows = await db
        .select()
        .from(gravitySnapshots)
        .where(eq(gravitySnapshots.id, id))
        .limit(1);
      if (!rows[0]) return null;
      return JSON.parse(rows[0].payload) as GravityState;
    },
  };
}
