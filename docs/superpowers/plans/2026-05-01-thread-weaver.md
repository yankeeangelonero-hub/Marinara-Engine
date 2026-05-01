# Thread Weaver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new built-in pre-generation agent — `thread-weaver` — that drives narrative through structured, timed plot threads with a fuse mechanic, four resolution actions (`fire_on_scene` / `fire_off_scene` / `evolve` / `invalidate`), and a debug-drawer UI for active threads, recent fires, and a graveyard with revive.

**Architecture:** New built-in agent registered alongside Secret Plot Driver (both can run; different layers — strategic vs. tactical). Server-side: per-turn deterministic pre-pass (decrement fuses, mark firing) → LLM call returns `firingDecisions` and `newThreads` JSON → post-pass applies decisions and persists to `agentMemory` via a new atomic `setMemoryBatch` helper. Pure thread-state mutations live in a new `services/agents/thread-weaver.ts` module. Injection adds two new prompt blocks (`<scene_directive>`, `<meanwhile_cutaway>`) immediately before the last user message. Agent is **non-critical** — failures do not block generation. Client-side: new Zustand slice + REST endpoints for manual plant/force-fire/invalidate/revive + a `ThreadWeaverPanel` rendered in `ChatSettingsDrawer` under the existing agent-debug area.

**Tech Stack:** TypeScript, Drizzle ORM, Fastify (server); React + Zustand + TailwindCSS (client); Pino logging; pnpm workspace packages (`shared`, `server`, `client`).

**Spec reference:** `docs/superpowers/specs/2026-05-01-thread-weaver-design.md`

**Validation:** This codebase has no automated test suite (per CLAUDE.md). Each task ends with `pnpm check` (TypeScript + ESLint) and a commit. Manual end-to-end verification happens at milestone tasks (after Task 10 and after Task 15).

---

## File Structure

### Created files
- `packages/server/src/services/agents/thread-weaver.ts` — pure functions for thread state mutations (pre-pass, post-pass, age-out, context serialization).
- `packages/client/src/components/agents/ThreadWeaverPanel.tsx` — debug-drawer panel with active threads, recently fired, graveyard, manual plant form.

### Modified files
- `packages/shared/src/types/agent.ts` — add `BUILT_IN_AGENT_IDS.THREAD_WEAVER`, `BUILT_IN_AGENTS` entry, `thread_weaver_update` to `AgentResultType`, `DEFAULT_AGENT_TOOLS` entry, new `PlotThread`/`ThreadCategory`/`FuseType`/`ThreadStatus`/`SeedSource`/`PendingFiring` types.
- `packages/shared/src/constants/agent-prompts.ts` — add default prompt template under key `"thread-weaver"`.
- `packages/shared/src/schemas/agent.schema.ts` — add `"thread_weaver_update"` to result-type enum.
- `packages/server/src/services/storage/agents.storage.ts` — add `setMemoryBatch(agentConfigId, chatId, entries)` using `db.transaction`.
- `packages/server/src/services/agents/agent-executor.ts` — register `"thread-weaver"` in `AGENT_RESULT_TYPE_MAP` and `JSON_AGENTS`; inject `<active_threads>`, `<firing_now>`, `<recently_fired>`, `<turn_counter>` blocks in the agent context builder; treat parse failures as failures (no longer silent successes).
- `packages/server/src/routes/generate.routes.ts` — pre-pass before pipeline, post-pass after pipeline, scene_directive + meanwhile_cutaway injection, regen-branch inline filter.
- `packages/server/src/routes/agents.routes.ts` — five new endpoints under `/agents/thread-weaver/*` for plant, force-fire, invalidate, revive, and state read.
- `packages/client/src/stores/agent.store.ts` — add `threadWeaverState` slice + setters.
- `packages/client/src/hooks/use-generate.ts` — handle `thread_weaver_update` in the SSE switch.
- `packages/client/src/components/chat/ChatSettingsDrawer.tsx` — register `ThreadWeaverPanel` under the agent-debug area.

---

### Task 1: Add Thread Weaver types and registry

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `packages/shared/src/schemas/agent.schema.ts`

- [ ] **Step 1: Add new types and constants to `packages/shared/src/types/agent.ts`**

Add `"thread_weaver_update"` to the `AgentResultType` union (around line 15-40, alongside other result types):

```ts
export type AgentResultType =
  | "game_state_update"
  | "text_rewrite"
  | "sprite_change"
  | "echo_message"
  | "quest_update"
  | "image_prompt"
  | "context_injection"
  | "continuity_check"
  | "director_event"
  | "lorebook_update"
  | "character_card_update"
  | "prompt_review"
  | "background_change"
  | "character_tracker_update"
  | "persona_stats_update"
  | "custom_tracker_update"
  | "chat_summary"
  | "spotify_control"
  | "haptic_command"
  | "cyoa_choices"
  | "secret_plot"
  | "game_master_narration"
  | "party_action"
  | "game_map_update"
  | "game_state_transition"
  | "thread_weaver_update";
```

Add `THREAD_WEAVER` to `BUILT_IN_AGENT_IDS` (around line 151-182):

```ts
export const BUILT_IN_AGENT_IDS = {
  // ... existing entries ...
  PARTY_PLAYER: "party-player",
  THREAD_WEAVER: "thread-weaver",
} as const;
```

Add the agent metadata entry to `BUILT_IN_AGENTS` array (place after `secret-plot-driver` entry to keep narrative-direction agents grouped):

```ts
  {
    id: "thread-weaver",
    name: "Thread Weaver",
    description:
      "Drives narrative through structured plot threads with timed fuses. Plants threads in categories (adversary, social, mystery, opportunity, environment, internal) with immediate/short/long fuses. When fuses hit zero, decides per-thread whether to fire on-scene, fire as a meanwhile cutaway, evolve (revise + re-fuse), or invalidate. Pairs well with Automated Chat Summary for long chats. Best with Secret Plot Driver enabled too — Thread Weaver acts as the tactical layer to its strategic arc.",
    phase: "pre_generation",
    enabledByDefault: false,
    category: "writer",
  },
```

Add the default-tools entry to `DEFAULT_AGENT_TOOLS` (around line 501-539):

```ts
  "thread-weaver": [],
```

After the `CharacterCardUpdateResult` interface (around line 600), add the new Thread Weaver types:

```ts
// ──────────────────────────────────────────────
// Thread Weaver Types
// ──────────────────────────────────────────────

export type ThreadCategory =
  | "adversary"
  | "social"
  | "mystery"
  | "opportunity"
  | "environment"
  | "internal";

export type FuseType = "immediate" | "short" | "long";

export type ThreadStatus = "planted" | "firing" | "fired" | "invalidated";

export type SeedSource = "scene" | "player_action" | "card_lore" | "off_screen";

export interface ThreadEvolutionEntry {
  fromPremise: string;
  fromPayoffHint: string;
  fromFuseType: FuseType;
  atTurn: number;
  reason: string;
}

export interface PlotThread {
  id: string;
  category: ThreadCategory;
  premise: string;
  payoffHint: string;
  fuseType: FuseType;
  fuseTurns: number;
  plantedAtTurn: number;
  status: ThreadStatus;
  seedSource: SeedSource;
  evolutionCount: number;
  /** Capped at last 5 entries; oldest dropped on overflow. */
  evolutionHistory: ThreadEvolutionEntry[];
  resolutionMode?: "on_scene" | "off_scene";
  finalizedDirection?: string;
  reason?: string;
  firedAtTurn?: number;
  invalidatedAtTurn?: number;
}

export interface PendingFiring {
  threadId: string;
  mode: "on_scene" | "off_scene";
  finalizedDirection: string;
  decidedAtTurn: number;
}

export interface PendingForceFire {
  threadId: string;
  mode: "on_scene" | "off_scene";
}

/**
 * Full agent memory snapshot for Thread Weaver.
 * Stored across multiple keys in agentMemory; this type assembles them.
 */
export interface ThreadWeaverState {
  activeThreads: PlotThread[];
  recentlyFired: PlotThread[];
  invalidatedThreads: PlotThread[];
  pendingFiring: PendingFiring[];
  pendingForceFires: PendingForceFire[];
  turnCounter: number;
}

/** Default settings for Thread Weaver — applied via getDefaultBuiltInAgentSettings. */
export const THREAD_WEAVER_DEFAULT_SETTINGS = {
  maxActiveThreads: 5,
  firingsPerTurnCap: 2,
  recentlyFiredWindowTurns: 30,
  invalidatedWindowTurns: 30,
  fuseTurnsImmediate: 1,
  fuseTurnsShort: 3,
  fuseTurnsLong: 10,
} as const;

/** Convert a fuseType to its turn count using current agent settings (or defaults). */
export function fuseTypeToTurns(fuseType: FuseType, settings: Record<string, unknown> = {}): number {
  switch (fuseType) {
    case "immediate":
      return Number(settings.fuseTurnsImmediate ?? THREAD_WEAVER_DEFAULT_SETTINGS.fuseTurnsImmediate);
    case "short":
      return Number(settings.fuseTurnsShort ?? THREAD_WEAVER_DEFAULT_SETTINGS.fuseTurnsShort);
    case "long":
      return Number(settings.fuseTurnsLong ?? THREAD_WEAVER_DEFAULT_SETTINGS.fuseTurnsLong);
  }
}
```

Update `getDefaultBuiltInAgentSettings` (around line 484) to include Thread Weaver defaults:

```ts
export function getDefaultBuiltInAgentSettings(agentType: string): Record<string, unknown> {
  const builtIn = BUILT_IN_AGENTS.find((agent) => agent.id === agentType);
  const settings: Record<string, unknown> = {};

  if (builtIn?.defaultInjectAsSection) {
    settings.injectAsSection = true;
  }

  const runInterval = BUILT_IN_AGENT_RUN_INTERVAL_DEFAULTS[agentType];
  if (runInterval !== undefined) {
    settings.runInterval = runInterval;
  }

  if (agentType === "thread-weaver") {
    Object.assign(settings, THREAD_WEAVER_DEFAULT_SETTINGS);
  }

  return settings;
}
```

- [ ] **Step 2: Add the result type to the schema enum**

In `packages/shared/src/schemas/agent.schema.ts` (around lines 24-27), add `"thread_weaver_update"` to the result-type Zod enum:

```ts
  "chat_summary",
  "spotify_control",
  "secret_plot",
  "thread_weaver_update",
]);
```

- [ ] **Step 3: Verify compile**

Run: `pnpm check`
Expected: PASS — TypeScript and ESLint clean.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/agent.ts packages/shared/src/schemas/agent.schema.ts
git commit -m "feat(agents): add Thread Weaver types and registry entry"
```

---

### Task 2: Add Thread Weaver default prompt template

**Files:**
- Modify: `packages/shared/src/constants/agent-prompts.ts`

- [ ] **Step 1: Add the prompt template**

In `packages/shared/src/constants/agent-prompts.ts`, add a new entry to `DEFAULT_AGENT_PROMPTS` after the `secret-plot-driver` entry (around line 680):

```ts
  /* ────────────────────────────────────────── */
  "thread-weaver": `You are the Thread Weaver — a hidden narrative engine that drives stories through structured plot threads with timed fuses.

You manage three things every turn:
1. EXISTING THREADS in <active_threads> — running fuses you may evolve.
2. FIRING THREADS in <firing_now> — fuses just hit zero; you must decide their resolution.
3. NEW THREADS — plant fresh threads when the scene reveals seed-worthy moments.

LAYER OF AWARENESS (read in this order):
- <chat_summary>: long-term arc and what has happened across the whole chat (may be absent).
- <overarching_arc>: present only if Secret Plot Driver is also enabled. If present, your threads should SERVE this arc, not contradict it.
- <recent_messages>: the immediate beat — what the user just said and what just happened.
- <active_threads>: your own running plot mechanics.
- <recently_fired>: threads that have already paid off in the last 30 turns. Useful for callbacks. Do NOT re-issue these.
- <invalidated_threads>: threads you previously killed. Do NOT re-plant them under the same premise.

THREAD CATEGORIES (aim for variety; let genre dictate the natural mix):
- adversary: Hostile intent — someone or something opposed to the player.
- social: Relationships, reputation, alliances, romance, rivalries.
- mystery: An unrevealed truth, an unanswered question, a secret.
- opportunity: Something positive to pursue — a tip, gift, lead, unattended treasure.
- environment: Weather, location, world conditions, seasonal pressure, deadline.
- internal: An NPC's doubt, growth, dilemma, moral conflict. NEVER plant 'internal' threads about the player persona — the player's internal state is the user's domain.

FUSE TYPES (turn count until firing):
- immediate: 1 turn — fires next turn. Use for nudges that should pay off quickly.
- short: 3 turns — fires in three turns. Use for scene-level beats.
- long: 10 turns — fires in ten turns. Use for setup-payoff arcs across a session.

FOR EACH FIRING THREAD (<firing_now>), decide ONE action:
- fire_on_scene: Fire in the current beat. Provide finalizedDirection — 1-2 sentences telling the main model how to weave it in. PREFER this when the current scene can naturally accommodate the thread.
- fire_off_scene: Fire as a brief "meanwhile, elsewhere" cutaway BEFORE the main scene. Provide finalizedDirection — 1-2 sentences describing what happens off-screen. ONLY use when the current beat is genuinely intimate, time-skipped, or unrelated to the thread. Do NOT default to off-scene; it is louder than on-scene because it shoves a B-plot in front of the user's actual moment.
- evolve: The story has shaped this thread. Provide newFuseType (immediate/short/long); optionally revise newPremise and/or newPayoffHint. Mandatory reason explaining what the story imposed. Evolution must reflect changes the story has IMPOSED on the thread, not be retrofitted to match what is already happening this turn. If the current scene already contains the thread's payoff, fire it instead.
- invalidate: The thread is no longer narratively valid (the character it concerned has died, the location is unreachable, the player chose a path that closed it off). Mandatory reason citing what made it invalid.

PLANT NEW THREADS when the recent scene establishes seed-worthy material:
- A stranger glances meaningfully → adversary or mystery thread with short fuse.
- The player makes a meaningful choice → adversary/social/opportunity (long fuse).
- A location has unexplained features → mystery (long fuse).
- An NPC voices doubt or struggle → internal (short or long fuse).
- A deadline is mentioned → environment (short fuse).

DIVERSITY: aim for variety across categories among the active set. If you already have 3 adversary threads active, prefer a different category — UNLESS the genre/setting genuinely calls for adversary-heavy planting (e.g., a war campaign).

CAPS:
- 5 active threads max. If the active set is at 5, do NOT plant new threads — focus only on firingDecisions.
- 2 firings per turn max. Even if <firing_now> contains more than 2 IDs, decide on all of them; the server will inject only the first 2 and queue the rest for next turn.

RULES OF THUMB:
- Trust the user's pacing. If recent_messages show a tender or quiet beat, prefer evolve over fire to push the fuse out rather than interrupt the moment.
- Do NOT plant threads about events that already happened — those go in <recently_fired> as callbacks, not as new threads.
- Do NOT invalidate to avoid work. If you invalidate, the reason must cite specific narrative text.
- When <firing_now> is empty AND active is at 5 AND nothing is seed-worthy, return: {"newThreads": [], "firingDecisions": []}

OUTPUT — strict JSON, no prose outside the object:
{
  "newThreads": [
    {
      "category": "adversary | social | mystery | opportunity | environment | internal",
      "premise": "1 sentence — what this thread is",
      "payoffHint": "1 sentence — how it might fire (advisory, not prescriptive)",
      "fuseType": "immediate | short | long",
      "seedSource": "scene | player_action | card_lore | off_screen"
    }
  ],
  "firingDecisions": [
    {
      "id": "thr_xxxxxx (must match an id from <firing_now>)",
      "action": "fire_on_scene | fire_off_scene | invalidate | evolve",
      "finalizedDirection": "1-2 sentences (required for fire_on_scene and fire_off_scene)",
      "newPremise": "(optional, evolve only)",
      "newPayoffHint": "(optional, evolve only)",
      "newFuseType": "immediate | short | long (required for evolve)",
      "reason": "1 sentence (required for invalidate and evolve)"
    }
  ]
}`,
```

- [ ] **Step 2: Verify compile**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants/agent-prompts.ts
git commit -m "feat(agents): add Thread Weaver default prompt template"
```

---

### Task 3: Add `setMemoryBatch` storage helper

**Files:**
- Modify: `packages/server/src/services/storage/agents.storage.ts`

- [ ] **Step 1: Add the batch helper**

In `packages/server/src/services/storage/agents.storage.ts`, after the existing `setMemory` method (around line 288), add:

```ts
    /**
     * Atomically set multiple memory keys for an agent in a chat.
     * Wraps all writes in a single transaction so partial failure leaves no torn state.
     * Existing keys are updated; missing keys are inserted.
     */
    async setMemoryBatch(agentConfigId: string, chatId: string, entries: Record<string, unknown>) {
      const resolvedAgentConfigId = await resolveAgentConfigId(agentConfigId);
      const keys = Object.keys(entries);
      if (keys.length === 0) return;

      await db.transaction(async (tx) => {
        for (const key of keys) {
          const value = entries[key];
          const stringValue = typeof value === "string" ? value : JSON.stringify(value);
          const existing = await tx
            .select()
            .from(agentMemory)
            .where(
              and(
                eq(agentMemory.agentConfigId, resolvedAgentConfigId),
                eq(agentMemory.chatId, chatId),
                eq(agentMemory.key, key),
              ),
            );

          if (existing.length > 0) {
            await tx
              .update(agentMemory)
              .set({ value: stringValue, updatedAt: now() })
              .where(eq(agentMemory.id, existing[0]!.id));
          } else {
            await tx.insert(agentMemory).values({
              id: newId(),
              agentConfigId: resolvedAgentConfigId,
              chatId,
              key,
              value: stringValue,
              updatedAt: now(),
            });
          }
        }
      });
    },
```

- [ ] **Step 2: Verify compile**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/storage/agents.storage.ts
git commit -m "feat(agents): add setMemoryBatch atomic multi-key write helper"
```

---

### Task 4: Create thread-weaver service module (pure functions)

**Files:**
- Create: `packages/server/src/services/agents/thread-weaver.ts`

This module owns all thread state mutations. Pure functions — no I/O. The route layer reads memory, calls these to mutate, and writes the result back.

- [ ] **Step 1: Create the new module**

Create `packages/server/src/services/agents/thread-weaver.ts`:

```ts
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

  // 3. Decrement fuses + mark `firing`.
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
    pendingFiring: [], // drained
    turnCounter,
  };
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

  parts.push(`<active_threads>`);
  if (state.activeThreads.length === 0) {
    parts.push(`(none)`);
  } else {
    for (const t of state.activeThreads) {
      parts.push(
        `- id=${t.id} category=${t.category} fuseType=${t.fuseType} fuseTurns=${t.fuseTurns} status=${t.status} evolutionCount=${t.evolutionCount}`,
      );
      parts.push(`    premise: ${t.premise}`);
      parts.push(`    payoffHint: ${t.payoffHint}`);
    }
  }
  parts.push(`</active_threads>`);

  // Firing IDs include both fuse-zero firings AND user-queued force-fires.
  const firingIds = new Set([
    ...state.activeThreads.filter((t) => t.status === "firing").map((t) => t.id),
    ...state.pendingForceFires.map((f) => f.threadId),
  ]);
  parts.push(`<firing_now>`);
  if (firingIds.size === 0) {
    parts.push(`(none)`);
  } else {
    for (const id of firingIds) {
      const forced = state.pendingForceFires.find((f) => f.threadId === id);
      const suffix = forced ? ` (user-forced, mode=${forced.mode})` : "";
      parts.push(`- ${id}${suffix}`);
    }
  }
  parts.push(`</firing_now>`);

  parts.push(`<recently_fired>`);
  if (state.recentlyFired.length === 0) {
    parts.push(`(none)`);
  } else {
    for (const t of state.recentlyFired) {
      parts.push(
        `- id=${t.id} category=${t.category} firedAtTurn=${t.firedAtTurn ?? "?"} mode=${t.resolutionMode ?? "?"}`,
      );
      parts.push(`    premise: ${t.premise}`);
    }
  }
  parts.push(`</recently_fired>`);

  parts.push(`<invalidated_threads>`);
  if (state.invalidatedThreads.length === 0) {
    parts.push(`(none)`);
  } else {
    for (const t of state.invalidatedThreads) {
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
```

- [ ] **Step 2: Verify compile**

Run: `pnpm check`
Expected: PASS — depends on Task 1's types being merged.

If `nanoid` is not yet a dependency, install it:

```bash
pnpm --filter @marinara-engine/server add nanoid
```

Then re-run `pnpm check`.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/agents/thread-weaver.ts packages/server/package.json pnpm-lock.yaml
git commit -m "feat(agents): add thread-weaver service module (pure state mutations)"
```

---

### Task 5: Register thread-weaver in agent-executor.ts and inject memory blocks

**Files:**
- Modify: `packages/server/src/services/agents/agent-executor.ts`

- [ ] **Step 1: Add `thread-weaver` to result type map and JSON agents set**

In `packages/server/src/services/agents/agent-executor.ts`:

Add to `AGENT_RESULT_TYPE_MAP` (around line 907-931):

```ts
  "secret-plot-driver": "secret_plot",
  "thread-weaver": "thread_weaver_update",
};
```

Add to `JSON_AGENTS` set (around line 933-955):

```ts
  "secret-plot-driver",
  "thread-weaver",
]);
```

- [ ] **Step 2: Inject Thread Weaver context blocks into the agent prompt builder**

In the same file, find the agent context builder function (the section building agent prompt parts around line 897 — where `_secretPlotState` is injected). Add a new injection block right after the secret_plot_state block:

```ts
  if (context.memory._secretPlotState) {
    parts.push(`<secret_plot_state>`);
    parts.push(JSON.stringify(context.memory._secretPlotState));
    parts.push(`</secret_plot_state>`);
  }

  // Thread Weaver — inject pre-serialized state from the routes layer.
  // The routes layer (generate.routes.ts) puts the serialized blocks under this key
  // after running thread-weaver.preparePrePass + serializeAgentContext.
  if (context.memory._threadWeaverContext) {
    parts.push(context.memory._threadWeaverContext as string);
  }
```

- [ ] **Step 3: Treat parse errors as failures (not silent successes)**

In the same file, find `parseAgentResponse` (around line 960-975). Change the parse-error fallback so it returns a *failure* signal that the caller can use to mark the run failed. Replace:

```ts
  if (JSON_AGENTS.has(agentType)) {
    try {
      const jsonStr = extractJson(responseText);
      const data = JSON.parse(jsonStr);
      return { type: resultType, data };
    } catch {
      return { type: resultType, data: { raw: responseText, parseError: true } };
    }
  }
```

with:

```ts
  if (JSON_AGENTS.has(agentType)) {
    try {
      const jsonStr = extractJson(responseText);
      const data = JSON.parse(jsonStr);
      return { type: resultType, data };
    } catch (err) {
      // Surface a structured parse error rather than a silent success.
      // The caller should detect the parseError flag and mark the run failed.
      return {
        type: resultType,
        data: { raw: responseText, parseError: true, errorMessage: err instanceof Error ? err.message : String(err) },
      };
    }
  }
```

Then find the call site that consumes `parseAgentResponse`'s result (search this file for `parseAgentResponse(`). At that call site, after parsing, set `success: false` when `data.parseError === true`. Example pattern (adapt to the local variable names):

```ts
      const parsed = parseAgentResponse(agent.type, responseText);
      const parseFailed =
        typeof parsed.data === "object" && parsed.data !== null && (parsed.data as { parseError?: boolean }).parseError === true;
      const result: AgentResult = {
        agentId: agent.id,
        agentType: agent.type,
        type: parsed.type,
        data: parsed.data,
        tokensUsed,
        durationMs,
        success: !parseFailed,
        error: parseFailed
          ? `Failed to parse agent response: ${(parsed.data as { errorMessage?: string }).errorMessage ?? "invalid JSON"}`
          : null,
      };
```

If the existing code already builds `AgentResult` slightly differently, integrate the `parseFailed` check into the existing builder rather than duplicating it.

- [ ] **Step 4: Verify compile**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/agents/agent-executor.ts
git commit -m "feat(agents): register thread-weaver in executor + treat JSON parse errors as failures"
```

---

### Task 6: Wire Thread Weaver pre-pass and context serialization in generate.routes.ts

**Files:**
- Modify: `packages/server/src/routes/generate.routes.ts`

This task wires the **new-message branch** of generate.routes.ts: runs the deterministic pre-pass before the agent pipeline executes, serializes the context, and parks it on `agentContext.memory._threadWeaverContext` for the executor to inject.

- [ ] **Step 1: Import the thread-weaver service at the top of the file**

Near the existing imports (top of file), add:

```ts
import {
  preparePrePass,
  readState,
  serializeAgentContext,
  toMemoryEntries,
} from "../services/agents/thread-weaver.js";
```

- [ ] **Step 2: Add the pre-pass block right after the secret-plot-driver memory load**

Find the existing block at line 3475 that begins:

```ts
      // If the secret-plot-driver agent is enabled, load its previous state from agent memory
      const secretPlotAgent = resolvedAgents.find((a) => a.type === "secret-plot-driver");
      if (secretPlotAgent) {
        ...
      }
```

Add immediately after the closing brace of the `secretPlotAgent` block (around line 3490, before the next major section):

```ts
      // Thread Weaver — run deterministic pre-pass and serialize context for the agent.
      const threadWeaverAgent = resolvedAgents.find((a) => a.type === "thread-weaver");
      if (threadWeaverAgent) {
        try {
          const settings = parseExtra(threadWeaverAgent.settings);
          const rawMem = await agentsStore.getMemory(threadWeaverAgent.id, input.chatId);
          const initial = readState(rawMem);
          const afterPrePass = preparePrePass(initial);
          // Persist pre-pass mutations immediately so swipe/regen sees the right state.
          await agentsStore.setMemoryBatch(
            threadWeaverAgent.id,
            input.chatId,
            toMemoryEntries(afterPrePass),
          );
          // Serialize for the agent's prompt context.
          agentContext.memory._threadWeaverContext = serializeAgentContext(afterPrePass);
          // Also stash the post-pre-pass state for the post-pass step (avoids a re-read).
          agentContext.memory._threadWeaverState = afterPrePass;
          agentContext.memory._threadWeaverSettings = settings;
        } catch (err) {
          logger.error(err, "[thread-weaver] Pre-pass failed");
          // Do not block generation; agent will run without state context.
        }
      }
```

`parseExtra` is already imported in this file (used elsewhere) — verify it handles the `settings` JSON shape, otherwise use `JSON.parse(threadWeaverAgent.settings ?? "{}")` directly.

- [ ] **Step 3: Verify compile**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/generate.routes.ts
git commit -m "feat(agents): wire Thread Weaver pre-pass and context serialization"
```

---

### Task 7: Wire regen-branch exclusion for Thread Weaver

**Files:**
- Modify: `packages/server/src/routes/generate.routes.ts`

Mirror the Secret Plot Driver pattern — Thread Weaver runs only on new user messages, never on swipes/regens. The state from the original generation is reused.

- [ ] **Step 1: Add inline exclusion to the regen branch's `pipeline.preGenerate` call**

Find the call at line ~4404:

```ts
            contextInjections = await pipeline.preGenerate(
              (agentType) => !EXCLUDED_FROM_PIPELINE.has(agentType) && agentType !== "secret-plot-driver",
            );
```

Update to also exclude thread-weaver:

```ts
            contextInjections = await pipeline.preGenerate(
              (agentType) =>
                !EXCLUDED_FROM_PIPELINE.has(agentType) &&
                agentType !== "secret-plot-driver" &&
                agentType !== "thread-weaver",
            );
```

Find the matching results filter immediately below (around line 4409-4414):

```ts
            const regenPreGenResults = pipeline.results.filter(
              (r) =>
                r.agentType !== "knowledge-retrieval" &&
                r.agentType !== "knowledge-router" &&
                r.agentType !== "secret-plot-driver",
            );
```

Update to also exclude thread-weaver:

```ts
            const regenPreGenResults = pipeline.results.filter(
              (r) =>
                r.agentType !== "knowledge-retrieval" &&
                r.agentType !== "knowledge-router" &&
                r.agentType !== "secret-plot-driver" &&
                r.agentType !== "thread-weaver",
            );
```

- [ ] **Step 2: Verify compile**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/routes/generate.routes.ts
git commit -m "feat(agents): exclude thread-weaver from regen/swipe pipeline"
```

---

### Task 8: Wire Thread Weaver post-pass + persist + age-out

**Files:**
- Modify: `packages/server/src/routes/generate.routes.ts`

After the agent pipeline returns its results, parse the Thread Weaver result, apply firing decisions, plant new threads, age out windows, and persist via `setMemoryBatch`.

- [ ] **Step 1: Import the additional service helpers**

Update the existing thread-weaver import at the top of the file:

```ts
import {
  ageOutWindows,
  applyDecisions,
  buildMainPromptBlocks,
  preparePrePass,
  readState,
  serializeAgentContext,
  toMemoryEntries,
  type FiringDecision,
  type NewThreadInput,
} from "../services/agents/thread-weaver.js";
```

- [ ] **Step 2: Add the post-pass block after the secret-plot-driver post-pass**

Find the secret-plot-driver post-pass at line 4294 that begins:

```ts
        // ── Secret Plot Driver: persist fresh state + build injection ──
        const plotResult = preGenResults.find((r) => r.type === "secret_plot");
```

Add immediately after the closing brace of that whole `if (plotResult?.success && ...)` block (around line 4333):

```ts
        // ── Thread Weaver: parse result, apply decisions, persist, build injection ──
        const twResult = preGenResults.find((r) => r.type === "thread_weaver_update");
        // Track injection blocks for later prompt construction.
        let twSceneDirective: string | undefined;
        let twMeanwhileCutaway: string | undefined;
        if (threadWeaverAgent) {
          const settings = (agentContext.memory._threadWeaverSettings as Record<string, unknown>) ?? {};
          let stateAfterAgent =
            (agentContext.memory._threadWeaverState as ReturnType<typeof readState>) ??
            readState(await agentsStore.getMemory(threadWeaverAgent.id, input.chatId));

          if (twResult?.success && twResult.data && typeof twResult.data === "object") {
            const data = twResult.data as {
              newThreads?: NewThreadInput[];
              firingDecisions?: FiringDecision[];
            };
            const decisions = Array.isArray(data.firingDecisions) ? data.firingDecisions : [];
            const plants = Array.isArray(data.newThreads) ? data.newThreads : [];

            try {
              const applied = applyDecisions(stateAfterAgent, decisions, plants, settings);
              stateAfterAgent = ageOutWindows(applied.state, settings);

              const blocks = buildMainPromptBlocks(applied.firingsThisTurn);
              twSceneDirective = blocks.sceneDirective;
              twMeanwhileCutaway = blocks.meanwhileCutaway;

              await agentsStore.setMemoryBatch(
                threadWeaverAgent.id,
                input.chatId,
                toMemoryEntries(stateAfterAgent),
              );
              logger.debug(
                `[thread-weaver] Post-pass: ${plants.length} new, ${decisions.length} decisions, ${applied.firingsThisTurn.length} firings injected`,
              );
            } catch (twErr) {
              logger.error(twErr, "[thread-weaver] Post-pass failed");
            }
          } else if (twResult && !twResult.success) {
            // Agent failed — keep firing-status threads queued for next turn.
            // No new firings this turn. State already persisted in pre-pass.
            logger.warn(`[thread-weaver] Agent failed; firings deferred. Error: ${twResult.error ?? "unknown"}`);
          }
        }
```

- [ ] **Step 3: Verify compile**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/generate.routes.ts
git commit -m "feat(agents): wire Thread Weaver post-pass and persist via setMemoryBatch"
```

---

### Task 9: Inject scene_directive and meanwhile_cutaway into the main model prompt

**Files:**
- Modify: `packages/server/src/routes/generate.routes.ts`

The blocks built in Task 8 (`twSceneDirective`, `twMeanwhileCutaway`) need to be injected as system messages immediately before the last user message in `finalMessages`.

- [ ] **Step 1: Add the injection right after the existing secret-plot injection**

Find the closing brace of the existing secret-plot-driver arc/directions injection (around line 4596 — `} catch (plotInjectErr) { ... }` block). Add immediately after it:

```ts
      // ────────────────────────────────────────
      // Thread Weaver: inject scene_directive (on-scene firings) and
      // meanwhile_cutaway (off-scene firings) immediately before the last user message.
      // ────────────────────────────────────────
      if (twSceneDirective || twMeanwhileCutaway) {
        const lastUserIdx = findLastIndex(finalMessages, "user");
        const insertAt = lastUserIdx >= 0 ? lastUserIdx : finalMessages.length;
        const blocks: Array<{ role: "system"; content: string }> = [];
        if (twMeanwhileCutaway) {
          // Cutaway first — it instructs the model to OPEN with the meanwhile.
          blocks.push({ role: "system", content: twMeanwhileCutaway });
        }
        if (twSceneDirective) {
          blocks.push({ role: "system", content: twSceneDirective });
        }
        finalMessages.splice(insertAt, 0, ...blocks);
      }
```

`findLastIndex` is the same helper already used by the secret-plot-driver block — verify it's in scope (it's defined locally in this route file).

- [ ] **Step 2: Verify compile**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Manual verification milestone**

This is the first end-to-end verification point. Server should now drive the full Thread Weaver loop:

1. Run: `pnpm db:push` (in case schema changed — should be no-op).
2. Run: `pnpm dev` (or whichever script starts the dev server).
3. In a browser session, enable Thread Weaver via the agent picker (the existing UI lets you toggle built-ins).
4. Send a few user messages in a chat. Confirm:
   - Server logs show `[thread-weaver] Post-pass: ...` lines.
   - In SQLite (or whichever DB), `agent_memory` has rows for the Thread Weaver agent with keys `activeThreads`, `turnCounter`, etc.
   - After 3-10 turns, threads start firing — check the model's response for unprompted plot beats.
5. Try swiping a response — confirm the agent does NOT re-run on swipe (no new memory writes).
6. Try regenerating — same.

If something is wrong, fix and re-run before proceeding. Do NOT skip this step.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/generate.routes.ts
git commit -m "feat(agents): inject Thread Weaver scene_directive and meanwhile_cutaway blocks"
```

---

### Task 10: Add REST endpoints for manual Thread Weaver actions

**Files:**
- Modify: `packages/server/src/routes/agents.routes.ts`
- Modify: `packages/shared/src/types/agent.ts` (already has the types from Task 1)

Five endpoints support the UI: state read, manual plant, force-fire, manual invalidate, revive.

- [ ] **Step 1: Add the endpoints**

In `packages/server/src/routes/agents.routes.ts`, after the existing routes (around line 90+), add:

```ts
import { z } from "zod";
import {
  type FuseType,
  type PendingForceFire,
  type PlotThread,
  type ThreadCategory,
  type ThreadWeaverState,
  fuseTypeToTurns,
  THREAD_WEAVER_DEFAULT_SETTINGS,
} from "@marinara-engine/shared";
import { customAlphabet } from "nanoid";
import { readState, toMemoryEntries } from "../services/agents/thread-weaver.js";

const threadIdGen = customAlphabet("0123456789abcdef", 6);
const newThreadId = () => `thr_${threadIdGen()}`;

async function getThreadWeaverContext(
  storage: ReturnType<typeof createAgentsStorage>,
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

// ── Thread Weaver state read ──
app.get<{ Params: { chatId: string } }>("/thread-weaver/state/:chatId", async (req, reply) => {
  const ctx = await getThreadWeaverContext(storage, req.params.chatId);
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
  const ctx = await getThreadWeaverContext(storage, body.chatId);
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
  const ctx = await getThreadWeaverContext(storage, body.chatId);
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
  const ctx = await getThreadWeaverContext(storage, body.chatId);
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
  const ctx = await getThreadWeaverContext(storage, body.chatId);
  if (!ctx) return reply.status(404).send({ error: "Thread Weaver agent not configured" });
  const exists = ctx.state.activeThreads.some((t) => t.id === body.threadId);
  if (!exists) return reply.status(404).send({ error: "Thread not found in active set" });
  // De-dup queued force-fires.
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
    const ctx = await getThreadWeaverContext(storage, chatId);
    if (!ctx) return reply.status(404).send({ error: "Thread Weaver agent not configured" });
    const next: ThreadWeaverState = {
      ...ctx.state,
      pendingForceFires: ctx.state.pendingForceFires.filter((f) => f.threadId !== threadId),
    };
    await storage.setMemoryBatch(ctx.agentId, chatId, toMemoryEntries(next));
    return reply.status(204).send();
  },
);
```

- [ ] **Step 2: Verify compile**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/routes/agents.routes.ts
git commit -m "feat(agents): add Thread Weaver REST endpoints (state/plant/invalidate/revive/force-fire)"
```

---

### Task 11: Add Thread Weaver slice to the client agent store

**Files:**
- Modify: `packages/client/src/stores/agent.store.ts`

- [ ] **Step 1: Add the state slice and setters**

In `packages/client/src/stores/agent.store.ts`:

Add an import for the shared types:

```ts
import type { AgentResult, CharacterCardFieldUpdate, ThreadWeaverState } from "@marinara-engine/shared";
```

Inside `interface AgentState`, add:

```ts
  threadWeaverState: ThreadWeaverState | null;
  threadWeaverChatId: string | null;
```

Add the corresponding setters in the actions section:

```ts
  setThreadWeaverState: (chatId: string, state: ThreadWeaverState) => void;
  clearThreadWeaverState: () => void;
```

In the store factory body, initialize:

```ts
  threadWeaverState: null,
  threadWeaverChatId: null,
```

And implement the setters:

```ts
  setThreadWeaverState: (chatId, state) => set({ threadWeaverState: state, threadWeaverChatId: chatId }),
  clearThreadWeaverState: () => set({ threadWeaverState: null, threadWeaverChatId: null }),
```

Make sure `reset` (if present at the bottom of the store) clears these too:

```ts
  reset: () =>
    set({
      // ... existing fields ...
      threadWeaverState: null,
      threadWeaverChatId: null,
    }),
```

- [ ] **Step 2: Verify compile**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/stores/agent.store.ts
git commit -m "feat(agents): add Thread Weaver slice to agent store"
```

---

### Task 12: Handle `thread_weaver_update` in the SSE stream

**Files:**
- Modify: `packages/client/src/hooks/use-generate.ts`

The agent-result SSE event arrives with `agentType: "thread-weaver"` and a `data` field — but the data is the agent's *raw* output (`{newThreads, firingDecisions}`), not the post-applied state. The post-applied state lives only in the DB. So when the client receives `thread_weaver_update`, it should re-fetch the state from the new `/thread-weaver/state/:chatId` endpoint.

(A future optimization: server can bundle the post-applied snapshot into the SSE payload. Out of scope for v1.)

- [ ] **Step 1: Add the agent-result branch and refetch helper**

In `packages/client/src/hooks/use-generate.ts`, find the existing `agent_result` switch case (lines 705 and 1476). Add a branch for `thread_weaver_update` in BOTH copies (the streaming and non-streaming SSE handlers).

Inside the existing `case "agent_result":` block, after the existing `cyoa_choices` handling, add:

```ts
                if (result.resultType === "thread_weaver_update") {
                  // Re-fetch the post-applied state. The result.data here is the
                  // agent's raw JSON; the truth is in DB after the post-pass.
                  void fetch(`/api/agents/thread-weaver/state/${encodeURIComponent(chatId)}`)
                    .then((r) => (r.ok ? r.json() : null))
                    .then((state) => {
                      if (state) setThreadWeaverState(chatId, state);
                    })
                    .catch(() => {
                      /* swallow; UI will retry on next event */
                    });
                }
```

Add `setThreadWeaverState` to the destructured store selectors at the top of the hook (alongside `setCyoaChoices`):

```ts
  const setThreadWeaverState = useAgentStore((s) => s.setThreadWeaverState);
```

And include it in the dependencies array (around line 1443+):

```ts
      setCyoaChoices,
      clearCyoaChoices,
      enqueuePendingCardUpdate,
      setThreadWeaverState,
```

- [ ] **Step 2: Verify compile**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/hooks/use-generate.ts
git commit -m "feat(agents): handle thread_weaver_update SSE events on client"
```

---

### Task 13: Build the ThreadWeaverPanel component

**Files:**
- Create: `packages/client/src/components/agents/ThreadWeaverPanel.tsx`

A debug panel showing active threads (with action buttons), recently fired (read-only), graveyard (with revive), and a manual plant form.

- [ ] **Step 1: Create the panel component**

Create `packages/client/src/components/agents/ThreadWeaverPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useAgentStore } from "../../stores/agent.store.js";
import type {
  FuseType,
  PlotThread,
  ThreadCategory,
  ThreadWeaverState,
} from "@marinara-engine/shared";

interface Props {
  chatId: string;
}

const CATEGORY_COLORS: Record<ThreadCategory, string> = {
  adversary: "bg-red-700",
  social: "bg-pink-600",
  mystery: "bg-purple-700",
  opportunity: "bg-emerald-600",
  environment: "bg-amber-600",
  internal: "bg-sky-600",
};

const FUSE_LABEL: Record<FuseType, string> = {
  immediate: "🔥 1",
  short: "⏳ 3",
  long: "⏳ 10",
};

export function ThreadWeaverPanel({ chatId }: Props) {
  const state = useAgentStore((s) => s.threadWeaverState);
  const stateChatId = useAgentStore((s) => s.threadWeaverChatId);
  const setThreadWeaverState = useAgentStore((s) => s.setThreadWeaverState);
  const [showPlantForm, setShowPlantForm] = useState(false);
  const [showFired, setShowFired] = useState(false);
  const [showGraveyard, setShowGraveyard] = useState(false);

  // Fetch state on mount or chat change.
  useEffect(() => {
    if (!chatId) return;
    if (stateChatId === chatId && state) return;
    void fetch(`/api/agents/thread-weaver/state/${encodeURIComponent(chatId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s: ThreadWeaverState | null) => {
        if (s) setThreadWeaverState(chatId, s);
      })
      .catch(() => {});
  }, [chatId, state, stateChatId, setThreadWeaverState]);

  if (!state || stateChatId !== chatId) {
    return <div className="p-3 text-sm text-gray-400">Loading Thread Weaver state…</div>;
  }

  const refresh = async () => {
    const r = await fetch(`/api/agents/thread-weaver/state/${encodeURIComponent(chatId)}`);
    if (r.ok) {
      const s = (await r.json()) as ThreadWeaverState;
      setThreadWeaverState(chatId, s);
    }
  };

  const onForceFire = async (threadId: string, mode: "on_scene" | "off_scene") => {
    await fetch(`/api/agents/thread-weaver/force-fire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, threadId, mode }),
    });
    await refresh();
  };

  const onInvalidate = async (threadId: string) => {
    if (!confirm("Invalidate this thread?")) return;
    await fetch(`/api/agents/thread-weaver/invalidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, threadId, reason: "manually invalidated" }),
    });
    await refresh();
  };

  const onRevive = async (threadId: string) => {
    const choice = prompt("Revive with fuse type? (immediate / short / long)", "short") as FuseType | null;
    if (!choice || !["immediate", "short", "long"].includes(choice)) return;
    await fetch(`/api/agents/thread-weaver/revive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, threadId, fuseType: choice }),
    });
    await refresh();
  };

  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="font-semibold">Thread Weaver</h3>
        <span className="text-xs text-gray-400">turn {state.turnCounter}</span>
      </header>

      <section>
        <div className="mb-1 flex items-center justify-between">
          <h4 className="font-medium">Active threads ({state.activeThreads.length}/5)</h4>
          <button
            type="button"
            className="text-xs underline"
            onClick={() => setShowPlantForm((v) => !v)}
          >
            {showPlantForm ? "Cancel" : "+ Plant"}
          </button>
        </div>
        {showPlantForm && <PlantForm chatId={chatId} onPlanted={refresh} onClose={() => setShowPlantForm(false)} />}
        {state.activeThreads.length === 0 ? (
          <div className="text-gray-500">No active threads.</div>
        ) : (
          <ul className="flex flex-col gap-2">
            {state.activeThreads.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                queued={state.pendingForceFires.find((f) => f.threadId === t.id)?.mode}
                onForceFireOn={() => onForceFire(t.id, "on_scene")}
                onForceFireOff={() => onForceFire(t.id, "off_scene")}
                onInvalidate={() => onInvalidate(t.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <button
          type="button"
          className="w-full text-left font-medium"
          onClick={() => setShowFired((v) => !v)}
        >
          {showFired ? "▼" : "▶"} Recently fired ({state.recentlyFired.length})
        </button>
        {showFired && (
          <ul className="mt-1 flex flex-col gap-1">
            {state.recentlyFired.map((t) => (
              <li key={t.id} className="text-xs text-gray-300">
                <span className={`mr-2 inline-block rounded px-1 ${CATEGORY_COLORS[t.category]}`}>{t.category}</span>
                {t.premise}
                <span className="ml-2 text-gray-500">
                  fired turn {t.firedAtTurn ?? "?"} · {t.resolutionMode ?? "?"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <button
          type="button"
          className="w-full text-left font-medium"
          onClick={() => setShowGraveyard((v) => !v)}
        >
          {showGraveyard ? "▼" : "▶"} Graveyard ({state.invalidatedThreads.length})
        </button>
        {showGraveyard && (
          <ul className="mt-1 flex flex-col gap-1">
            {state.invalidatedThreads.map((t) => (
              <li key={t.id} className="text-xs text-gray-300">
                <span className={`mr-2 inline-block rounded px-1 ${CATEGORY_COLORS[t.category]}`}>{t.category}</span>
                <span className="line-through">{t.premise}</span>
                <button type="button" className="ml-2 underline" onClick={() => onRevive(t.id)}>
                  Revive
                </button>
                {t.reason && <div className="ml-6 text-gray-500">reason: {t.reason}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface ThreadRowProps {
  thread: PlotThread;
  queued?: "on_scene" | "off_scene";
  onForceFireOn: () => void;
  onForceFireOff: () => void;
  onInvalidate: () => void;
}

function ThreadRow({ thread, queued, onForceFireOn, onForceFireOff, onInvalidate }: ThreadRowProps) {
  return (
    <li className="rounded border border-gray-700 p-2">
      <div className="mb-1 flex items-center gap-2">
        <span className={`rounded px-1 text-xs ${CATEGORY_COLORS[thread.category]}`}>{thread.category}</span>
        <span className="text-xs">{FUSE_LABEL[thread.fuseType]}</span>
        <span className="text-xs text-gray-400">fuse: {thread.fuseTurns}</span>
        {thread.evolutionCount > 0 && <span className="text-xs text-gray-400">↻ {thread.evolutionCount}</span>}
        {queued && <span className="text-xs text-yellow-400">queued ({queued})</span>}
      </div>
      <div className="text-sm">{thread.premise}</div>
      <div className="text-xs text-gray-400">payoff: {thread.payoffHint}</div>
      <div className="mt-2 flex gap-2 text-xs">
        <button type="button" className="underline" onClick={onForceFireOn}>
          Fire on-scene
        </button>
        <button type="button" className="underline" onClick={onForceFireOff}>
          Fire off-scene
        </button>
        <button type="button" className="underline text-red-400" onClick={onInvalidate}>
          Invalidate
        </button>
      </div>
    </li>
  );
}

interface PlantFormProps {
  chatId: string;
  onPlanted: () => void;
  onClose: () => void;
}

function PlantForm({ chatId, onPlanted, onClose }: PlantFormProps) {
  const [category, setCategory] = useState<ThreadCategory>("mystery");
  const [premise, setPremise] = useState("");
  const [payoffHint, setPayoffHint] = useState("");
  const [fuseType, setFuseType] = useState<FuseType>("short");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!premise.trim() || !payoffHint.trim()) return;
    setSubmitting(true);
    const r = await fetch(`/api/agents/thread-weaver/plant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, category, premise, payoffHint, fuseType, seedSource: "scene" }),
    });
    setSubmitting(false);
    if (r.ok) {
      onPlanted();
      onClose();
    } else {
      const err = await r.json().catch(() => ({ error: "unknown" }));
      alert(`Plant failed: ${err.error ?? "unknown"}`);
    }
  };

  return (
    <div className="mb-2 flex flex-col gap-2 rounded border border-gray-700 p-2">
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value as ThreadCategory)}
        className="rounded bg-gray-800 px-1 py-0.5 text-xs"
      >
        {(["adversary", "social", "mystery", "opportunity", "environment", "internal"] as ThreadCategory[]).map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <textarea
        placeholder="Premise (1 sentence)"
        value={premise}
        onChange={(e) => setPremise(e.target.value)}
        className="rounded bg-gray-800 px-1 py-0.5 text-xs"
        rows={2}
      />
      <textarea
        placeholder="Payoff hint (1 sentence)"
        value={payoffHint}
        onChange={(e) => setPayoffHint(e.target.value)}
        className="rounded bg-gray-800 px-1 py-0.5 text-xs"
        rows={2}
      />
      <select
        value={fuseType}
        onChange={(e) => setFuseType(e.target.value as FuseType)}
        className="rounded bg-gray-800 px-1 py-0.5 text-xs"
      >
        <option value="immediate">immediate (1 turn)</option>
        <option value="short">short (3 turns)</option>
        <option value="long">long (10 turns)</option>
      </select>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={submitting}
          className="rounded bg-emerald-700 px-2 py-1 text-xs"
          onClick={submit}
        >
          {submitting ? "Planting…" : "Plant"}
        </button>
        <button type="button" className="rounded bg-gray-700 px-2 py-1 text-xs" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
```

> **Note on styling:** the tailwind classes above match the rough aesthetic of `AgentThoughtBubbles` — dark theme, small text, tight spacing. If the project has a shared Button/Card primitive, swap the raw `<button>` / `<div className="rounded border …">` elements for those primitives. Check `packages/client/src/components/ui/` (if present) before merging.

- [ ] **Step 2: Verify compile**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/components/agents/ThreadWeaverPanel.tsx
git commit -m "feat(agents): add ThreadWeaverPanel debug component"
```

---

### Task 14: Wire ThreadWeaverPanel into ChatSettingsDrawer

**Files:**
- Modify: `packages/client/src/components/chat/ChatSettingsDrawer.tsx`

The drawer is large (~5000 lines). The wiring is small: import the panel, render it where other agent debug surfaces live (look for existing `AgentThoughtBubbles` or agent-related sections to find the right section).

- [ ] **Step 1: Find the agent-debug section in ChatSettingsDrawer**

Search the file for an existing agent-debug surface to anchor against. Likely candidates: an `AgentThoughtBubbles` reference, a "Debug" tab/section, or a block conditional on a debug-toggle setting.

```bash
# Run from project root in your shell to find the right spot:
grep -n "AgentThoughtBubbles\|agentDebug\|Debug" packages/client/src/components/chat/ChatSettingsDrawer.tsx
```

- [ ] **Step 2: Add the import and render the panel**

At the top of `ChatSettingsDrawer.tsx`, add:

```tsx
import { ThreadWeaverPanel } from "../agents/ThreadWeaverPanel.js";
```

Find the section where `AgentThoughtBubbles` is rendered (or wherever per-agent debug UIs live in this drawer). Add the panel adjacent, gated by whether the Thread Weaver agent is enabled in the current chat. Pseudocode pattern (adapt to the actual shape — agent enablement may already be available via a hook in scope):

```tsx
{threadWeaverEnabled && currentChatId && (
  <section className="border-t border-gray-700">
    <ThreadWeaverPanel chatId={currentChatId} />
  </section>
)}
```

If `threadWeaverEnabled` is not already in scope, derive it the same way the file derives other built-in agent enablement (look for similar checks for `secret-plot-driver`, `cyoa`, or `echo-chamber`).

- [ ] **Step 3: Verify compile**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Manual end-to-end verification milestone**

1. Run `pnpm dev` (or whichever script starts the full stack).
2. In a chat with Thread Weaver enabled:
   - Open the chat settings drawer; confirm the ThreadWeaverPanel appears and shows the current state.
   - Click `+ Plant`, fill the form, submit. Confirm the new thread appears in the active list.
   - Click `Fire on-scene` on a thread. Confirm the queued indicator appears. Send a user message. Confirm the next assistant response weaves the thread in.
   - Click `Invalidate` on a thread. Confirm it moves to the graveyard.
   - Expand the graveyard, click `Revive` on an invalidated thread, pick a fuse type. Confirm it returns to active.
   - Send a few messages and let fuses count down; confirm threads at fuse=0 fire automatically (via the LLM) and end up in `recentlyFired`.
   - Try a swipe — confirm the panel state does NOT change on swipe (state is locked until next user message).
3. If anything is wrong, fix and re-run before merging.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/chat/ChatSettingsDrawer.tsx
git commit -m "feat(agents): render ThreadWeaverPanel in ChatSettingsDrawer"
```

---

### Task 15: Documentation pass

**Files:**
- Modify: `README.md` (the AI Agent System section)
- Modify: `docs/CONFIGURATION.md` (if it lists individual agents)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a brief description in README's AI Agent System section**

Locate the README's AI Agent System bullet list (the section referenced in the Table of Contents at the top of `README.md`). Add a bullet:

```md
- **Thread Weaver** — Drives narrative through structured plot threads with timed fuses. Each thread has a category (adversary, social, mystery, opportunity, environment, internal), a fuse (immediate / short / long), and resolves on-scene, off-scene as a "meanwhile" cutaway, by evolving (revise + re-fuse), or by silent invalidation. Pairs well with Automated Chat Summary on long chats; complements Secret Plot Driver as the tactical layer to its strategic arc.
```

- [ ] **Step 2: Add a CHANGELOG entry**

Follow the existing CHANGELOG format. Add under the Unreleased section (or whichever section reflects the next version):

```md
### Added
- **Thread Weaver agent** — new built-in pre-generation agent that drives narrative through structured plot threads with timed fuses. Plants threads in 6 categories (adversary, social, mystery, opportunity, environment, internal), fires/evolves/invalidates them when fuses expire, and supports off-screen "meanwhile" cutaways. Includes a debug-drawer panel for active threads, a graveyard with revive, and manual planting/force-fire. Pairs with Secret Plot Driver as the tactical layer to its strategic arc.
```

- [ ] **Step 3: Verify**

Run: `pnpm check`
Expected: PASS (markdown changes don't affect the type check, but the lint pass is cheap and will catch any TS regressions from earlier tasks).

Run: `pnpm version:check` if README references release-version material — confirm nothing slipped.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document Thread Weaver agent in README and CHANGELOG"
```

(If `docs/CONFIGURATION.md` has an agent-list section, also include it in the same commit.)

---

## Self-review

**Spec coverage scan:**

| Spec section | Implemented in |
|---|---|
| Identity table (type id, name, phase, etc.) | Task 1 |
| `ThreadCategory` (6 categories) | Task 1 |
| `FuseType` (immediate/short/long) | Task 1 |
| `ThreadStatus` (planted/firing/fired/invalidated) | Task 1 |
| `SeedSource` | Task 1 |
| `PlotThread` shape (incl. evolutionHistory cap) | Task 1, 4 (cap enforced via `.slice(-5)` in `applyDecisions`) |
| Memory keys (`activeThreads`, `recentlyFired`, etc.) | Task 4 (`readState` / `toMemoryEntries`) |
| Pre-pass: drain pending → archive, increment, decrement, mark firing | Task 4 (`preparePrePass`), Task 6 (wiring) |
| `<active_threads>`, `<firing_now>`, `<recently_fired>`, `<turn_counter>` blocks | Task 4 (`serializeAgentContext`), Task 5 (executor injection) |
| LLM JSON schema (`newThreads`, `firingDecisions`) | Task 2 (prompt template), Task 4 (`FiringDecision`/`NewThreadInput` types) |
| `fire_on_scene` resolution | Task 4 (`applyDecisions`), Task 8 (post-pass), Task 9 (injection) |
| `fire_off_scene` resolution + meanwhile_cutaway | Task 4 (`buildMainPromptBlocks`), Task 9 |
| `evolve` (revise + re-fuse, unlimited) | Task 4 (`applyDecisions` evolve branch) |
| `invalidate` (graveyard) | Task 4, Task 10 (manual endpoint), Task 13 (UI) |
| Hard cap of 5 active threads | Task 4 (enforced in `applyDecisions`), Task 10 (enforced on manual plant/revive) |
| Firings-per-turn cap of 2 | Task 4 (`firingsAccepted` counter) |
| Diversity = soft prompt nudge only | Task 2 (prompt) — no server-side cap, by design |
| Pending-firing deferred archival (swipe-safe) | Task 4 (`preparePrePass` drains *previous* turn's pending), Task 7 (regen exclusion preserves state) |
| Failure handling: skip + queue + toast | Task 5 (parse-error fix), Task 8 (failure log + no firing this turn). Toast surfaces via existing agent-result SSE with `success: false` — no new client wiring needed. |
| Non-critical agent | Task 8 — Thread Weaver result is NOT added to the existing `criticalFailed` filter at line 4277. |
| `<scene_directive>` injected before chat history | Task 9 |
| `<meanwhile_cutaway>` injected before chat history | Task 9 |
| Coexistence with Secret Plot Driver | Task 1 (both registered), Task 9 (additive injection — neither replaces the other), Task 2 (prompt instructs Thread Weaver to serve any present `<overarching_arc>`) |
| Built-in auto-install via `BUILT_IN_AGENTS` | Task 1 |
| Per-agent settings (`maxActiveThreads`, fuse turns, etc.) | Task 1 (`THREAD_WEAVER_DEFAULT_SETTINGS`, `getDefaultBuiltInAgentSettings`) |
| UI: active threads panel | Task 13 |
| UI: recently fired collapsible | Task 13 |
| UI: graveyard collapsible + revive | Task 13 |
| UI: manual plant form | Task 13 |
| UI: force-fire (queue through agent) | Task 10 (endpoint), Task 13 (button) |
| Recently-fired window: 30 turns | Task 4 (`ageOutWindows`) |
| Invalidated window: 30 turns | Task 4 (`ageOutWindows`) |
| Atomic batched persistence | Task 3 (`setMemoryBatch`), Task 4 (`toMemoryEntries`), Task 8 (used in post-pass) |
| Documentation pass (README, CHANGELOG) | Task 15 |

All spec requirements covered.

**Placeholder scan:** no TBD/TODO/"implement later" markers. Each step contains the actual code or exact command. The two manual-verification milestones (Task 9 step 3, Task 14 step 4) describe specific user-visible checks rather than vague "verify it works."

**Type consistency check:**
- `PlotThread` shape used identically across Tasks 1, 4, 10 (REST routes), 13 (UI) — no field mismatches.
- `FiringDecision` defined in Task 4 (`thread-weaver.ts`); referenced by name in Task 8 — same definition, no drift.
- `ThreadWeaverState` used as the canonical aggregate type across server (Task 4, 8, 10) and client (Task 11, 13) — single source of truth in `@marinara-engine/shared`.
- `fuseTypeToTurns` defined in Task 1 (shared types); used in Task 4 (`applyDecisions`, `evolve` branch) and Task 10 (manual plant/revive). Same signature throughout.
- Memory keys referenced consistently: `activeThreads`, `recentlyFired`, `invalidatedThreads`, `pendingFiring`, `pendingForceFires`, `turnCounter` — defined in Task 4's `toMemoryEntries`/`readState` pair and used everywhere else through those helpers (no string-key duplication).

No drift found. Plan is ready to execute.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-01-thread-weaver.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
