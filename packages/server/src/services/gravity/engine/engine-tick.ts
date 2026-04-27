/**
 * engine-tick.ts — Deterministic post-commit advance tick.
 *
 * Port of ST/index.js:applyAdvanceTick (lines 2356–2409), rewritten as a
 * pure function with no side effects. Reads world.timeskip_scale from state,
 * emits distance-tick and pressure-clear transactions, always resets scale
 * to HOURS.
 *
 * Call only when mode === "advance"; safe to call on other modes (returns empty).
 */

import type { RawTransaction, GravityState, TurnMode } from "./types.ts";

const TICK: Record<string, number> = {
  HOURS: 1,
  DAYS: 24,
  WEEKS: 24 * 7,
  MONTHS: 24 * 30,
};

export interface EngineTickResult {
  /** Transactions to be staged by the caller via stageTransactions. */
  tickTxns: RawTransaction[];
  /** Collision IDs that just hit distance 0 this tick (caller handles arrival inject). */
  newArrivalIds: string[];
}

/**
 * Deterministic post-commit phase for advance turns.
 */
export function engineTick(state: GravityState, mode: TurnMode): EngineTickResult {
  const tickTxns: RawTransaction[] = [];
  const newArrivalIds: string[] = [];

  const world = state.world as Record<string, unknown>;

  if (mode !== "advance") {
    // Scale reset is unconditional — makes the default sticky
    if (world["timeskip_scale"] && world["timeskip_scale"] !== "HOURS") {
      tickTxns.push({
        op: "S",
        e: "world",
        d: { f: "timeskip_scale", v: "HOURS" },
        r: "system:advance:reset-timeskip",
      });
    }
    return { tickTxns, newArrivalIds };
  }

  const scale = String(world["timeskip_scale"] ?? "HOURS").toUpperCase();
  const tickDelta = TICK[scale] ?? 1;

  // Tick non-IMMEDIATE ACTIVE collisions
  for (const [id, colRaw] of Object.entries(state.collisions)) {
    const col = colRaw as Record<string, unknown>;
    const dist = parseFloat(String(col["distance"] ?? ""));
    const status = String(col["status"] ?? "").trim().toUpperCase();
    if (status !== "ACTIVE") continue;
    if (col["distance_category"] === "IMMEDIATE") continue;
    if (isNaN(dist) || dist <= 0) continue;
    const newDist = Math.max(0, dist - tickDelta);
    if (newDist !== dist) {
      tickTxns.push({
        op: "S",
        e: "collision",
        id,
        d: { f: "distance", v: newDist },
        r: "system:advance:tick",
      });
    }
  }

  // WEEKS/MONTHS: clear pressure points
  if (scale === "WEEKS" || scale === "MONTHS") {
    for (const id of Object.keys(state.pressures)) {
      tickTxns.push({
        op: "D",
        e: "pressure",
        id,
        r: `system:advance:${scale.toLowerCase()}-clear-pressure`,
      });
    }
  }

  // Arrival detection (distance hits 0 this tick)
  for (const [id, colRaw] of Object.entries(state.collisions)) {
    const col = colRaw as Record<string, unknown>;
    const status = String(col["status"] ?? "").toUpperCase();
    const dist = parseFloat(String(col["distance"] ?? ""));
    if (status === "ACTIVE" && !isNaN(dist) && dist > 0 && dist - tickDelta <= 0) {
      newArrivalIds.push(id);
    }
  }

  // Scale reset (unconditional)
  tickTxns.push({
    op: "S",
    e: "world",
    d: { f: "timeskip_scale", v: "HOURS" },
    r: "system:advance:reset-timeskip",
  });

  return { tickTxns, newArrivalIds };
}
