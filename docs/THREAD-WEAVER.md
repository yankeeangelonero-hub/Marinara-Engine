# Thread Weaver

> A hidden narrative engine for Marinara that drives stories through structured plot threads with timed fuses.

Thread Weaver is a built-in **pre-generation agent**. It plants categorized plot threads while the chat unfolds, counts down their fuses each turn, and decides per-thread whether to fire on-scene, fire as an off-screen "meanwhile" cutaway, evolve (revise + re-fuse), or invalidate. Designed to coexist with Secret Plot Driver as the **tactical layer** to its strategic arc.

---

## Why This Exists

Long-form roleplay tends to lose narrative momentum. Two failure modes:

1. The model writes scene-to-scene without setup or payoff — moments don't connect to anything earlier.
2. A "secret plot" agent generates an arc but the arc lives only as freeform prose. The agent never tracks specific *moments* it planted, so callbacks are accidental and rare.

Thread Weaver attacks both by treating plot as **discrete, timed, structured objects** the model can plant, evolve, and fire deterministically.

A *thread* is a single plot beat with:

- A **category** (what kind of beat it is)
- A **premise** (what the thread is)
- A **payoff hint** (how it might fire — advisory, not prescriptive)
- A **fuse** (how many turns until it auto-fires)
- A **resolution mode** chosen at firing time

Once you have threads as objects, callbacks become deliberate, fuses become deterministic, and the user can audit, override, or kill threads from a UI panel.

---

## Mental Model

### Threads have categories

Six categories, picked to give the model a vocabulary for variety:

| Category | What it covers |
|---|---|
| `adversary` | Hostile intent — someone or something opposed to the player |
| `social` | Relationships, reputation, alliances, romance, rivalries |
| `mystery` | An unrevealed truth, an unanswered question, a secret |
| `opportunity` | Something positive to pursue (a tip, gift, lead, treasure) |
| `environment` | Weather, location, world conditions, deadline |
| `internal` | An NPC's doubt, growth, dilemma, moral conflict (**never** the player persona — player agency is sacred) |

The agent is told to aim for variety across the active set, but the prompt explicitly leaves room for genre-heavy planting (a war RP can run mostly `adversary`; a romance, mostly `social`).

### Fuses count down each turn

Three fuse types, deterministic turn counts:

| Fuse | Turns until firing | Use when |
|---|---|---|
| `immediate` | 1 turn | A nudge that should pay off next turn |
| `short` | 3 turns | A scene-level beat |
| `long` | 10 turns | A setup-payoff arc across a session |

The fuse is decremented by the **server**, not the LLM. There's no LLM call to count down — it's a single subtraction in pure JavaScript.

### Four resolution actions

When a fuse hits zero, the thread is added to the agent's `<firing_now>` block. The agent must choose one of four actions per firing thread:

| Action | What happens |
|---|---|
| `fire_on_scene` | The agent supplies a 1–2 sentence direction; server injects it into a `<scene_directive>` block right before the user's last message. Main model weaves it into the current scene. |
| `fire_off_scene` | The agent supplies a direction; server injects it into a `<meanwhile_cutaway>` block. Main model is instructed to OPEN its response with a 1–2 paragraph italicized "meanwhile, elsewhere…" cutaway, then continue with the user-facing scene. |
| `evolve` | The thread is revised. Agent supplies a new fuse type, optionally a new premise/payoff hint, and a mandatory reason. Thread re-enters the active set with the new fuse. Evolution count and history are tracked. |
| `invalidate` | The thread is silently killed. Agent supplies a mandatory reason. Thread moves to the graveyard (visible in the UI panel, can be revived). |

### Caps and limits

- **5 active threads max.** When at the cap, the agent can't plant new threads — only resolve existing ones. The cap counts post-decision (firings/invalidations free slots same turn).
- **2 firings per turn max.** If more than 2 threads are firing, only the first 2 are injected; the rest stay queued for the next turn.
- **Recently fired window: 30 turns.** Threads fired more than 30 turns ago drop off so the agent doesn't keep re-referencing them.
- **Invalidated window: 30 turns.** Same window for the graveyard.

All caps are configurable via agent settings (see [Configuration](#configuration)).

---

## Per-Turn Flow

Every new user message triggers this sequence:

1. **Pre-pass (deterministic, no LLM).**
   - Drain the previous turn's pending firings into `recentlyFired` (the previous assistant message is now committed — see [Swipe handling](#swipe-and-regen-handling)).
   - Increment the turn counter.
   - Decrement every active thread's fuse.
   - Mark any thread at fuse = 0 as `firing` and queue it for the agent.
2. **Build agent context.** The agent receives `<active_threads>`, `<firing_now>`, `<recently_fired>`, `<invalidated_threads>`, plus the standard chat context (`<chat_summary>`, `<recent_messages>`, persona, characters, etc.).
3. **LLM call.** Agent returns strict JSON with two arrays: `newThreads` (plants) and `firingDecisions` (resolutions).
4. **Post-pass.** Server applies decisions, plants new threads (subject to caps), ages out old fired/invalidated entries, and persists the full state in a single batched write.
5. **Inject into main model prompt.** `<scene_directive>` for on-scene firings and `<meanwhile_cutaway>` for off-scene firings, both injected immediately before the last user message.
6. **Main model generates.** It sees the arc (if Secret Plot Driver is also enabled), the scene directives, the trackers, and the user's message — and produces the response.

---

## Coexistence with Secret Plot Driver

Both agents ship as built-ins. You can enable either, both, or neither in any chat. By design they operate at different layers:

| | Secret Plot Driver | Thread Weaver |
|---|---|---|
| Layer | Strategic / long-arc | Tactical / per-turn |
| Output | Overarching arc + protagonist arc + one scene direction | Plot threads + firing decisions |
| Time horizon | Multi-session, slow burn | Per-turn to ten-turn fuses |
| Injection slot | `<lore>` block (arc) + `<context>` block (scene direction) | Immediately before last user message (scene_directive / meanwhile_cutaway) |

When both run, the prompt template tells Thread Weaver:

> *"`<overarching_arc>` is present only if Secret Plot Driver is also enabled. If present, your threads should SERVE this arc, not contradict it."*

This makes Thread Weaver into a tactical executor of Secret Plot Driver's strategic intent.

### Three subtle interactions to know about

1. **Pre-gen agents run in parallel.** Thread Weaver sees the `<secret_plot_state>` value persisted *last turn*, not the one Secret Plot Driver is producing this turn. Mostly fine because arcs are slow-burn; rarely matters.
2. **Token cost doubles.** Two LLM calls per user message before the main response. Use per-agent connection overrides to point each agent at a cheaper model if cost is a concern.
3. **Two competing per-turn directives are possible.** Secret Plot Driver injects a one-line direction; Thread Weaver may inject a `<scene_directive>` on the same turn. The Thread Weaver prompt biases toward `evolve` (extending the fuse) when scenes are tender, which usually defuses conflict — but watch for it in practice.

If they fight in your testing, the cheapest mitigation is to disable Secret Plot Driver and let Thread Weaver carry both layers via long-fuse `internal` and `mystery` threads.

---

## Using the Panel

Thread Weaver renders a debug panel in the chat settings drawer when the agent is enabled. Sections:

### Active threads

Each thread shows:
- Category badge (color-coded)
- Fuse chip (`🔥 1`, `⏳ 3`, `⏳ 10`) with current countdown
- Evolution count (`↻ N`) if the thread has been revised
- Premise and payoff hint
- "queued" indicator if you've manually requested a firing

Per-thread buttons:
- **Fire on-scene** — queue the thread to fire on-scene next turn (the agent will produce a context-aware direction).
- **Fire off-scene** — same but as a meanwhile cutaway.
- **Invalidate** — kill the thread silently. Moves to the graveyard.

### + Plant

Manual planting form: pick a category, write a 1-sentence premise, write a 1-sentence payoff hint, pick a fuse type. The thread enters the active set immediately. The agent's next normal run will see it and handle firing decisions when its fuse hits zero.

### Recently fired (collapsible)

Threads that paid off in the last 30 turns. Read-only. Useful for callbacks — you can see what's been delivered.

### Graveyard (collapsible)

Threads that were invalidated in the last 30 turns. Each entry shows the agent's reason for killing it. **Revive** restores a thread to the active set with a fuse type you pick.

The panel only appears when Thread Weaver is enabled in the current chat. It's hidden in game mode (which has its own narrative agents).

---

## Configuration

Stored in the agent's `settings` JSON. Defaults baked into `getDefaultBuiltInAgentSettings("thread-weaver")`:

| Setting | Default | What it controls |
|---|---|---|
| `maxActiveThreads` | `5` | Hard cap on active thread count |
| `firingsPerTurnCap` | `2` | Max firings injected per turn (overflow stays queued) |
| `recentlyFiredWindowTurns` | `30` | Turn-based age-out for recently-fired entries |
| `invalidatedWindowTurns` | `30` | Turn-based age-out for graveyard entries |
| `fuseTurnsImmediate` | `1` | Tunable fuse length for "immediate" |
| `fuseTurnsShort` | `3` | Tunable fuse length for "short" |
| `fuseTurnsLong` | `10` | Tunable fuse length for "long" |

Override in the agent editor's settings JSON. Example: a slow-burn campaign might set `fuseTurnsLong: 20` to space out long arcs further.

---

## Failure Handling

Thread Weaver is **non-critical** — its failure does not block generation (unlike Secret Plot Driver, which is critical). When the LLM call fails or returns malformed JSON:

- The pre-pass already happened (fuses decremented, threads at fuse 0 marked `firing`).
- No new firings this turn. No new threads planted.
- Threads at `firing` status stay queued and are re-evaluated on the next turn.
- The user sees a toast via the standard agent-failure UX.
- A single chronic failure stalls the firing queue (capped at the active-set size, so up to 5 threads to clear once the agent works again).

Parse errors are treated as failures, not silent successes. This is a behavior change from the historical executor (which used to soft-fail with garbage data) — the fix landed alongside this feature and now applies to all JSON-output agents.

---

## Swipe and Regen Handling

Marinara lets users swipe assistant responses to regenerate. Thread Weaver's archival of fired threads is **deferred until the next user message commits**, so swipes don't lose state:

1. Pre-pass writes a `pendingFiring` entry but the thread stays in `activeThreads` with status `firing`.
2. Server injects the directive into the main model prompt, model writes the response.
3. **If the user swipes:** regen path skips Thread Weaver (mirrors the Secret Plot Driver exclusion). Reads `pendingFiring` from memory and re-injects the same directive. **No state mutation on swipe.**
4. **If the user accepts the response (sends the next user message):** next pre-pass step 1 drains `pendingFiring` to `recentlyFired`. Thread transitions cleanly from active → fired.
5. **If the user closes the chat mid-firing:** `pendingFiring` lives in the database; restored on reopen, drained when the next user message lands.

This same rule applies to evolve and invalidate decisions — they're written on the agent's pre-gen pass and persist regardless of swipes (the state mutation already happened; swipes just regenerate the response).

---

## Architecture

### File map

```
packages/shared/src/
  types/agent.ts                # PlotThread, ThreadCategory, FuseType, ThreadStatus,
                                # SeedSource, PendingFiring, ThreadWeaverState,
                                # THREAD_WEAVER_DEFAULT_SETTINGS, fuseTypeToTurns
  constants/agent-prompts.ts    # default prompt template under "thread-weaver"
  schemas/agent.schema.ts       # adds "thread_weaver_update" result type to Zod enum

packages/server/src/
  services/agents/
    thread-weaver.ts            # PURE FUNCTIONS: readState, preparePrePass,
                                # applyDecisions, ageOutWindows, serializeAgentContext,
                                # buildMainPromptBlocks, toMemoryEntries
    agent-executor.ts           # registers thread-weaver in result-type maps,
                                # injects _threadWeaverContext into agent prompt
  services/storage/
    agents.storage.ts           # setMemoryBatch helper
  routes/
    generate.routes.ts          # pre-pass, post-pass, prompt injection, regen exclusion
    agents.routes.ts            # 6 REST endpoints under /api/agents/thread-weaver/*

packages/client/src/
  stores/agent.store.ts         # threadWeaverState slice + setters
  hooks/use-generate.ts         # SSE handler for thread_weaver_update events
  components/agents/
    ThreadWeaverPanel.tsx       # UI panel
  components/chat/
    ChatSettingsDrawer.tsx      # renders the panel when agent is enabled
```

### State storage

All state lives in the existing `agentMemory` table, scoped per `(agentId, chatId)`. Six memory keys:

| Key | Type | Purpose |
|---|---|---|
| `activeThreads` | `PlotThread[]` | ≤ 5, status `planted` or `firing` |
| `recentlyFired` | `PlotThread[]` | Last 30 turns of fired threads |
| `invalidatedThreads` | `PlotThread[]` | Last 30 turns of invalidated threads (graveyard) |
| `pendingFiring` | `PendingFiring[]` | Decisions made this turn, archived on next turn's pre-pass |
| `pendingForceFires` | `PendingForceFire[]` | UI-queued force-fires, drained when agent next runs |
| `turnCounter` | `number` | Monotonic; deterministic source for fuses |

Persistence uses `setMemoryBatch` — a sequential per-key write, **not** a database transaction. Marinara's storage layer deliberately avoids `db.transaction()` due to a known libSQL crash on Windows (see `chats.storage.ts` for the precedent). Atomicity is sacrificed; partial failure mid-batch is tolerable because the system re-derives state on the next turn.

### REST API

Six endpoints under `/api/agents/thread-weaver/*`:

| Endpoint | Method | Body / Params | Returns |
|---|---|---|---|
| `/state/:chatId` | GET | — | Full `ThreadWeaverState` JSON |
| `/plant` | POST | `{chatId, category, premise, payoffHint, fuseType, seedSource?}` | The new `PlotThread` |
| `/invalidate` | POST | `{chatId, threadId, reason?}` | The invalidated `PlotThread` |
| `/revive` | POST | `{chatId, threadId, fuseType}` | The revived `PlotThread` |
| `/force-fire` | POST | `{chatId, threadId, mode}` | `{queued: {threadId, mode}}` |
| `/force-fire/:chatId/:threadId` | DELETE | — | 204 No Content |

All endpoints validate input via Zod schemas and return 404 when the agent isn't configured or the thread isn't found, 409 when capping out, 204 on successful delete.

### Force-fire vs. manual plant

These two user actions take different paths:

- **Plant / revive** → bypass the agent. The user is making a state change ("I want this thread to exist with these fields"). No narrative judgment is needed; the thread enters `activeThreads` immediately, the next agent run handles firing when the fuse hits zero.
- **Force-fire** → queue through the next agent run. The action means "fire this thread NOW with appropriate direction text for the current scene" — that's exactly the LLM's job. The server writes a `pendingForceFires` entry; the next agent call sees the thread in `<firing_now>` and produces a context-aware `finalizedDirection`.

---

## Future Plans

The v1 spec deliberately cut several features. In rough priority order:

### Short-term

- **Thread merging (`merge` action).** Two related threads collide into a single, more dramatic combined thread. Was originally part of `evolve` semantics but pulled to v2 because grading "did the merger preserve both threads' meaning" is hard. The verb name `merge` is reserved.
- **Tighter Secret Plot Driver integration.** Currently the two run in parallel and Thread Weaver sees the *previous turn's* arc. A small change to make Secret Plot Driver's pre-gen output flow into Thread Weaver's context (or to run them sequentially when both are enabled) would fix this.
- **Bundle post-applied state into the SSE event.** Today the client refetches `/api/agents/thread-weaver/state/:chatId` after each `thread_weaver_update` event. The server already has the post-applied state in memory at that point — including it in the SSE payload eliminates the round trip.
- **UI primitive replacements.** The panel uses `confirm()` and `prompt()` for invalidate-confirmation and revive-fuse-picker. Replace with the project's `Modal` primitive once a clean variant is available.
- **Better diversity diagnostics.** Surface category counts and recent firing-mode distribution in the panel so users can see at a glance whether the agent is over-indexing on adversary or off-scene cutaways.

### Medium-term

- **In-fiction time as a fuse unit.** Right now fuses count user-message turns, which doesn't track narrative time uniformly (a "long: 10" thread fires very differently in slow conversational chats vs. fast-paced combat). Optional fuse mode: count in-fiction days from the World State agent's clock.
- **Per-thread bespoke fuse counts.** Currently the three fuse types are `1 / 3 / 10` (configurable globally). Allow specific threads to override — e.g., a "long-long" 25-turn fuse for a major reveal.
- **Importable / exportable thread packs.** Power users would benefit from being able to save a curated set of pre-planted threads (a "haunted house" pack, a "court intrigue" pack) and import them into a new chat as a starter. Same shape as character cards — distributable JSON.
- **Custom categories.** v1 ships with six categories. Users could define their own (e.g., a horror campaign might want `dread`, `revelation`, `desecration`) by editing settings.
- **Outcome tracking.** Add a `succeeded | partial | flubbed` field on fired threads, set by the next agent run when it observes how the firing landed in the actual response. Future agent calls could weight planting against past flubs.

### Speculative / brainstorm-bench

- **World / Adversarial Agent.** A separate agent that *plays* the world's antagonists — tracks 3 main adversaries, picks one each turn to advance their agenda. Would feed Thread Weaver by planting `adversary` and `social` threads from the antagonists' perspectives. Solves a real problem: stories where the villain just sits in their tower until the player visits.
- **Divination Oracle.** A flavor agent that fires on time-skips and draws "tarot cards" (or setting-appropriate symbols) to seed the next scene. Narrow, charming, complementary to Thread Weaver — could plant a thread per draw.
- **Cross-chat thread persistence.** Threads currently live per-chat. A grand campaign (multiple chats, same characters) could share a thread pool. Would require new identity/scoping logic in the storage layer.
- **Real atomic batched persistence.** When the libSQL/Windows transaction crash gets fixed upstream, swap `setMemoryBatch` to use `db.transaction()` for true atomicity. Currently a known limitation matching the rest of the codebase.

---

## Known Limitations & Quirks

- **Coexistence drift.** When both agents are enabled, the Thread Weaver prompt template references `<overarching_arc>` but Thread Weaver actually receives the raw `<secret_plot_state>` JSON. The LLM reads either fine, but the prompt could be tightened.
- **Stale-import on dev restart.** `tsx watch` ignores `node_modules`, so editing `packages/shared/*` mid-session doesn't reload in `pnpm dev`. Restart the dev server after shared-package edits. Doesn't affect production builds.
- **No automated tests.** Marinara has no test suite (per `CLAUDE.md`). All Thread Weaver verification is manual or via `pnpm check` (TypeScript + ESLint).
- **The off-scene cutaway is loud.** It instructs the main model to OPEN its response with a meanwhile paragraph before answering the user. Use sparingly. The prompt template biases toward on-scene firings, but if your chats end up mostly off-scene, dial the agent's prompt template to discourage off-scene more aggressively.

---

## Pairing Recommendations

| Pair Thread Weaver with… | Why |
|---|---|
| Automated Chat Summary | Thread Weaver uses `<chat_summary>` as its long-horizon anchor for chats > ~30 turns. Without it, the agent loses big-picture awareness. |
| Secret Plot Driver | Strategic + tactical layering. Strongest combination for long campaigns. |
| Continuity Checker (post-gen) | Catches contradictions in the threads Thread Weaver is firing. |
| Knowledge Retrieval / Knowledge Router | When threads reference lorebook entries, retrieval surfaces the relevant facts to the main model. |

Avoid pairing with:

- **Director.** Both produce per-turn nudges and will compete. Pick one.

---

## Reference

- **Spec:** `docs/superpowers/specs/2026-05-01-thread-weaver-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-01-thread-weaver.md`
- **Source:** `packages/server/src/services/agents/thread-weaver.ts` (the pure-function core)
- **Default prompt:** `packages/shared/src/constants/agent-prompts.ts` under key `"thread-weaver"`
