# Thread Weaver Agent — Design Spec

**Date:** 2026-05-01
**Status:** Design approved, ready for implementation plan
**Replaces (soft):** Secret Plot Driver (existing built-in agent — kept enabled, both can run together)

---

## Summary

Thread Weaver is a new built-in pre-generation agent that drives narrative through **structured, timed plot threads** rather than freeform plot prose. Each thread carries a category, a premise, a payoff hint, and a fuse (turn count). When fuses hit zero, the agent decides per-thread whether to fire on-scene, fire as an off-screen "meanwhile" cutaway, evolve (revise + re-fuse), or invalidate.

The agent is designed to coexist with Secret Plot Driver as a tactical layer (per-turn threads) under the strategic layer (long-term arc) that Secret Plot Driver provides.

---

## Identity

| Field | Value |
|---|---|
| Type id | `thread-weaver` |
| Name | "Thread Weaver" |
| Phase | `pre_generation` |
| Category | `writer` |
| Result type | `thread_weaver_update` |
| Default enabled | `false` (opt-in like every other built-in) |
| Default tools | `[]` (JSON-only output, no function calls) |
| Critical agent | **No** — failure does not block generation |
| Runs on | New user messages only (skipped on swipes/regens, like Secret Plot Driver) |

---

## Core data model

All state stored in `agentMemory` per `(agentId, chatId)`.

### Thread

```ts
type ThreadCategory =
  | "adversary"     // hostile intent — someone/something opposed
  | "social"        // relationships, reputation, alliances, romance
  | "mystery"       // unrevealed truth, unanswered question, secret
  | "opportunity"   // something positive to pursue
  | "environment"   // weather, location, world conditions, time pressure
  | "internal";     // NPC's doubt, growth, dilemma, moral conflict
                    // NEVER about the player persona — player agency is sacred

type FuseType = "immediate" | "short" | "long";  // 1 / 3 / 10 turns

type ThreadStatus =
  | "planted"       // fuse counting down
  | "firing"        // fuse hit 0, queued for resolution this turn
  | "fired"         // delivered, archived to recentlyFired
  | "invalidated";  // killed silently, archived to invalidatedThreads
// Note: evolve is an action, not a status. Evolved threads update in
// place and return to "planted" with a fresh fuse — there is no
// persisted "evolved" status.

type SeedSource = "scene" | "player_action" | "card_lore" | "off_screen";

interface PlotThread {
  id: string;                         // short id, e.g. "thr_a1b2c3"
  category: ThreadCategory;
  premise: string;                    // 1 sentence: what the thread is
  payoffHint: string;                 // 1 sentence: how it might fire (advisory)
  fuseType: FuseType;
  fuseTurns: number;                  // counts down each user-message turn
  plantedAtTurn: number;              // value of turnCounter at plant time
  status: ThreadStatus;
  seedSource: SeedSource;             // provenance — set at plant time
  evolutionCount: number;             // increments on each evolve (unbounded)
  evolutionHistory: Array<{           // capped at last 5 entries in storage
    fromPremise: string;              // (oldest entry dropped on overflow)
    fromPayoffHint: string;
    fromFuseType: FuseType;
    atTurn: number;
    reason: string;
  }>;
  resolutionMode?: "on_scene" | "off_scene";  // set when status="firing"
  finalizedDirection?: string;        // populated by agent at firing time
  reason?: string;                    // why invalidated/evolved (mandatory on those actions)
  firedAtTurn?: number;               // set on transition to "fired"
  invalidatedAtTurn?: number;         // set on transition to "invalidated"
}
```

### Memory keys

```ts
{
  activeThreads: PlotThread[];          // ≤ 5, status "planted" | "firing"
  recentlyFired: PlotThread[];          // status "fired", turn-windowed (last 30)
  invalidatedThreads: PlotThread[];     // status "invalidated", turn-windowed (last 30)
  pendingFiring: PendingFiring[];       // archive-deferred firings (see §Swipe handling)
  pendingForceFires: Array<{            // user-initiated force-fires queued for next agent run
    threadId: string;
    mode: "on_scene" | "off_scene";
  }>;
  turnCounter: number;                  // monotonic; deterministic source for fuses
}

interface PendingFiring {
  threadId: string;
  mode: "on_scene" | "off_scene";
  finalizedDirection: string;
  decidedAtTurn: number;                // when the agent made the decision
}
```

---

## Per-turn flow

Triggered by every new user message (skipped on swipes/regens — same exclusion pattern as Secret Plot Driver in `generate.routes.ts`).

### Step 1 — Pre-pass (deterministic, no LLM)

1. Drain previous turn's `pendingFiring` into `recentlyFired` (the previous assistant message is now committed — see §Swipe handling).
2. Increment `turnCounter`.
3. Decrement `fuseTurns` on every active thread.
4. Mark any thread with `fuseTurns ≤ 0` as `status: "firing"`.

### Step 2 — Build agent context

Inject the standard agent context (recent messages, persona, characters, `<chat_summary>` if present) plus four Thread-Weaver-specific blocks:

```xml
<active_threads>
  Each: id, category, premise, payoffHint, fuseTurns, status, evolutionCount
</active_threads>

<firing_now>
  IDs of threads queued to fire this turn (from pre-pass step 4).
  Plus any user-initiated force-fires from pendingForceFires.
</firing_now>

<recently_fired>
  All entries from recentlyFired (turn-windowed, last 30 turns).
  Each: id, category, premise (final), firedAtTurn, resolutionMode.
  Used for callbacks and to avoid re-issuing the same thread.
</recently_fired>

<turn_counter>N</turn_counter>
```

The `<chat_summary>` block is the long-horizon anchor; `<active_threads>` and `<recently_fired>` are the plot-machine state; `<recent_messages>` is the immediate beat.

### Step 3 — LLM call

Strict JSON output:

```json
{
  "newThreads": [
    {
      "category": "adversary | social | mystery | opportunity | environment | internal",
      "premise": "1 sentence",
      "payoffHint": "1 sentence — how this might fire",
      "fuseType": "immediate | short | long",
      "seedSource": "scene | player_action | card_lore | off_screen"
    }
  ],
  "firingDecisions": [
    {
      "id": "thr_a1b2",
      "action": "fire_on_scene | fire_off_scene | invalidate | evolve",

      "finalizedDirection": "1-2 sentences (required for fire_on_scene and fire_off_scene)",

      "newPremise": "(optional, evolve only)",
      "newPayoffHint": "(optional, evolve only)",
      "newFuseType": "immediate | short | long (required for evolve)",

      "reason": "1 sentence (required for invalidate and evolve)"
    }
  ]
}
```

**Decisions the agent must make for each thread in `<firing_now>`:** exactly one of `fire_on_scene`, `fire_off_scene`, `invalidate`, or `evolve`. Omitting a thread leaves it queued — server treats this as agent failure for that thread (see §Failure handling).

### Step 4 — Server post-pass

1. **Apply firing decisions** to threads in `<firing_now>`:
   - `fire_on_scene` → write `PendingFiring` entry with mode `on_scene` and `finalizedDirection`.
   - `fire_off_scene` → write `PendingFiring` entry with mode `off_scene` and `finalizedDirection`.
   - `evolve` → update thread in place: optional `premise`/`payoffHint` revisions, mandatory new `fuseType` (resets `fuseTurns` to the corresponding value), `evolutionCount += 1`, push entry to `evolutionHistory` (cap last 5 displayed entries), reset `status` to `"planted"`. **No cap on evolutions.**
   - `invalidate` → set `status: "invalidated"`, `invalidatedAtTurn: turnCounter`, move to `invalidatedThreads`.

2. **Apply user force-fires:** drain `pendingForceFires` — these are already represented as firing decisions the agent produced this turn (the agent saw them in `<firing_now>`). Clear the queue.

3. **Apply new threads** from `newThreads`:
   - Validate: each must have valid category, non-empty premise, non-empty payoffHint, valid fuseType, valid seedSource.
   - Generate `id` server-side (`thr_` + 6-char nanoid).
   - Set `plantedAtTurn: turnCounter`, `fuseTurns: {1|3|10 from fuseType}`, `status: "planted"`, `evolutionCount: 0`, `evolutionHistory: []`.
   - Hard cap: `activeThreads.length + newThreads.length ≤ 5`. Overflow drops oldest `planted` threads (not `firing`) by `plantedAtTurn`.
   - **No diversity cap server-side** — the prompt nudges category variety; the LLM owns the call.

4. **Cap firings-per-turn at 2.** If the agent produced more than 2 firing decisions, only the first 2 (by order in `firingDecisions`) become `pendingFiring`. The rest stay queued in `firing` status for next turn. Prevents prompt-overflow / model overwhelm.

5. **Age out `recentlyFired` and `invalidatedThreads`:** drop entries older than 30 turns (`turnCounter - firedAtTurn > 30` etc.). Configurable via agent settings.

6. **Persist all keys in one batched write** — see §Storage helper additions.

### Step 5 — Inject into main model prompt

For each entry in this turn's freshly-written `pendingFiring`:

**On-scene firings** are aggregated into a dedicated block injected as a system message **immediately before the last user message** (recency-weighted attention; distinct from `<context>`):

```xml
<scene_directive>
This turn, weave in the following plot beat(s):
- [finalizedDirection from thread #1]
- [finalizedDirection from thread #2]
</scene_directive>
```

**Off-scene firings** become a separate block, also injected immediately before the last user message:

```xml
<meanwhile_cutaway>
Begin your response with a brief "meanwhile, elsewhere…" cutaway (1–2 paragraphs, italicized) depicting:
[finalizedDirection from thread]
Then continue with the main scene the user is engaged in.
</meanwhile_cutaway>
```

**Coexistence with Secret Plot Driver:** if both agents are enabled, Secret Plot Driver's `<overarching_arc>` and `<scene_directions>` blocks remain in their existing positions (within `<lore>` for the arc; within `<context>` for directions). Thread Weaver's blocks are *additional*, distinct, and at a higher recency position. The Thread Weaver prompt explicitly instructs: *"If `<overarching_arc>` is present in your context, your threads should serve that arc, not contradict it."*

---

## Resolution semantics

### `fire_on_scene`

Inject the finalized direction into `<scene_directive>` for this turn's main generation. After main generation completes and the next user message arrives, the thread moves to `recentlyFired`.

### `fire_off_scene`

Inject the finalized direction into `<meanwhile_cutaway>`. Main model is instructed to render a 1–2 paragraph italicized cutaway at the start of its response, then continue with the user-facing scene. Same archive timing as on-scene.

**Soft rule in the prompt to prevent off-scene overuse:** *"Prefer on-scene firing when the current beat naturally accommodates the thread. Use off-scene only when the current beat is genuinely intimate, time-skipped, or unrelated to the thread."*

### `evolve`

The agent revises the thread to reflect how the story has shaped it. Behavior:

- `newPremise` and `newPayoffHint` are optional. Omit either to keep the existing value.
- `newFuseType` is mandatory — the thread re-fuses with `fuseTurns = {1, 3, 10}`.
- `evolutionCount` increments; the prior `(premise, payoffHint, fuseType)` is pushed to `evolutionHistory` with the `reason` and `atTurn`.
- `evolutionHistory` displays the last 5 entries in the UI; full count is preserved on `evolutionCount`.
- **No cap on evolutions.** Trust the LLM; the user audits via UI history.
- Anti-paraphrase rule (prompt-only): *"Evolution must reflect changes the story has imposed on the thread, not be retrofitted to match what is already happening this turn. If the current scene already contains the thread's payoff, fire it instead of evolving."*

### `invalidate`

Thread is killed. Moved to `invalidatedThreads` with `invalidatedAtTurn` and mandatory `reason`. **No cap on invalidations.** UI surfaces the graveyard with a revive button.

**Revive (UI-only):** user can pull a thread from `invalidatedThreads` back to `activeThreads`. User selects new `fuseType`. Thread returns with `status: "planted"`, `evolutionCount` and `evolutionHistory` preserved.

---

## Swipe / regen handling (deferred archival)

Direct fix for the Secret Plot Driver bug where firings were archived too early.

1. Pre-pass step 1 only drains the **previous turn's** `pendingFiring` into `recentlyFired`. By the time the new pre-pass runs, the assistant message that consumed those firings has been committed (the user just sent the next message).
2. Within a turn: agent decides → server writes `pendingFiring` → main model generates → response shows.
3. **If user swipes:** the regen path skips Thread Weaver entirely. This uses the same inline filter pattern as Secret Plot Driver — an explicit `agentType !== "thread-weaver"` check on the regen branch's `pipeline.preGenerate(...)` call (the existing pattern is at `generate.routes.ts:4405`). Note: this is *not* added to the global `EXCLUDED_FROM_PIPELINE` Set (which would also exclude it from the new-message path); it must be a regen-only inline filter. The regen reads `pendingFiring` from memory and re-injects the same `<scene_directive>` / `<meanwhile_cutaway>` blocks. Threads stay in `activeThreads` with `status: "firing"`. **No state mutation on swipe.**
4. **If user accepts the response (sends next user message):** next pre-pass step 1 drains `pendingFiring` to `recentlyFired`. Threads transition cleanly.
5. **If user closes chat mid-firing:** `pendingFiring` lives in DB (agentMemory), restored on reopen, drained when next user message lands.

This applies symmetrically to evolve and invalidate decisions: those are also written to memory on the agent's pre-gen pass and persist regardless of swipes (they don't have the same "consumed by main model" semantics — the state mutation already happened, swipes just regenerate the response).

---

## Failure handling

When the LLM call fails or returns malformed JSON, **do not block generation** (key fix vs. Secret Plot Driver, which is currently in `criticalFailed` at `generate.routes.ts:4277`).

Behavior on failure:

1. **Pre-pass already happened** — fuses are decremented, threads at fuse=0 are flagged `firing` in memory.
2. **No firing this turn.** No `pendingFiring` entries are written. `<scene_directive>` and `<meanwhile_cutaway>` blocks are not injected.
3. **No new threads planted.**
4. **Threads at `firing` status stay queued.** They remain `firing` across turns until a successful agent call resolves them. Self-correcting: when the agent works again, all queued firings get processed (subject to the firings-per-turn cap of 2; overflow stays queued).
5. **User sees a toast** matching the existing agent-failure UX (same surface as other agent errors — wired through the existing `agent_result` SSE event with `success: false`).

Parse errors are treated as failures, **not** silent successes. Direct fix for `agent-executor.ts:969` where parse-failed agents currently return `{raw, parseError: true}` and count as successful.

---

## UI surface

A new "Threads" panel in the chat-side debug drawer (alongside the existing `AgentThoughtBubbles`). Hidden behind the standard agent-debug toggle — power users only.

### Active threads panel

Each thread shows:
- Category badge (color-coded by category)
- Premise (1 line, truncated)
- Fuse chip: `🔥 1` (immediate, urgent), `⏳ 3` (short), `⏳ 10` (long), with current `fuseTurns` countdown
- Evolution count chip if `evolutionCount > 0` (e.g., `↻ 4`)
- Per-thread actions: **Force fire on-scene**, **Force fire off-scene**, **Invalidate**

### Recently fired panel (collapsible)

Last 30 turns of fired threads. Each shows premise, resolution mode, fired-at-turn. Read-only. Provides callback awareness for users.

### Graveyard panel (collapsible)

Last 30 turns of invalidated threads. Each shows premise, `reason`, invalidated-at-turn. Per-entry **Revive** button — user picks a fuseType, thread returns to active.

### Manual plant form

Inline form: category dropdown, premise textarea, payoffHint textarea, fuseType radio. On submit, thread is added directly to `activeThreads` (bypasses agent — the agent's next normal run will see it and handle firing decisions when its fuse hits zero).

### Force-fire semantics

User clicks force-fire on a thread → server writes `pendingForceFires` entry → thread chip shows "Will fire next turn" → next user message triggers normal agent run with the queued force-fire visible in `<firing_now>` → agent produces a context-aware `finalizedDirection`. User can click again to cancel before the next agent run drains it.

---

## Coexistence with Secret Plot Driver

Both built-in agents remain enabled and shippable. They serve different layers:

- **Secret Plot Driver** = strategic / long-arc layer (overarching arc, protagonist growth, multi-session mystery).
- **Thread Weaver** = tactical layer (per-turn threads, fuses, callbacks, immediate beats).

Users can enable either, both, or neither. When both run, Thread Weaver's prompt instructs it to serve the arc emitted by Secret Plot Driver (if present in `<overarching_arc>`).

**No deprecation flag, no UI mutex, no migration tool in v1.** Existing chats keep working. Users who prefer Thread Weaver simply disable Secret Plot Driver in their agent settings.

---

## Files to touch

### `packages/shared/`
- `src/types/agent.ts`
  - Add `BUILT_IN_AGENT_IDS.THREAD_WEAVER = "thread-weaver"`.
  - Add `BUILT_IN_AGENTS` entry: `{ id: "thread-weaver", name: "Thread Weaver", description: "…", phase: "pre_generation", enabledByDefault: false, category: "writer" }`.
  - Add `"thread_weaver_update"` to the `AgentResultType` union.
  - Add `"thread-weaver": []` to `DEFAULT_AGENT_TOOLS`.
- `src/constants/agent-prompts.ts`
  - Add `"thread-weaver"` default prompt template (drafted separately during plan execution).
- `src/schemas/agent.schema.ts`
  - Add `"thread_weaver_update"` to result-type enum.

### `packages/server/src/`
- `services/storage/agents.storage.ts`
  - Add `setMemoryBatch(agentConfigId, chatId, entries: Record<string, unknown>)` for atomic multi-key writes (uses `db.transaction`).
- `services/agents/agent-executor.ts`
  - Register `"thread-weaver"` in `AGENT_RESULT_TYPE_MAP` → `"thread_weaver_update"`.
  - Add `"thread-weaver"` to `JSON_AGENTS` set.
  - In the agent context builder (around line 897), add injection of `<active_threads>`, `<firing_now>`, `<recently_fired>`, `<turn_counter>` blocks reading from `context.memory`.
  - Fix parse-error handling: parse failures should mark the agent run as failed rather than returning `{raw, parseError: true}` as a success. Affects `parseAgentResponse` at line 960.
- `routes/generate.routes.ts`
  - Add Thread Weaver pre-pass: drain previous `pendingFiring` to `recentlyFired`, increment `turnCounter`, decrement fuses, mark `firing`.
  - Inject `pendingForceFires` into the agent context for the upcoming agent run.
  - Post-pass: parse `firingDecisions`, write new `pendingFiring`, apply evolves/invalidates, plant new threads with caps, age out windows, batch-persist.
  - Inject `<scene_directive>` and `<meanwhile_cutaway>` blocks immediately before the last user message in `finalMessages`.
  - Add an inline `agentType !== "thread-weaver"` filter on the regen branch's `pipeline.preGenerate(...)` call (mirrors the existing Secret Plot Driver pattern at line 4405). Do NOT add to the global `EXCLUDED_FROM_PIPELINE` Set — that would skip the agent on the new-message path too.
  - **Critical:** do NOT add `"thread_weaver_update"` to the `criticalFailed` filter at line 4277 — agent failure must not block generation.

### `packages/client/src/`
- `components/agents/ThreadWeaverPanel.tsx` — new panel: active threads, recently fired, graveyard, manual plant form.
- `stores/agent.store.ts` — wire `thread_weaver_update` SSE results into store state for the panel.
- `components/chat/ChatSettingsDrawer.tsx` (or wherever the agent debug UI lives) — register the new panel under the agent-debug toggle.

---

## Settings (per-agent, editable in Agent Editor)

Stored in `AgentConfig.settings: Record<string, unknown>`. Defaults baked into `getDefaultBuiltInAgentSettings("thread-weaver")`.

| Setting | Default | Purpose |
|---|---|---|
| `maxActiveThreads` | `5` | Hard cap on `activeThreads.length` |
| `firingsPerTurnCap` | `2` | Max firings injected per turn; overflow stays queued |
| `recentlyFiredWindowTurns` | `30` | Turn-based age-out for `recentlyFired` |
| `invalidatedWindowTurns` | `30` | Turn-based age-out for `invalidatedThreads` |
| `fuseTurnsImmediate` | `1` | Tunable fuse length for immediate type |
| `fuseTurnsShort` | `3` | Tunable fuse length for short type |
| `fuseTurnsLong` | `10` | Tunable fuse length for long type |

---

## Explicitly NOT in v1

- **Thread merging** (`merge` action — two threads collide into a more dramatic combined thread). Reserve verb name for v2.
- **Cross-chat thread persistence** (threads are per-chat, like all agent memory).
- **Importable / exportable thread packs** — separate larger feature for shareable user-defined agents.
- **Automatic migration from Secret Plot Driver state** — data shapes differ too much; users start fresh.
- **In-fiction time as a fuse unit** (e.g., "fire after 3 in-fiction days") — turns only for v1.
- **Thread Weaver feeding a separate Adversarial Agent** (Idea 2 from brainstorm) — follow-up project; the world-actor agent would *plant* threads through the same mechanism Thread Weaver uses.

---

## Open implementation notes for the plan

These are details to nail down during implementation, not architectural decisions:

1. **Default prompt template** — write the full text during plan execution. Will include: the 6 categories with examples, the action menu, the JSON output schema, the anti-paraphrase rule on evolve, the on-scene-preference rule, the no-internal-about-player rule, the diversity nudge.
2. **`setMemoryBatch` transaction shape** — confirm Drizzle's `db.transaction` API in this codebase; existing `setMemory` callers can opt into the batch helper later.
3. **Toast wiring for failures** — match the existing failed-agent toast pattern (see how Prose Guardian or Continuity surface failures; Thread Weaver follows the same path).
4. **Panel styling** — match `AgentThoughtBubbles` aesthetics; reuse existing badge/chip components from the design system.
5. **SSE event for thread state** — reuse the existing `agent_result` event with `agentType: "thread-weaver"` and the parsed `thread_weaver_update` payload.

---

## Decision log

For traceability when the plan is reviewed:

| # | Decision | User choice |
|---|---|---|
| 1 | Build new agent vs. fix Secret Plot Driver | New from scratch |
| 2 | Distance unit | Turns |
| 3 | Who plants threads | Agent (with category vocabulary for diversity) |
| 4 | Active thread cap | 5 |
| 5 | Fuse types | 3 (immediate=1, short=3, long=10) |
| 6 | LLM cadence | Every turn |
| 7 | Off-scene cutaway in v1 | Include |
| 8 | Pacing model | `evolve` action (revise + re-fuse) — no separate pacing field |
| 9 | Cap on evolutions | None |
| 10 | Evolve fuse | Constrained to the 3 fuse types |
| 11 | Swipe/regen archive timing | Deferred until next user message commits |
| 12 | Story summary access | Already provided via `AgentContext.chatSummary` |
| 13 | On-scene injection slot | New `<scene_directive>` block before chat history |
| 14 | Coexistence with Secret Plot Driver | Both run; different layers |
| 15 | Failure handling | Skip + queue + toast (graceful, non-critical) |
| 16 | Invalidation cap | None; UI graveyard with revive |
| 17 | Diversity cap | Soft prompt nudge only |
| 18 | Categories | 6 (adversary, social, mystery, opportunity, environment, internal) |
| 19 | `internal` scoping | NPCs only — never the player persona |
| 20 | Force-fire semantics | Hybrid: bypass for plant/revive, queue-through-agent for force-fire |
| 21 | `recentlyFired` window | Turn-based, 30 turns |
| 22 | Install distribution | Standard built-in (BUILT_IN_AGENTS auto-materialization) |
