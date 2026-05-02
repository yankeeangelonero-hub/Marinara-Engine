// ──────────────────────────────────────────────
// Thread Weaver — pure state mutation helpers
// ──────────────────────────────────────────────
import { customAlphabet } from "nanoid";
import {
  type FuseType,
  type PendingFiring,
  type PendingForceFire,
  type PlotThread,
  type ThreadCategory,
  type ThreadEvolutionEntry,
  type ThreadWeaverState,
  type SeedSource,
  fuseTypeToTurns,
  THREAD_WEAVER_DEFAULT_SETTINGS,
} from "@marinara-engine/shared";

const threadIdGen = customAlphabet("0123456789abcdef", 6);
const newThreadId = () => `thr_${threadIdGen()}`;

/**
 * Read the Thread Weaver state from a raw agent-memory blob.
 * Provides safe defaults for missing keys so a fresh chat returns a coherent shape.
 */
export function readState(memory: Record<string, unknown>): ThreadWeaverState {
  return {
    activeThreads: (memory.activeThreads as PlotThread[] | undefined) ?? [],
    recentlyFired: (memory.recentlyFired as PlotThread[] | undefined) ?? [],
    invalidatedThreads: (memory.invalidatedThreads as PlotThread[] | undefined) ?? [],
    pendingFiring: (memory.pendingFiring as PendingFiring[] | undefined) ?? [],
    pendingForceFires: (memory.pendingForceFires as PendingForceFire[] | undefined) ?? [],
    turnCounter: Number(memory.turnCounter ?? 0),
  };
}

/**
 * Pre-pass — runs at the start of every new-user-message agent call.
 * Drains last turn's pendingFiring (assistant message is now committed),
 * increments the turn counter, decrements active fuses, marks any thread
 * at fuse <= 0 as `firing`.
 *
 * Pure: returns a new state, does not mutate input.
 */
export function preparePrePass(state: ThreadWeaverState): ThreadWeaverState {
  // 1. Drain previous-turn pending firings into recentlyFired.
  let recentlyFired = state.recentlyFired;
  let activeThreads = state.activeThreads;
  let invalidatedThreads = state.invalidatedThreads;
  if (state.pendingFiring.length > 0) {
    const pendingIds = new Set(state.pendingFiring.map((p) => p.threadId));
    const drained: PlotThread[] = [];
    activeThreads = activeThreads.filter((t) => {
      if (!pendingIds.has(t.id)) return true;
      const decision = state.pendingFiring.find((p) => p.threadId === t.id)!;
      drained.push({
        ...t,
        status: "fired",
        resolutionMode: decision.mode,
        finalizedDirection: decision.finalizedDirection,
        firedAtTurn: decision.decidedAtTurn,
      });
      return false;
    });
    recentlyFired = [...recentlyFired, ...drained];
  }

  // 2. Increment turn counter.
  const turnCounter = state.turnCounter + 1;

  // 3. Auto-invalidate firing-status threads that have been stuck >3 turns
  //    without resolution. Prevents the firing queue from accumulating when
  //    the agent repeatedly fails (timeouts, parse errors, etc.). Without this,
  //    each stuck thread compounds context bloat on the next turn.
  const STUCK_THRESHOLD = 3;
  activeThreads = activeThreads.filter((t) => {
    if (t.status !== "firing") return true;
    const stuckTurns = turnCounter - t.plantedAtTurn - fuseTurnsForType(t.fuseType);
    if (stuckTurns >= STUCK_THRESHOLD) {
      invalidatedThreads = [
        ...invalidatedThreads,
        {
          ...t,
          status: "invalidated",
          invalidatedAtTurn: turnCounter,
          reason: `auto-invalidated: agent could not resolve firing for ${stuckTurns} turns`,
        },
      ];
      return false;
    }
    return true;
  });

  // 4. Decrement fuses + mark new firings.
  activeThreads = activeThreads.map((t) => {
    if (t.status !== "planted") return t;
    const newFuse = t.fuseTurns - 1;
    return {
      ...t,
      fuseTurns: newFuse,
      status: newFuse <= 0 ? "firing" : "planted",
    };
  });

  return {
    ...state,
    activeThreads,
    recentlyFired,
    invalidatedThreads,
    pendingFiring: [], // drained
    turnCounter,
  };
}

/** Helper: nominal fuse length for a fuse type, used to compute stuck-turns. */
function fuseTurnsForType(fuseType: FuseType): number {
  switch (fuseType) {
    case "immediate":
      return THREAD_WEAVER_DEFAULT_SETTINGS.fuseTurnsImmediate;
    case "short":
      return THREAD_WEAVER_DEFAULT_SETTINGS.fuseTurnsShort;
    case "long":
      return THREAD_WEAVER_DEFAULT_SETTINGS.fuseTurnsLong;
  }
}

/** Categories of decisions the agent may emit per firing thread. */
export interface FiringDecision {
  id: string;
  action: "fire_on_scene" | "fire_off_scene" | "invalidate" | "evolve";
  finalizedDirection?: string;
  newPremise?: string;
  newPayoffHint?: string;
  newFuseType?: FuseType;
  reason?: string;
}

/** New-thread plant input from the agent. */
export interface NewThreadInput {
  category: ThreadCategory;
  premise: string;
  payoffHint: string;
  fuseType: FuseType;
  seedSource: SeedSource;
}

/**
 * Apply the agent's parsed decisions to the state. Pure.
 * Consumes the firingsPerTurnCap, the maxActiveThreads cap, evolutionHistory cap.
 * Returns the next state plus the PendingFiring list to inject this turn.
 */
export function applyDecisions(
  state: ThreadWeaverState,
  firingDecisions: FiringDecision[],
  newThreads: NewThreadInput[],
  settings: Record<string, unknown>,
): { state: ThreadWeaverState; firingsThisTurn: PendingFiring[] } {
  const turnCounter = state.turnCounter;
  const firingsCap = Number(settings.firingsPerTurnCap ?? THREAD_WEAVER_DEFAULT_SETTINGS.firingsPerTurnCap);
  const maxActive = Number(settings.maxActiveThreads ?? THREAD_WEAVER_DEFAULT_SETTINGS.maxActiveThreads);

  let activeThreads = state.activeThreads;
  let invalidatedThreads = state.invalidatedThreads;
  const firingsThisTurn: PendingFiring[] = [];

  let firingsAccepted = 0;

  for (const decision of firingDecisions) {
    const threadIdx = activeThreads.findIndex((t) => t.id === decision.id);
    if (threadIdx < 0) {
      // Unknown ID — skip silently. Logged at the call site.
      continue;
    }
    const thread = activeThreads[threadIdx]!;

    if (decision.action === "fire_on_scene" || decision.action === "fire_off_scene") {
      if (firingsAccepted >= firingsCap) {
        // Over cap — leave as `firing`, will be retried next turn.
        continue;
      }
      if (!decision.finalizedDirection) continue; // malformed; skip
      const mode = decision.action === "fire_on_scene" ? "on_scene" : "off_scene";
      firingsThisTurn.push({
        threadId: decision.id,
        mode,
        finalizedDirection: decision.finalizedDirection,
        decidedAtTurn: turnCounter,
      });
      // Thread stays in activeThreads with status `firing`; gets archived next turn's pre-pass.
      firingsAccepted++;
    } else if (decision.action === "invalidate") {
      const updated: PlotThread = {
        ...thread,
        status: "invalidated",
        invalidatedAtTurn: turnCounter,
        reason: decision.reason ?? "no reason given",
      };
      invalidatedThreads = [...invalidatedThreads, updated];
      activeThreads = [...activeThreads.slice(0, threadIdx), ...activeThreads.slice(threadIdx + 1)];
    } else if (decision.action === "evolve") {
      if (!decision.newFuseType) continue; // malformed; skip
      const historyEntry: ThreadEvolutionEntry = {
        fromPremise: thread.premise,
        fromPayoffHint: thread.payoffHint,
        fromFuseType: thread.fuseType,
        atTurn: turnCounter,
        reason: decision.reason ?? "no reason given",
      };
      const newHistory = [...thread.evolutionHistory, historyEntry].slice(-5);
      const fuseTurns = fuseTypeToTurns(decision.newFuseType, settings);
      const evolved: PlotThread = {
        ...thread,
        premise: decision.newPremise ?? thread.premise,
        payoffHint: decision.newPayoffHint ?? thread.payoffHint,
        fuseType: decision.newFuseType,
        fuseTurns,
        status: "planted",
        evolutionCount: thread.evolutionCount + 1,
        evolutionHistory: newHistory,
      };
      activeThreads = [...activeThreads.slice(0, threadIdx), evolved, ...activeThreads.slice(threadIdx + 1)];
    }
  }

  // Plant new threads (subject to maxActive cap).
  for (const nt of newThreads) {
    if (activeThreads.length >= maxActive) break;
    const fuseTurns = fuseTypeToTurns(nt.fuseType, settings);
    const planted: PlotThread = {
      id: newThreadId(),
      category: nt.category,
      premise: nt.premise,
      payoffHint: nt.payoffHint,
      fuseType: nt.fuseType,
      fuseTurns,
      plantedAtTurn: turnCounter,
      status: "planted",
      seedSource: nt.seedSource,
      evolutionCount: 0,
      evolutionHistory: [],
    };
    activeThreads = [...activeThreads, planted];
  }

  return {
    state: {
      ...state,
      activeThreads,
      invalidatedThreads,
      pendingFiring: firingsThisTurn,
      pendingForceFires: [], // drained — agent saw them in <firing_now>
    },
    firingsThisTurn,
  };
}

/** Age out fired and invalidated threads outside the configured turn windows. Pure. */
export function ageOutWindows(state: ThreadWeaverState, settings: Record<string, unknown>): ThreadWeaverState {
  const firedWindow = Number(
    settings.recentlyFiredWindowTurns ?? THREAD_WEAVER_DEFAULT_SETTINGS.recentlyFiredWindowTurns,
  );
  const invalidatedWindow = Number(
    settings.invalidatedWindowTurns ?? THREAD_WEAVER_DEFAULT_SETTINGS.invalidatedWindowTurns,
  );
  const now = state.turnCounter;
  return {
    ...state,
    recentlyFired: state.recentlyFired.filter((t) => now - (t.firedAtTurn ?? 0) <= firedWindow),
    invalidatedThreads: state.invalidatedThreads.filter(
      (t) => now - (t.invalidatedAtTurn ?? 0) <= invalidatedWindow,
    ),
  };
}

/**
 * Serialize the agent context blocks injected into the agent's prompt.
 * Returns a string ready to append to the agent context builder output.
 */
export function serializeAgentContext(state: ThreadWeaverState): string {
  const parts: string[] = [];

  parts.push(`<turn_counter>${state.turnCounter}</turn_counter>`);

  // Show planted (not yet firing) threads in <active_threads>. Firing threads
  // appear in <firing_now> below with full premise/payoffHint, so listing them
  // here too would be duplicate context for the agent.
  const plantedThreads = state.activeThreads.filter((t) => t.status === "planted");
  parts.push(`<active_threads>`);
  if (plantedThreads.length === 0) {
    parts.push(`(none)`);
  } else {
    for (const t of plantedThreads) {
      parts.push(
        `- id=${t.id} category=${t.category} fuseType=${t.fuseType} fuseTurns=${t.fuseTurns} evolutionCount=${t.evolutionCount}`,
      );
      parts.push(`    premise: ${t.premise}`);
      parts.push(`    payoffHint: ${t.payoffHint}`);
    }
  }
  parts.push(`</active_threads>`);

  // Firing threads — include full premise + payoffHint so the agent has what
  // it needs to choose a resolution mode and write a finalizedDirection.
  const firingThreads = state.activeThreads.filter((t) => t.status === "firing");
  parts.push(`<firing_now>`);
  if (firingThreads.length === 0 && state.pendingForceFires.length === 0) {
    parts.push(`(none)`);
  } else {
    for (const t of firingThreads) {
      const forced = state.pendingForceFires.find((f) => f.threadId === t.id);
      const suffix = forced ? ` (user-forced, mode=${forced.mode})` : "";
      parts.push(`- id=${t.id} category=${t.category}${suffix}`);
      parts.push(`    premise: ${t.premise}`);
      parts.push(`    payoffHint: ${t.payoffHint}`);
    }
    // Force-fires for threads that aren't in active set (e.g., recently invalidated by another path)
    for (const f of state.pendingForceFires) {
      if (firingThreads.some((t) => t.id === f.threadId)) continue;
      parts.push(`- id=${f.threadId} (user-forced, mode=${f.mode}, thread no longer active)`);
    }
  }
  parts.push(`</firing_now>`);

  // Show only the 10 most recent fired threads to the agent, even though
  // memory may hold up to 30 turns. Reduces prompt bloat when chats run long.
  parts.push(`<recently_fired>`);
  if (state.recentlyFired.length === 0) {
    parts.push(`(none)`);
  } else {
    for (const t of state.recentlyFired.slice(-10)) {
      parts.push(
        `- id=${t.id} category=${t.category} firedAtTurn=${t.firedAtTurn ?? "?"} mode=${t.resolutionMode ?? "?"}`,
      );
      parts.push(`    premise: ${t.premise}`);
    }
  }
  parts.push(`</recently_fired>`);

  // Same cap as recently_fired — limit prompt bloat.
  parts.push(`<invalidated_threads>`);
  if (state.invalidatedThreads.length === 0) {
    parts.push(`(none)`);
  } else {
    for (const t of state.invalidatedThreads.slice(-10)) {
      parts.push(`- id=${t.id} category=${t.category} invalidatedAtTurn=${t.invalidatedAtTurn ?? "?"}`);
      parts.push(`    premise: ${t.premise}`);
      parts.push(`    reason: ${t.reason ?? "(none)"}`);
    }
  }
  parts.push(`</invalidated_threads>`);

  return parts.join("\n");
}

/** Build the per-turn injection blocks that go into the MAIN model's prompt. */
export function buildMainPromptBlocks(firings: PendingFiring[]): { sceneDirective?: string; meanwhileCutaway?: string } {
  const onScene = firings.filter((f) => f.mode === "on_scene");
  const offScene = firings.filter((f) => f.mode === "off_scene");

  const out: { sceneDirective?: string; meanwhileCutaway?: string } = {};

  if (onScene.length > 0) {
    const lines = onScene.map((f) => `- ${f.finalizedDirection}`).join("\n");
    out.sceneDirective = `<scene_directive>\nThis turn, weave in the following plot beat(s):\n${lines}\n</scene_directive>`;
  }

  if (offScene.length > 0) {
    // We only support one off-scene cutaway per turn (taking the first).
    const f = offScene[0]!;
    out.meanwhileCutaway = `<meanwhile_cutaway>\nBegin your response with a brief "meanwhile, elsewhere…" cutaway (1-2 paragraphs, italicized) depicting:\n${f.finalizedDirection}\nThen continue with the main scene the user is engaged in.\n</meanwhile_cutaway>`;
  }

  return out;
}

/**
 * Convert the state back to the per-key memory blob persisted in agentMemory.
 * Pairs with readState() — what setMemoryBatch should write.
 */
export function toMemoryEntries(state: ThreadWeaverState): Record<string, unknown> {
  return {
    activeThreads: state.activeThreads,
    recentlyFired: state.recentlyFired,
    invalidatedThreads: state.invalidatedThreads,
    pendingFiring: state.pendingFiring,
    pendingForceFires: state.pendingForceFires,
    turnCounter: state.turnCounter,
  };
}
