// ──────────────────────────────────────────────
// Routes: Agents
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { createAgentConfigSchema, updateAgentConfigSchema, BUILT_IN_AGENTS } from "@marinara-engine/shared";
import type {
  PendingForceFire,
  PlotThread,
  ThreadWeaverState,
} from "@marinara-engine/shared";
import {
  fuseTypeToTurns,
  THREAD_WEAVER_DEFAULT_SETTINGS,
} from "@marinara-engine/shared";
import { z } from "zod";
import { customAlphabet } from "nanoid";
import { readState, toMemoryEntries } from "../services/agents/thread-weaver.js";
import { createAgentsStorage } from "../services/storage/agents.storage.js";

export async function agentsRoutes(app: FastifyInstance) {
  const storage = createAgentsStorage(app.db);

  const threadIdGen = customAlphabet("0123456789abcdef", 6);
  const newThreadId = () => `thr_${threadIdGen()}`;

  async function getThreadWeaverContext(
    chatId: string,
  ): Promise<{ agentId: string; settings: Record<string, unknown>; state: ThreadWeaverState } | null> {
    const agent = await storage.getByType("thread-weaver");
    if (!agent) return null;
    const settings = JSON.parse(agent.settings ?? "{}") as Record<string, unknown>;
    const mem = await storage.getMemory(agent.id, chatId);
    return { agentId: agent.id, settings, state: readState(mem) };
  }

  const threadCategorySchema = z.enum([
    "adversary",
    "social",
    "mystery",
    "opportunity",
    "environment",
    "internal",
  ]);
  const fuseTypeSchema = z.enum(["immediate", "short", "long"]);
  const seedSourceSchema = z.enum(["scene", "player_action", "card_lore", "off_screen"]);

  app.get("/", async () => {
    return storage.list();
  });

  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const agent = await storage.getById(req.params.id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    return agent;
  });

  app.post("/", async (req) => {
    const input = createAgentConfigSchema.parse(req.body);
    return storage.create(input);
  });

  app.patch<{ Params: { id: string } }>("/:id", async (req) => {
    const data = updateAgentConfigSchema.parse(req.body);
    return storage.update(req.params.id, data);
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    try {
      await storage.remove(req.params.id);
      return reply.status(204).send();
    } catch (err) {
      req.log.error(err, "Failed to delete agent %s", req.params.id);
      return reply.status(500).send({ error: "Failed to delete agent. Try restarting the server and retrying." });
    }
  });

  /** Toggle a built-in agent by type. Creates config if first toggle. */
  app.put<{ Params: { agentType: string } }>("/toggle/:agentType", async (req, reply) => {
    const { agentType } = req.params;
    const builtIn = BUILT_IN_AGENTS.find((a) => a.id === agentType);
    if (!builtIn) {
      return reply.status(404).send({ error: "Unknown agent type" });
    }

    const existing = await storage.getByType(agentType);
    if (existing) {
      const currentEnabled = existing.enabled === "true";
      return storage.update(existing.id, { enabled: !currentEnabled });
    }

    // First toggle — create with opposite of default
    return storage.create({
      type: builtIn.id,
      name: builtIn.name,
      description: builtIn.description,
      phase: builtIn.phase,
      enabled: !builtIn.enabledByDefault,
      connectionId: null,
      promptTemplate: "",
      settings: builtIn.defaultInjectAsSection ? { injectAsSection: true } : {},
    });
  });

  /** Get echo chamber messages for a chat (for persistence across refreshes). */
  app.get<{ Params: { chatId: string } }>("/echo-messages/:chatId", async (req) => {
    return storage.getEchoMessages(req.params.chatId);
  });

  /** Clear all echo chamber messages for a chat. */
  app.delete<{ Params: { chatId: string } }>("/echo-messages/:chatId", async (req, reply) => {
    await storage.clearEchoMessages(req.params.chatId);
    return reply.status(204).send();
  });

  /** Clear all agent runs and memory for a specific chat. */
  app.delete<{ Params: { chatId: string } }>("/runs/:chatId", async (req, reply) => {
    const chatId = req.params.chatId;

    // Before wiping all memory, preserve the secret-plot-driver's overarching arc.
    // Scene directions + pacing are cleared (ephemeral per-generation), but the arc
    // is a long-term structure that only clears when the agent is removed from the chat.
    let preservedArc: unknown = null;
    let secretPlotConfigId: string | null = null;
    try {
      const secretPlotConfig = await storage.getByType("secret-plot-driver");
      if (secretPlotConfig) {
        secretPlotConfigId = secretPlotConfig.id;
        const mem = await storage.getMemory(secretPlotConfigId, chatId);
        if (mem.overarchingArc) preservedArc = mem.overarchingArc;
      }
    } catch {
      /* non-critical */
    }

    await storage.clearRunsForChat(chatId);
    await storage.clearMemoryForChat(chatId);

    // Restore the overarching arc
    if (preservedArc && secretPlotConfigId) {
      try {
        await storage.setMemory(secretPlotConfigId, chatId, "overarchingArc", preservedArc);
      } catch {
        /* non-critical */
      }
    }

    return reply.status(204).send();
  });

  /** Clear all memory for a specific agent in a specific chat (used when removing an agent from a chat). */
  app.delete<{ Params: { agentType: string; chatId: string } }>("/memory/:agentType/:chatId", async (req, reply) => {
    const config = await storage.getByType(req.params.agentType);
    if (config) {
      await storage.clearMemoryForAgentInChat(config.id, req.params.chatId);
    }
    return reply.status(204).send();
  });

  // ── Thread Weaver state read ──
  app.get<{ Params: { chatId: string } }>("/thread-weaver/state/:chatId", async (req, reply) => {
    const ctx = await getThreadWeaverContext(req.params.chatId);
    if (!ctx) return reply.status(404).send({ error: "Thread Weaver agent not configured" });
    return ctx.state;
  });

  // ── Manual plant ──
  const plantBodySchema = z.object({
    chatId: z.string(),
    category: threadCategorySchema,
    premise: z.string().min(1),
    payoffHint: z.string().min(1),
    fuseType: fuseTypeSchema,
    seedSource: seedSourceSchema.default("scene"),
  });

  app.post("/thread-weaver/plant", async (req, reply) => {
    const body = plantBodySchema.parse(req.body);
    const ctx = await getThreadWeaverContext(body.chatId);
    if (!ctx) return reply.status(404).send({ error: "Thread Weaver agent not configured" });
    const maxActive = Number(ctx.settings.maxActiveThreads ?? THREAD_WEAVER_DEFAULT_SETTINGS.maxActiveThreads);
    if (ctx.state.activeThreads.length >= maxActive) {
      return reply.status(409).send({ error: `Active thread cap of ${maxActive} reached` });
    }
    const fuseTurns = fuseTypeToTurns(body.fuseType, ctx.settings);
    const planted: PlotThread = {
      id: newThreadId(),
      category: body.category,
      premise: body.premise,
      payoffHint: body.payoffHint,
      fuseType: body.fuseType,
      fuseTurns,
      plantedAtTurn: ctx.state.turnCounter,
      status: "planted",
      seedSource: body.seedSource,
      evolutionCount: 0,
      evolutionHistory: [],
    };
    const next: ThreadWeaverState = {
      ...ctx.state,
      activeThreads: [...ctx.state.activeThreads, planted],
    };
    await storage.setMemoryBatch(ctx.agentId, body.chatId, toMemoryEntries(next));
    return planted;
  });

  // ── Manual invalidate ──
  const invalidateBodySchema = z.object({
    chatId: z.string(),
    threadId: z.string(),
    reason: z.string().default("manually invalidated"),
  });

  app.post("/thread-weaver/invalidate", async (req, reply) => {
    const body = invalidateBodySchema.parse(req.body);
    const ctx = await getThreadWeaverContext(body.chatId);
    if (!ctx) return reply.status(404).send({ error: "Thread Weaver agent not configured" });
    const idx = ctx.state.activeThreads.findIndex((t) => t.id === body.threadId);
    if (idx < 0) return reply.status(404).send({ error: "Thread not found in active set" });
    const thread = ctx.state.activeThreads[idx]!;
    const updated: PlotThread = {
      ...thread,
      status: "invalidated",
      invalidatedAtTurn: ctx.state.turnCounter,
      reason: body.reason,
    };
    const next: ThreadWeaverState = {
      ...ctx.state,
      activeThreads: [...ctx.state.activeThreads.slice(0, idx), ...ctx.state.activeThreads.slice(idx + 1)],
      invalidatedThreads: [...ctx.state.invalidatedThreads, updated],
    };
    await storage.setMemoryBatch(ctx.agentId, body.chatId, toMemoryEntries(next));
    return updated;
  });

  // ── Manual revive ──
  const reviveBodySchema = z.object({
    chatId: z.string(),
    threadId: z.string(),
    fuseType: fuseTypeSchema,
  });

  app.post("/thread-weaver/revive", async (req, reply) => {
    const body = reviveBodySchema.parse(req.body);
    const ctx = await getThreadWeaverContext(body.chatId);
    if (!ctx) return reply.status(404).send({ error: "Thread Weaver agent not configured" });
    const maxActive = Number(ctx.settings.maxActiveThreads ?? THREAD_WEAVER_DEFAULT_SETTINGS.maxActiveThreads);
    if (ctx.state.activeThreads.length >= maxActive) {
      return reply.status(409).send({ error: `Active thread cap of ${maxActive} reached` });
    }
    const idx = ctx.state.invalidatedThreads.findIndex((t) => t.id === body.threadId);
    if (idx < 0) return reply.status(404).send({ error: "Thread not found in graveyard" });
    const thread = ctx.state.invalidatedThreads[idx]!;
    const fuseTurns = fuseTypeToTurns(body.fuseType, ctx.settings);
    const revived: PlotThread = {
      ...thread,
      status: "planted",
      fuseType: body.fuseType,
      fuseTurns,
      plantedAtTurn: ctx.state.turnCounter,
      invalidatedAtTurn: undefined,
      reason: undefined,
    };
    const next: ThreadWeaverState = {
      ...ctx.state,
      activeThreads: [...ctx.state.activeThreads, revived],
      invalidatedThreads: [
        ...ctx.state.invalidatedThreads.slice(0, idx),
        ...ctx.state.invalidatedThreads.slice(idx + 1),
      ],
    };
    await storage.setMemoryBatch(ctx.agentId, body.chatId, toMemoryEntries(next));
    return revived;
  });

  // ── Force-fire (queue for next agent run) ──
  const forceFireBodySchema = z.object({
    chatId: z.string(),
    threadId: z.string(),
    mode: z.enum(["on_scene", "off_scene"]),
  });

  app.post("/thread-weaver/force-fire", async (req, reply) => {
    const body = forceFireBodySchema.parse(req.body);
    const ctx = await getThreadWeaverContext(body.chatId);
    if (!ctx) return reply.status(404).send({ error: "Thread Weaver agent not configured" });
    const exists = ctx.state.activeThreads.some((t) => t.id === body.threadId);
    if (!exists) return reply.status(404).send({ error: "Thread not found in active set" });
    const existing = ctx.state.pendingForceFires.find((f) => f.threadId === body.threadId);
    let pendingForceFires: PendingForceFire[];
    if (existing) {
      pendingForceFires = ctx.state.pendingForceFires.map((f) =>
        f.threadId === body.threadId ? { threadId: body.threadId, mode: body.mode } : f,
      );
    } else {
      pendingForceFires = [...ctx.state.pendingForceFires, { threadId: body.threadId, mode: body.mode }];
    }
    const next: ThreadWeaverState = { ...ctx.state, pendingForceFires };
    await storage.setMemoryBatch(ctx.agentId, body.chatId, toMemoryEntries(next));
    return { queued: { threadId: body.threadId, mode: body.mode } };
  });

  // ── Cancel queued force-fire ──
  app.delete<{ Params: { chatId: string; threadId: string } }>(
    "/thread-weaver/force-fire/:chatId/:threadId",
    async (req, reply) => {
      const { chatId, threadId } = req.params;
      const ctx = await getThreadWeaverContext(chatId);
      if (!ctx) return reply.status(404).send({ error: "Thread Weaver agent not configured" });
      const next: ThreadWeaverState = {
        ...ctx.state,
        pendingForceFires: ctx.state.pendingForceFires.filter((f) => f.threadId !== threadId),
      };
      await storage.setMemoryBatch(ctx.agentId, chatId, toMemoryEntries(next));
      return reply.status(204).send();
    },
  );
}
