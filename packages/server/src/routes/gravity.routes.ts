// ──────────────────────────────────────────────
// Routes: Gravity Ledger (export / import)
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import {
  gravityTransactions,
  gravityStateCache,
  gravitySnapshots,
  gravityChatState,
} from "../db/schema/index.js";
import { logger } from "../lib/logger.js";

export async function gravityRoutes(app: FastifyInstance) {
  // ── POST /init/:chatId ───────────────────────────────────────────────────
  // Idempotent: creates the gravity_chat_state row for a chat if it doesn't
  // exist, or returns the existing row. Must be called once when Gravity is
  // first enabled for a chat (before any generate request fires the director).
  app.post<{ Params: { chatId: string }; Body: { mode?: string } }>(
    "/init/:chatId",
    async (req, reply) => {
      const { chatId } = req.params;
      const mode = req.body?.mode ?? "regular";

      try {
        await app.db
          .insert(gravityChatState)
          .values({ chatId, mode })
          .onConflictDoNothing();

        const [row] = await app.db
          .select()
          .from(gravityChatState)
          .where(eq(gravityChatState.chatId, chatId))
          .limit(1);

        logger.info("[gravity-routes] init chat=%s mode=%s", chatId, row?.mode ?? mode);
        return reply.send({ success: true, chatId, chatState: row ?? null });
      } catch (err) {
        logger.error(err, "[gravity-routes] init failed for chat %s", chatId);
        return reply.status(500).send({ error: "Init failed" });
      }
    },
  );

  // ── GET /state/:chatId ──────────────────────────────────────────────────
  // Returns the current accepted state view for the widget panel.
  app.get<{ Params: { chatId: string } }>("/state/:chatId", async (req, reply) => {
    const { chatId } = req.params;
    try {
      const [chatState] = await app.db
        .select()
        .from(gravityChatState)
        .where(eq(gravityChatState.chatId, chatId))
        .limit(1);

      if (!chatState?.acceptedMessageId) {
        return reply.send({ initialized: false, mode: "regular", stateView: "", archiveVersion: "", nextTxSeq: 1 });
      }

      const [cache] = await app.db
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

      return reply.send({
        initialized: true,
        mode: chatState.mode,
        stateView: cache?.stateView ?? "",
        archiveVersion: cache?.archiveVersion ?? "",
        nextTxSeq: chatState.nextTxSeq,
      });
    } catch (err) {
      logger.error(err, "[gravity-routes] state fetch failed for chat %s", chatId);
      return reply.status(500).send({ error: "State fetch failed" });
    }
  });

  // ── GET /export/:chatId ──────────────────────────────────────────────────
  // Returns all gravity data for a chat as a portable JSON bundle.
  // By default only accepted transactions are included; pass
  // ?include_pending=true to include staged (unaccepted) rows as well.
  app.get<{ Params: { chatId: string }; Querystring: { include_pending?: string } }>(
    "/export/:chatId",
    async (req, reply) => {
      const { chatId } = req.params;
      const includePending =
        req.query.include_pending === "true" || req.query.include_pending === "1";

      try {
        const txns = includePending
          ? await app.db
              .select()
              .from(gravityTransactions)
              .where(eq(gravityTransactions.chatId, chatId))
          : await app.db
              .select()
              .from(gravityTransactions)
              .where(and(eq(gravityTransactions.chatId, chatId), eq(gravityTransactions.accepted, 1)));

        const stateCache = await app.db
          .select()
          .from(gravityStateCache)
          .where(eq(gravityStateCache.chatId, chatId));

        const snapshots = await app.db
          .select()
          .from(gravitySnapshots)
          .where(eq(gravitySnapshots.chatId, chatId));

        const [chatState] = await app.db
          .select()
          .from(gravityChatState)
          .where(eq(gravityChatState.chatId, chatId))
          .limit(1);

        logger.info(
          "[gravity-routes] export chat=%s txns=%d cacheRows=%d snapshots=%d",
          chatId,
          txns.length,
          stateCache.length,
          snapshots.length,
        );

        return reply.send({
          chatId,
          exportedAt: Math.floor(Date.now() / 1000),
          transactions: txns,
          stateCache,
          snapshots,
          chatState: chatState ?? null,
        });
      } catch (err) {
        logger.error(err, "[gravity-routes] export failed for chat %s", chatId);
        return reply.status(500).send({ error: "Export failed" });
      }
    },
  );

  // ── POST /import/:chatId ─────────────────────────────────────────────────
  // Restores a gravity bundle previously produced by the export endpoint.
  // Only accepted transactions are inserted; staged rows are skipped.
  // All rows are upserted (safe to re-import).
  app.post<{
    Params: { chatId: string };
    Body: {
      transactions?: unknown[];
      stateCache?: unknown[];
      snapshots?: unknown[];
      chatState?: Record<string, unknown> | null;
    };
  }>("/import/:chatId", async (req, reply) => {
    const { chatId } = req.params;
    const body = req.body ?? {};

    try {
      await app.db.transaction(async (tx) => {
        // ── Transactions (accepted only) ─────────────────────────────────
        const txRows = Array.isArray(body.transactions) ? body.transactions : [];
        for (const raw of txRows) {
          const row = raw as Record<string, unknown>;
          if (Number(row["accepted"]) !== 1) continue;
          await tx
            .insert(gravityTransactions)
            .values({
              id: String(row["id"]),
              chatId,
              messageId: String(row["messageId"]),
              swipeIndex: Number(row["swipeIndex"] ?? 0),
              seq: Number(row["seq"]),
              op: String(row["op"]),
              payload: String(row["payload"]),
              accepted: 1,
            })
            .onConflictDoUpdate({
              target: gravityTransactions.id,
              set: {
                seq: Number(row["seq"]),
                op: String(row["op"]),
                payload: String(row["payload"]),
                accepted: 1,
              },
            });
        }

        // ── State cache ──────────────────────────────────────────────────
        const cacheRows = Array.isArray(body.stateCache) ? body.stateCache : [];
        for (const raw of cacheRows) {
          const row = raw as Record<string, unknown>;
          await tx
            .insert(gravityStateCache)
            .values({
              chatId,
              messageId: String(row["messageId"]),
              swipeIndex: Number(row["swipeIndex"] ?? 0),
              stateView: String(row["stateView"] ?? ""),
              recentTail: String(row["recentTail"] ?? "[]"),
              archiveVersion: String(row["archiveVersion"] ?? ""),
            })
            .onConflictDoUpdate({
              target: [gravityStateCache.chatId, gravityStateCache.messageId, gravityStateCache.swipeIndex],
              set: {
                stateView: String(row["stateView"] ?? ""),
                recentTail: String(row["recentTail"] ?? "[]"),
                archiveVersion: String(row["archiveVersion"] ?? ""),
              },
            });
        }

        // ── Snapshots ────────────────────────────────────────────────────
        const snapRows = Array.isArray(body.snapshots) ? body.snapshots : [];
        for (const raw of snapRows) {
          const row = raw as Record<string, unknown>;
          await tx
            .insert(gravitySnapshots)
            .values({
              id: String(row["id"]),
              chatId,
              messageId: row["messageId"] != null ? String(row["messageId"]) : null,
              swipeIndex: row["swipeIndex"] != null ? Number(row["swipeIndex"]) : null,
              label: String(row["label"] ?? ""),
              payload: String(row["payload"] ?? ""),
            })
            .onConflictDoUpdate({
              target: gravitySnapshots.id,
              set: {
                label: String(row["label"] ?? ""),
                payload: String(row["payload"] ?? ""),
              },
            });
        }

        // ── Chat state ───────────────────────────────────────────────────
        if (body.chatState != null && typeof body.chatState === "object") {
          const cs = body.chatState;
          await tx
            .insert(gravityChatState)
            .values({
              chatId,
              mode: String(cs["mode"] ?? "regular"),
              pendingCorrections: cs["pendingCorrections"] != null ? String(cs["pendingCorrections"]) : null,
              acceptedMessageId: cs["acceptedMessageId"] != null ? String(cs["acceptedMessageId"]) : null,
              acceptedSwipeIndex: cs["acceptedSwipeIndex"] != null ? Number(cs["acceptedSwipeIndex"]) : null,
              nextTxSeq: Number(cs["nextTxSeq"] ?? 1),
              userTurnsSinceLastDirector: Number(cs["userTurnsSinceLastDirector"] ?? 0),
            })
            .onConflictDoUpdate({
              target: gravityChatState.chatId,
              set: {
                mode: String(cs["mode"] ?? "regular"),
                pendingCorrections: cs["pendingCorrections"] != null ? String(cs["pendingCorrections"]) : null,
                acceptedMessageId: cs["acceptedMessageId"] != null ? String(cs["acceptedMessageId"]) : null,
                acceptedSwipeIndex: cs["acceptedSwipeIndex"] != null ? Number(cs["acceptedSwipeIndex"]) : null,
                nextTxSeq: Number(cs["nextTxSeq"] ?? 1),
                userTurnsSinceLastDirector: Number(cs["userTurnsSinceLastDirector"] ?? 0),
              },
            });
        }
      });

      const txCount = Array.isArray(body.transactions)
        ? body.transactions.filter((r) => Number((r as Record<string, unknown>)["accepted"]) === 1).length
        : 0;
      logger.info("[gravity-routes] import completed chat=%s accepted_txns=%d", chatId, txCount);
      return reply.send({ success: true, chatId });
    } catch (err) {
      logger.error(err, "[gravity-routes] import failed for chat %s", chatId);
      return reply.status(500).send({ error: "Import failed" });
    }
  });
}
