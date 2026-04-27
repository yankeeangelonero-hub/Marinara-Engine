/**
 * state-machine.ts — State machine definitions and transition enforcement.
 *
 * TypeScript port of ST/state-machine.js. Logic is identical; only types added.
 * Defines the valid states and transitions for each entity lifecycle.
 */
import type { TransitionResult } from "./types.ts";

// ─── Character Tier ────────────────────────────────────────────────────────────
// UNKNOWN → KNOWN → TRACKED → PRINCIPAL
// Reverse: PRINCIPAL → TRACKED/KNOWN, TRACKED → KNOWN

export const CHARACTER_TIERS: string[] = ["UNKNOWN", "KNOWN", "TRACKED", "PRINCIPAL"];

export const CHARACTER_TRANSITIONS: Record<string, Record<string, string | null>> = {
  UNKNOWN: { promote: "KNOWN" },
  KNOWN: { promote: "TRACKED", retire: null }, // retire from KNOWN = destroy
  TRACKED: { promote: "PRINCIPAL", retire: "KNOWN" },
  PRINCIPAL: { retire: "TRACKED" },
};

// ─── Constraint Integrity ──────────────────────────────────────────────────────
// STABLE → STRESSED → CRITICAL → BREACHED (terminal)
// Relief: CRITICAL → STRESSED → STABLE

export const CONSTRAINT_LEVELS: string[] = ["STABLE", "STRESSED", "CRITICAL", "BREACHED"];

export const CONSTRAINT_TRANSITIONS: Record<string, Record<string, string | null>> = {
  STABLE: { pressure: "STRESSED" },
  STRESSED: { pressure: "CRITICAL", relief: "STABLE" },
  CRITICAL: { pressure: "BREACHED", relief: "STRESSED" },
  BREACHED: {}, // terminal — no transitions out
};

// ─── Collision Lifecycle ───────────────────────────────────────────────────────
// Phase 2: Simplified — all collisions start ACTIVE.
// ACTIVE → RESOLVED (on-screen, off-screen, evolved, dissolved, imploded)
// ACTIVE → CRASHED (distance hit 0 and scene did not engage)

export const COLLISION_STATES: string[] = ["ACTIVE", "RESOLVED", "CRASHED"];

export const COLLISION_TRANSITIONS: Record<string, Record<string, string | null>> = {
  ACTIVE: { resolve: "RESOLVED", crash: "CRASHED" },
  RESOLVED: {}, // terminal
  CRASHED: {}, // terminal — forces acted without characters
};

// ─── Combat Lifecycle ──────────────────────────────────────────────────────────
// ACTIVE → RESOLVED

export const COMBAT_STATES: string[] = ["ACTIVE", "RESOLVED"];

export const COMBAT_TRANSITIONS: Record<string, Record<string, string | null>> = {
  ACTIVE: { advance: "RESOLVED" },
  RESOLVED: {},
};

// ─── Relationship Status ───────────────────────────────────────────────────────
// active <-> dormant (bidirectional), any -> archived (terminal)

export const RELATIONSHIP_STATUSES: string[] = ["active", "dormant", "archived"];

export const RELATIONSHIP_TRANSITIONS: Record<string, Record<string, string | null>> = {
  active: { dormant: "dormant", archive: "archived" },
  dormant: { activate: "active", archive: "archived" },
  archived: {}, // terminal — no transitions out
};

// ─── Faction Tier ─────────────────────────────────────────────────────────────
// KNOWN <-> TRACKED <-> PRINCIPAL (flexible, all movements allowed)

export const FACTION_TIERS: string[] = ["KNOWN", "TRACKED", "PRINCIPAL"];

export const FACTION_TRANSITIONS: Record<string, Record<string, string | null>> = {
  KNOWN: { promote: "TRACKED", escalate: "PRINCIPAL" },
  TRACKED: { promote: "PRINCIPAL", retire: "KNOWN" },
  PRINCIPAL: { retire: "TRACKED", demote: "KNOWN" },
};

// ─── Transition Validator ──────────────────────────────────────────────────────

/**
 * Validate a state transition.
 * @param entityType - 'char', 'constraint', 'collision', 'combat', 'faction', 'relationship'
 * @param field - The field being transitioned (e.g. 'tier', 'integrity', 'status')
 * @param from - Current state
 * @param to - Target state
 */
export function validateTransition(
  entityType: string,
  field: string | undefined,
  from: string,
  to: string,
): TransitionResult {
  const machines: Record<
    string,
    { field: string; transitions: Record<string, Record<string, string | null>>; states: string[] }
  > = {
    char: { field: "tier", transitions: CHARACTER_TRANSITIONS, states: CHARACTER_TIERS },
    constraint: { field: "integrity", transitions: CONSTRAINT_TRANSITIONS, states: CONSTRAINT_LEVELS },
    collision: { field: "status", transitions: COLLISION_TRANSITIONS, states: COLLISION_STATES },
    combat: { field: "status", transitions: COMBAT_TRANSITIONS, states: COMBAT_STATES },
    faction: { field: "tier", transitions: FACTION_TRANSITIONS, states: FACTION_TIERS },
    relationship: { field: "status", transitions: RELATIONSHIP_TRANSITIONS, states: RELATIONSHIP_STATUSES },
  };

  const machine = machines[entityType];
  if (!machine) {
    return { valid: true }; // No state machine for this entity type (world, pc, place, etc.)
  }

  // Only validate the state-machine-governed field
  if (field !== machine.field) {
    return { valid: true };
  }

  // Check the 'from' state exists
  if (!machine.transitions[from]) {
    return {
      valid: false,
      error: `Unknown ${entityType} state: "${from}"`,
      fix: `Valid states: ${machine.states.join(", ")}`,
    };
  }

  // Check if the transition is allowed
  const allowedTargets = Object.values(machine.transitions[from]).filter((v): v is string => v !== null);
  if (!allowedTargets.includes(to)) {
    const adjacent =
      allowedTargets.length > 0
        ? `From "${from}", valid targets: ${allowedTargets.join(", ")}`
        : `"${from}" is a terminal state — no transitions allowed`;

    const fromIdx = machine.states.indexOf(from);
    const toIdx = machine.states.indexOf(to);
    const skipping = Math.abs(toIdx - fromIdx) > 1;

    return {
      valid: false,
      error: skipping
        ? `Cannot skip ${entityType} ${field} from "${from}" to "${to}" — must go through intermediate states`
        : `Invalid ${entityType} ${field} transition: "${from}" → "${to}"`,
      fix: adjacent,
    };
  }

  return { valid: true };
}

/**
 * Check that promoting an entity to PRINCIPAL is unique (max one PRINCIPAL per type).
 * Arg order matches ST/state-machine.js: (state, entityType, entityId, newTier).
 */
export function checkPrincipalUniqueness(
  state: Record<string, Record<string, Record<string, unknown>>>,
  entityType: string,
  entityId: string,
  newTier: string,
): TransitionResult {
  if (newTier !== "PRINCIPAL") return { valid: true };
  const collection = entityType === "char" ? state.characters : state.factions;
  if (!collection) return { valid: true };
  for (const [id, ent] of Object.entries(collection)) {
    if (id === entityId) continue;
    if (String(ent.tier ?? "").toUpperCase() === "PRINCIPAL") {
      return {
        valid: false,
        error: `A PRINCIPAL ${entityType} already exists: "${id}". Max one PRINCIPAL per entity type.`,
        fix: `Demote ${id} to TRACKED first (TR ${entityType}:${id} field=tier from=PRINCIPAL to=TRACKED), then promote ${entityId}.`,
      };
    }
  }
  return { valid: true };
}

/**
 * Get valid next states for an entity in a given state.
 */
export function getValidNextStates(entityType: string, currentState: string): string[] {
  const machines: Record<string, Record<string, Record<string, string | null>>> = {
    char: CHARACTER_TRANSITIONS,
    constraint: CONSTRAINT_TRANSITIONS,
    collision: COLLISION_TRANSITIONS,
    combat: COMBAT_TRANSITIONS,
  };

  const transitions = machines[entityType];
  if (!transitions || !transitions[currentState]) return [];
  return Object.values(transitions[currentState]).filter((v): v is string => v !== null);
}

/**
 * Check if a state is terminal (no outgoing transitions).
 */
export function isTerminal(entityType: string, state: string): boolean {
  return getValidNextStates(entityType, state).length === 0;
}

/**
 * Get the state machine field name for an entity type.
 * Two call modes:
 *   1-arg — return the machine field (or null) for this entity type.
 *   2-arg — return the machine field ONLY if `field` matches it; otherwise null.
 */
export function getStateMachineField(entityType: string, field?: string): string | null {
  const fields: Record<string, string> = {
    char: "tier",
    constraint: "integrity",
    collision: "status",
    combat: "status",
    faction: "tier",
    relationship: "status",
  };
  const machineField = fields[entityType] ?? null;
  if (field === undefined) return machineField;
  return machineField === field ? machineField : null;
}
