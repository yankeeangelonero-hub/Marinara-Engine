/**
 * consistency.ts — Format and structure validation + state-machine transition guard.
 *
 * TypeScript port of ST/consistency.js. Logic is identical; only types added.
 *
 * The engine validates that ledger transactions are well-formed:
 * correct JSON structure, valid operation codes, required fields present,
 * valid entity type codes, proper data shapes.
 *
 * Also wires state-machine transition enforcement (§6.1): every `TR` operation
 * is checked against state-machine::validateTransition() at commit time, and
 * invalid transitions are rejected while the rest of the batch still commits.
 *
 * Gameplay rules beyond state-machine transitions (PRINCIPAL count, constraint
 * limits, collision forces) remain the LLM's responsibility, audited during
 * OOC: eval.
 */

import { validateTransition, getStateMachineField, checkPrincipalUniqueness } from "./state-machine.ts";
import { applyTransaction as _applyTransactionFromCompute } from "./state-compute.ts";
import type { RawTransaction, GravityState } from "./types.ts";

// ─── Entity → Collection Mapping ──────────────────────────────────────────────

const ENTITY_TO_COLLECTION: Record<string, string> = {
  char: "characters",
  constraint: "constraints",
  collision: "collisions",
  combat: "combats",
  faction: "factions",
  place: "places",
  pressure: "pressures",
  world: "world",
  pc: "pc",
  divination: "divination",
  relationship: "relationships",
};

// LLM-rejected fields owned by the engine. SET writes here are dropped at
// validation time so state-compute never sees them.
const ENGINE_OWNED_FIELDS: Record<string, Set<string>> = {
  collision: new Set(["distance"]),
  pressure: new Set(["created_at_tx"]),
};

// ─── Relationship Constants ────────────────────────────────────────────────────

const MAJOR_ARCANA = new Set([
  "the-fool", "the-magician", "the-high-priestess", "the-empress", "the-emperor",
  "the-hierophant", "the-lovers", "the-chariot", "strength", "the-hermit",
  "wheel-of-fortune", "justice", "the-hanged-man", "death", "temperance",
  "the-devil", "the-tower", "the-star", "the-moon", "the-sun",
  "judgement", "the-world",
]);

const RELATIONSHIP_ORIENTATIONS = new Set(["upright", "reversed"]);
const RELATIONSHIP_DISTANCES = new Set(["fresh", "forming", "established", "deep", "core"]);
const RELATIONSHIP_INTENSITIES = new Set(["cold", "simmering", "active", "electric"]);
const FACTION_TIERS_SET = new Set(["KNOWN", "TRACKED", "PRINCIPAL"]);
const CHARACTER_TAGS_MAX = 5;
const CHARACTER_TAG_MAXLEN = 40;
const LAST_SHIFT_REASON_MAXLEN = 200;

// ─── Valid Values ──────────────────────────────────────────────────────────────

export const VALID_OPS: string[] = ["CR", "TR", "S", "A", "R", "MS", "MR", "D", "SNAP", "ROLL", "AMEND"];
export const VALID_ENTITIES: string[] = ["char", "constraint", "collision", "combat", "faction", "place", "pressure", "world", "pc", "divination", "relationship"];

// Required fields per operation type
const OP_REQUIRED_FIELDS: Record<string, string[]> = {
  CR:   ["e", "id", "d"],
  TR:   ["e", "id", "d"],
  S:    ["e", "id", "d"],
  A:    ["e", "id", "d"],
  R:    ["e", "id", "d"],
  MS:   ["e", "id", "d"],
  MR:   ["e", "id", "d"],
  D:    ["e", "id"],
  SNAP: [],
  ROLL: ["d"],
  AMEND: ["d"],
};

// Required data subfields per operation type
const OP_DATA_FIELDS: Record<string, string[]> = {
  TR:   ["f", "from", "to"],
  S:    ["f", "v"],
  A:    ["f", "v"],
  R:    ["f", "v"],
  MS:   ["f", "k", "v"],
  MR:   ["f", "k"],
  ROLL: ["target_snapshot_id"],
  AMEND: ["target_tx", "correction"],
};

// ─── Shared Types ──────────────────────────────────────────────────────────────

export interface FormatViolation {
  field: string;
  message: string;
  fix: string;
}

export interface ValidationViolation {
  field: string;
  message: string;
  fix?: string;
  tx?: unknown;
}

export interface TransitionError {
  lineNum: number;
  error: string | undefined;
  fix: string | undefined;
  raw: string;
  tx: RawTransaction;
}

// ─── validateBatch ─────────────────────────────────────────────────────────────

/**
 * Validate a batch of transactions for format correctness only.
 * Does NOT check gameplay rules — that's the LLM's job during eval.
 */
export function validateBatch(transactions: unknown): { errors: FormatViolation[]; valid: boolean } {
  const errors: FormatViolation[] = [];

  if (!Array.isArray(transactions)) {
    errors.push({
      field: "root",
      message: "Transactions must be an array",
      fix: "Wrap transactions in [...brackets...]",
    });
    return { errors, valid: false };
  }

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i] as unknown;
    const txErrors = validateFormat(tx, i);
    errors.push(...txErrors);
  }

  return { errors, valid: errors.length === 0 };
}

// ─── validateFormat ────────────────────────────────────────────────────────────

/**
 * Validate the format of a single transaction.
 */
export function validateFormat(tx: unknown, index: number): FormatViolation[] {
  const errors: FormatViolation[] = [];
  const prefix = `tx[${index}]`;

  if (!tx || typeof tx !== "object" || Array.isArray(tx)) {
    errors.push({
      field: prefix,
      message: `${prefix}: Transaction must be an object`,
      fix: "Each transaction should be {...}",
    });
    return errors;
  }

  const t = tx as Record<string, unknown>;

  if (!t["op"]) {
    errors.push({
      field: `${prefix}.op`,
      message: `${prefix}: Missing "op" (operation code)`,
      fix: `Valid ops: ${VALID_OPS.join(", ")}`,
    });
    return errors;
  }

  if (!VALID_OPS.includes(String(t["op"]))) {
    errors.push({
      field: `${prefix}.op`,
      message: `${prefix}: Unknown op "${String(t["op"])}"`,
      fix: `Valid ops: ${VALID_OPS.join(", ")}`,
    });
    return errors;
  }

  const isSingleton = ["world", "pc", "divination"].includes(String(t["e"] ?? ""));
  const required = OP_REQUIRED_FIELDS[String(t["op"])] ?? [];

  for (const field of required) {
    if (field === "id" && isSingleton) continue;
    const val = t[field];
    if (val === undefined || val === null || val === "") {
      errors.push({
        field: `${prefix}.${field}`,
        message: `${prefix}: Missing required field "${field}" for op "${String(t["op"])}"`,
        fix: `Add "${field}" to the transaction`,
      });
    }
  }

  if (t["e"] && !VALID_ENTITIES.includes(String(t["e"]))) {
    errors.push({
      field: `${prefix}.e`,
      message: `${prefix}: Unknown entity type "${String(t["e"])}"`,
      fix: `Valid types: ${VALID_ENTITIES.join(", ")}`,
    });
  }

  if (t["e"] && !["world", "pc", "divination"].includes(String(t["e"])) && required.includes("id")) {
    if (!t["id"] || typeof t["id"] !== "string") {
      errors.push({
        field: `${prefix}.id`,
        message: `${prefix}: Entity id must be a non-empty string`,
        fix: `Add a string "id" for the ${String(t["e"])} entity`,
      });
    }
  }

  if (t["d"] && typeof t["d"] === "object" && !Array.isArray(t["d"])) {
    const d = t["d"] as Record<string, unknown>;
    const dataFields = OP_DATA_FIELDS[String(t["op"])] ?? [];
    for (const field of dataFields) {
      if (d[field] === undefined) {
        errors.push({
          field: `${prefix}.d.${field}`,
          message: `${prefix}: Missing data field "d.${field}" for op "${String(t["op"])}"`,
          fix: `Op "${String(t["op"])}" requires d.${field}`,
        });
      }
    }
  } else if (required.includes("d")) {
    errors.push({
      field: `${prefix}.d`,
      message: `${prefix}: "d" (data) must be an object`,
      fix: `Add "d": {...} with the required fields`,
    });
  }

  return errors;
}

// ─── formatErrors ──────────────────────────────────────────────────────────────

/**
 * Format validation errors into an injection message for the LLM.
 */
export function formatErrors(errors: FormatViolation[]): string {
  if (errors.length === 0) return "";

  const lines = [`[LEDGER: FORMAT ERROR — ${errors.length} issue(s):`];
  for (const err of errors.slice(0, 5)) {
    lines.push(`  ${err.message}. Fix: ${err.fix}`);
  }
  if (errors.length > 5) {
    lines.push(`  ...and ${errors.length - 5} more.`);
  }
  lines.push("Resubmit corrected transactions.]");
  return lines.join("\n");
}

// ─── findMissingArchiveEntries ─────────────────────────────────────────────────

/**
 * Identify terminal collision TRs (RESOLVED/CRASHED) in a committed batch that
 * lack a matching `world.collision_archive` entry.
 * §2.2.1 — pure detection; caller owns the correction-queue side effects.
 */
export function findMissingArchiveEntries(
  committedTxns: RawTransaction[],
  state: GravityState,
): Array<{ id: string; name: string }> {
  if (!Array.isArray(committedTxns) || committedTxns.length === 0) return [];
  const worldState = state?.world as Record<string, unknown> | undefined;
  const archive = Array.isArray(worldState?.["collision_archive"]) ? (worldState!["collision_archive"] as unknown[]) : [];

  const terminals = committedTxns
    .filter(
      (tx) =>
        tx.op === "TR" &&
        tx.e === "collision" &&
        ((tx.d as Record<string, unknown> | undefined)?.["to"] === "RESOLVED" ||
          (tx.d as Record<string, unknown> | undefined)?.["to"] === "CRASHED"),
    )
    .map((tx) => ({ id: tx.id! }));

  const missing: Array<{ id: string; name: string }> = [];
  for (const { id: colId } of terminals) {
    const col = state.collisions?.[colId] as Record<string, unknown> | undefined;
    const nameToken = col?.["name"] ? String(col["name"]) : "";
    const idToken = `[id ${colId}]`;
    const matched = archive.some((entry) => typeof entry === "string" && entry.includes(idToken));
    if (!matched) missing.push({ id: colId, name: nameToken });
  }
  return missing;
}

// ─── validateTransitions ──────────────────────────────────────────────────────

/**
 * Validate state-machine transitions for a batch of transactions (§6.1).
 * Gates `TR` ops, `S` ops on machine-governed fields (tier/integrity/status),
 * and engine-owned field writes (collision.distance, pressure.created_at_tx).
 * Rejected TXs are pulled out of `valid`; other TXs in the batch still commit.
 */
export function validateTransitions(
  transactions: RawTransaction[],
  state?: GravityState,
): { valid: RawTransaction[]; errors: TransitionError[] } {
  const valid: RawTransaction[] = [];
  const errors: TransitionError[] = [];
  if (!Array.isArray(transactions)) return { valid: [], errors: [] };

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i]!;
    const d = tx.d as Record<string, unknown> | undefined;

    if (tx.op === "S") {
      const engineFields = tx.e ? ENGINE_OWNED_FIELDS[tx.e] : undefined;
      if (engineFields && engineFields.has(String(d?.["f"] ?? ""))) {
        errors.push({
          lineNum: i,
          error: `${tx.e}:${tx.id}.${String(d!["f"])} is engine-owned — SET is rejected`,
          fix:
            tx.e === "collision" && d?.["f"] === "distance"
              ? `Set distance_category=IMMEDIATE|SHORT|MEDIUM|LONG on CR; the engine resolves and ticks the numeric distance.`
              : `Do not write ${tx.e}.${String(d!["f"])} directly — the engine manages this field.`,
          raw: `[s ${tx.e}:${tx.id} ${String(d!["f"])}]`,
          tx,
        });
        continue;
      }

      const machineField = getStateMachineField(String(tx.e ?? ""), String(d?.["f"] ?? ""));
      if (machineField) {
        const collection = ENTITY_TO_COLLECTION[String(tx.e ?? "")];
        const stateAsRecord = state as unknown as Record<string, Record<string, Record<string, unknown>>> | undefined;
        const entity = collection ? stateAsRecord?.[collection]?.[tx.id ?? ""] : undefined;
        const fromVal = entity?.[machineField];
        if (fromVal === undefined || fromVal === null) {
          errors.push({
            lineNum: i,
            error: `Cannot SET ${tx.e}:${tx.id}.${machineField} — entity not found or has no current ${machineField}; use TR instead`,
            fix: `Use TR ${tx.e}:${tx.id} field=${machineField} from=<current> to=${String(d?.["v"] ?? "")} so the state machine can validate the move.`,
            raw: `[s ${tx.e}:${tx.id} ${machineField}]`,
            tx,
          });
          continue;
        }
        const result = validateTransition(String(tx.e ?? ""), machineField, String(fromVal), String(d?.["v"] ?? ""));
        if (!result.valid) {
          errors.push({
            lineNum: i,
            error: result.error,
            fix: `${result.fix ?? ""} (Use TR, not S, for state-machine fields.)`,
            raw: `[s ${tx.e}:${tx.id} ${machineField}]`,
            tx,
          });
          continue;
        }
      }

      valid.push(tx);
      continue;
    }

    if (tx.op !== "TR") {
      valid.push(tx);
      continue;
    }

    // Verify tx.d.from matches entity's actual current state
    const trMachineField = getStateMachineField(String(tx.e ?? ""), String(d?.["f"] ?? ""));
    if (trMachineField) {
      const trCollection = ENTITY_TO_COLLECTION[String(tx.e ?? "")];
      const stateAsRecord = state as unknown as Record<string, Record<string, Record<string, unknown>>> | undefined;
      const trEntity = trCollection ? stateAsRecord?.[trCollection]?.[tx.id ?? ""] : undefined;

      if (trEntity !== undefined) {
        const trActual = trEntity[trMachineField];
        const INITIAL_STATES: Record<string, string> = {
          char: "UNKNOWN",
          constraint: "STABLE",
          collision: "ACTIVE",
          combat: "ACTIVE",
          faction: "KNOWN",
          relationship: "active",
        };
        const initialState = tx.e ? INITIAL_STATES[tx.e] : undefined;
        if ((trActual === undefined || trActual === null) && String(d?.["from"] ?? "").toUpperCase() !== initialState) {
          errors.push({
            lineNum: i,
            error: `TR from-state mismatch: claimed "${String(d?.["from"] ?? "")}" but actual is ${initialState ?? "unknown"} (default)`,
            fix: `Use from=${initialState ?? "unknown"} to reflect the entity's actual current state.`,
            raw: `[tr ${tx.e}:${tx.id}]`,
            tx,
          });
          continue;
        } else if (
          trActual !== undefined &&
          trActual !== null &&
          String(d?.["from"] ?? "").toUpperCase() !== trActual
        ) {
          errors.push({
            lineNum: i,
            error: `TR from-state mismatch: claimed "${String(d?.["from"] ?? "")}" but actual is "${String(trActual)}"`,
            fix: `Use from=${String(trActual)} to reflect the entity's actual current state.`,
            raw: `[tr ${tx.e}:${tx.id}]`,
            tx,
          });
          continue;
        }
      }
    }

    const result = validateTransition(
      String(tx.e ?? ""),
      String(d?.["f"] ?? ""),
      String(d?.["from"] ?? ""),
      String(d?.["to"] ?? ""),
    );
    if (result.valid) {
      valid.push(tx);
    } else {
      errors.push({
        lineNum: i,
        error: result.error,
        fix: result.fix,
        raw: `[tr ${tx.e}:${tx.id}]`,
        tx,
      });
    }
  }
  return { valid, errors };
}

// ─── Relationship Shape Helpers ────────────────────────────────────────────────

function isValidCardObj(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  const card = typeof o["card"] === "string" ? o["card"].toLowerCase() : "";
  const orientation = typeof o["orientation"] === "string" ? o["orientation"].toLowerCase() : "";
  const distance = typeof o["distance"] === "string" ? o["distance"].toLowerCase() : "";
  const intensity = typeof o["intensity"] === "string" ? o["intensity"].toLowerCase() : "";
  return (
    MAJOR_ARCANA.has(card) &&
    RELATIONSHIP_ORIENTATIONS.has(orientation) &&
    RELATIONSHIP_DISTANCES.has(distance) &&
    RELATIONSHIP_INTENSITIES.has(intensity)
  );
}

function isValidLastShift(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o["tx"] !== "number") return false;
  if (!("collision_id" in o)) return false;
  if (typeof o["reason"] !== "string") return false;
  if ((o["reason"] as string).length > LAST_SHIFT_REASON_MAXLEN) return false;
  if (!isValidCardObj(o["from"])) return false;
  if (!isValidCardObj(o["to"])) return false;
  return true;
}

function validateRelationshipId(id: string | undefined): ValidationViolation | null {
  if (typeof id !== "string" || !id.startsWith("pc-") || id.length <= 3) {
    return {
      field: "id",
      message: `relationship id must be "pc-<other_id>", got "${String(id ?? "")}"`,
      fix: "Use e.g. relationship:pc-lacus (PC is always first in the pair).",
    };
  }
  return null;
}

function validateRelationshipTx(tx: RawTransaction): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const idViolation = validateRelationshipId(tx.id);
  if (idViolation) violations.push(idViolation);

  const d = (tx.d ?? {}) as Record<string, unknown>;

  if (tx.op === "CR") {
    const card = typeof d["card"] === "string" ? d["card"].toLowerCase() : d["card"];
    const orientation = typeof d["orientation"] === "string" ? d["orientation"].toLowerCase() : d["orientation"];
    if (!MAJOR_ARCANA.has(String(card ?? ""))) {
      violations.push({ field: "card", message: `invalid card slug "${String(d["card"] ?? "")}"`, fix: "Must be one of the 22 Major Arcana slugs in lowercase-hyphen form." });
    }
    if (!RELATIONSHIP_ORIENTATIONS.has(String(orientation ?? ""))) {
      violations.push({ field: "orientation", message: `invalid orientation "${String(d["orientation"] ?? "")}"`, fix: '"upright" or "reversed" (lowercase).' });
    }
    if (typeof d["nuance"] !== "string" || (d["nuance"] as string).trim() === "") {
      violations.push({ field: "nuance", message: "nuance must be a non-empty string", fix: "Describe the specific expression of the archetype for this pair." });
    }
    if (d["distance"] !== undefined) {
      const distance = typeof d["distance"] === "string" ? d["distance"].toLowerCase() : d["distance"];
      if (!RELATIONSHIP_DISTANCES.has(String(distance ?? ""))) {
        violations.push({ field: "distance", message: `invalid distance "${String(d["distance"] ?? "")}"`, fix: 'Must be one of: fresh, forming, established, deep, core (lowercase). Omit to default to "fresh".' });
      }
    }
    if (d["intensity"] !== undefined) {
      const intensity = typeof d["intensity"] === "string" ? d["intensity"].toLowerCase() : d["intensity"];
      if (!RELATIONSHIP_INTENSITIES.has(String(intensity ?? ""))) {
        violations.push({ field: "intensity", message: `invalid intensity "${String(d["intensity"] ?? "")}"`, fix: 'Must be one of: cold, simmering, active, electric (lowercase). Omit to default to "simmering".' });
      }
    }
    if (d["status"] !== undefined) {
      violations.push({ field: "status", message: 'relationship.status is engine-owned — omit on CR', fix: 'Remove the status field. Status defaults to "active" at birth.' });
    }
    if (d["last_shift"] !== undefined && !isValidLastShift(d["last_shift"])) {
      violations.push({ field: "last_shift", message: "last_shift must be null or {tx, collision_id, from: {card, orientation, distance, intensity}, to: {card, orientation, distance, intensity}, reason}", fix: "Use null at birth." });
    }
  } else if (tx.op === "S") {
    const f = d["f"];
    const v = d["v"];
    if (f === "card") {
      const card = typeof v === "string" ? v.toLowerCase() : v;
      if (!MAJOR_ARCANA.has(String(card ?? ""))) {
        violations.push({ field: "card", message: `invalid card slug "${String(v ?? "")}"`, fix: "Major Arcana only, lowercase-hyphen." });
      }
    }
    if (f === "orientation") {
      const orientation = typeof v === "string" ? v.toLowerCase() : v;
      if (!RELATIONSHIP_ORIENTATIONS.has(String(orientation ?? ""))) {
        violations.push({ field: "orientation", message: `invalid orientation "${String(v ?? "")}"`, fix: '"upright" or "reversed" (lowercase).' });
      }
    }
    if (f === "nuance") {
      if (typeof v !== "string" || (v as string).trim() === "") {
        violations.push({ field: "nuance", message: `nuance must be a non-empty string, got ${JSON.stringify(v)}`, fix: "Nuance must be a non-empty prose string." });
      }
    }
    if (f === "distance") {
      const distance = typeof v === "string" ? v.toLowerCase() : v;
      if (!RELATIONSHIP_DISTANCES.has(String(distance ?? ""))) {
        violations.push({ field: "distance", message: `invalid distance "${String(v ?? "")}"`, fix: "Must be one of: fresh, forming, established, deep, core (lowercase)." });
      }
    }
    if (f === "intensity") {
      const intensity = typeof v === "string" ? v.toLowerCase() : v;
      if (!RELATIONSHIP_INTENSITIES.has(String(intensity ?? ""))) {
        violations.push({ field: "intensity", message: `invalid intensity "${String(v ?? "")}"`, fix: "Must be one of: cold, simmering, active, electric (lowercase)." });
      }
    }
    if (f === "status") {
      violations.push({ field: "status", message: "relationship.status is engine-owned and cannot be SET manually", fix: "Status follows tier automatically." });
    }
    if (f === "last_shift") {
      if (v === null) {
        violations.push({ field: "last_shift", message: "S last_shift=null would wipe the audit trail", fix: "last_shift can only be null at birth (CR)." });
      } else {
        const vObj = v as Record<string, unknown> | null | undefined;
        if (vObj && typeof vObj["reason"] === "string" && (vObj["reason"] as string).length > LAST_SHIFT_REASON_MAXLEN) {
          violations.push({ field: "last_shift", message: `last_shift.reason is too long (${(vObj["reason"] as string).length} chars; max ${LAST_SHIFT_REASON_MAXLEN})`, fix: `Keep reason ≤${LAST_SHIFT_REASON_MAXLEN} chars.` });
        } else if (!isValidLastShift(v)) {
          violations.push({ field: "last_shift", message: "last_shift must be {tx, collision_id, from: {card, orientation, distance, intensity}, to: {card, orientation, distance, intensity}, reason}", fix: "All five fields required. from/to must be {card, orientation, distance, intensity} objects." });
        }
      }
    }
  }
  return violations;
}

function validateCharTagsTx(tx: RawTransaction): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const d = tx.d as Record<string, unknown> | undefined;

  if (tx.op === "CR" && Array.isArray(d?.["tags"])) {
    const tags = d!["tags"] as unknown[];
    if (tags.length > CHARACTER_TAGS_MAX) {
      violations.push({ field: "tags", message: `char.tags must be ≤ ${CHARACTER_TAGS_MAX} (got ${tags.length})`, fix: "Trim to the most identity-defining tags." });
    }
    for (const t of tags) {
      if (typeof t !== "string") violations.push({ field: "tags", message: "tags must be strings", fix: "Remove non-string entries." });
      else if (t.length > CHARACTER_TAG_MAXLEN) violations.push({ field: "tags", message: "tag too long", fix: "Tags should be 1-3 words." });
    }
  } else if (tx.op === "S" && d?.["f"] === "tags") {
    if (!Array.isArray(d?.["v"])) {
      violations.push({ field: "tags", message: `S char.tags value must be an array, got ${typeof d?.["v"]}`, fix: "Use an array." });
      return violations;
    }
    const tags = d!["v"] as unknown[];
    if (tags.length > CHARACTER_TAGS_MAX) {
      violations.push({ field: "tags", message: `char.tags must be ≤ ${CHARACTER_TAGS_MAX} (got ${tags.length})`, fix: "Trim to 5." });
    }
    for (const t of tags) {
      if (typeof t !== "string") violations.push({ field: "tags", message: "tags must be strings", fix: "Remove non-string entries." });
      else if (t.length > CHARACTER_TAG_MAXLEN) violations.push({ field: "tags", message: "tag too long", fix: "1-3 words." });
    }
  } else if (tx.op === "A" && d?.["f"] === "tags") {
    const t = d?.["v"];
    if (typeof t !== "string") violations.push({ field: "tags", message: "appended tag must be a string", fix: "Tags must be plain text strings." });
    else if (t.length > CHARACTER_TAG_MAXLEN) violations.push({ field: "tags", message: "tag too long", fix: "1-3 words." });
  }
  return violations;
}

function validateFactionTierTx(tx: RawTransaction): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const d = tx.d as Record<string, unknown> | undefined;
  let tier: unknown = null;
  if (tx.op === "CR") tier = d?.["tier"];
  else if (tx.op === "S" && d?.["f"] === "tier") tier = d?.["v"];
  if (tier === undefined || tier === null) return violations;
  if (!FACTION_TIERS_SET.has(String(tier))) {
    violations.push({ field: "tier", message: `invalid faction.tier "${String(tier)}"`, fix: "Must be KNOWN, TRACKED, or PRINCIPAL." });
  }
  return violations;
}

interface PendingCreations {
  char: Map<string, string>;
  faction: Map<string, string>;
  place: Set<string>;
}

function validateSceneCastEntries(
  refs: unknown[],
  state: GravityState | null,
  pendingCreations: PendingCreations | null = null,
): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  for (const ref of refs) {
    if (typeof ref !== "string" || !ref.includes(":")) {
      violations.push({ field: "scene_cast", message: `invalid cast entry "${String(ref)}" — must be "type:id" format`, fix: 'Use char:lacus or faction:zaft.' });
      continue;
    }
    const colonIdx = ref.indexOf(":");
    const type = ref.slice(0, colonIdx);
    const id = ref.slice(colonIdx + 1);
    if (!state) continue;
    let exists = false;
    if (type === "char") exists = Boolean(state.characters?.[id]);
    else if (type === "faction") exists = Boolean(state.factions?.[id]);
    else {
      violations.push({ field: "scene_cast", message: `unsupported entity type "${type}" in cast ref "${ref}"`, fix: 'Only "char:" and "faction:" prefixes allowed.' });
      continue;
    }
    if (!exists) {
      const pending = type === "char" ? pendingCreations?.char : type === "faction" ? pendingCreations?.faction : null;
      if (pending && pending.has(id)) continue;
      violations.push({ field: "scene_cast", message: `cast ref "${ref}" references a non-existent entity`, fix: `Create ${type}:${id} first.` });
    }
  }
  return violations;
}

// ─── validateTransaction ───────────────────────────────────────────────────────

/**
 * Validate a single transaction for shape correctness and semantic rules.
 */
export function validateTransaction(
  tx: RawTransaction,
  state: GravityState | null,
  pendingCreations: PendingCreations | null = null,
): { valid: boolean; violations: ValidationViolation[] } {
  const violations: ValidationViolation[] = [];

  if (!tx || typeof tx !== "object" || Array.isArray(tx)) {
    violations.push({ field: "root", message: "Transaction must be an object", fix: "Each transaction should be {...}" });
    return { valid: false, violations };
  }

  const d = tx.d as Record<string, unknown> | undefined;

  // Relationship shape validation
  if (tx.e === "relationship" && (tx.op === "CR" || tx.op === "S")) {
    violations.push(...validateRelationshipTx(tx));
  }
  // char.tags (CR, A, S)
  if (tx.e === "char" && (tx.op === "CR" || tx.op === "A" || tx.op === "S")) {
    violations.push(...validateCharTagsTx(tx));
  }
  // faction.tier (CR, S)
  if (tx.e === "faction" && (tx.op === "CR" || tx.op === "S")) {
    violations.push(...validateFactionTierTx(tx));
  }
  // pc entity (scene_cast + current_place_id)
  if (tx.e === "pc") {
    let refs: unknown[] | null = null;
    if (tx.op === "S" && d?.["f"] === "scene_cast" && Array.isArray(d?.["v"])) refs = d!["v"] as unknown[];
    if (tx.op === "A" && d?.["f"] === "scene_cast") refs = [d?.["v"]];
    if (refs) violations.push(...validateSceneCastEntries(refs, state, pendingCreations));
    if (tx.op === "S" && d?.["f"] === "current_place_id") {
      const v = d?.["v"];
      if (v !== null && v !== "" && v !== undefined) {
        if (typeof v !== "string" || !v.startsWith("place:") || v.length <= "place:".length) {
          violations.push({ field: "current_place_id", message: `current_place_id must be "place:<id>", got "${String(v)}"`, fix: "Use the fully-qualified place id (e.g., place:bridge)." });
        }
      }
    }
  }
  // PRINCIPAL uniqueness (state-dependent)
  if (state && (tx.e === "char" || tx.e === "faction")) {
    let newTier: string | null = null;
    if (tx.op === "CR" && d?.["tier"]) newTier = String(d["tier"]);
    else if (tx.op === "TR" && d?.["f"] === "tier") newTier = String(d?.["to"] ?? "");
    else if (tx.op === "S" && d?.["f"] === "tier") newTier = String(d?.["v"] ?? "");
    if (newTier === "PRINCIPAL") {
      const stateAsRecord = state as unknown as Record<string, Record<string, Record<string, unknown>>>;
      const uniq = checkPrincipalUniqueness(stateAsRecord, tx.e, tx.id ?? "", newTier);
      if (!uniq.valid) {
        violations.push({ field: "tier", message: uniq.error ?? "PRINCIPAL uniqueness violation", fix: uniq.fix });
      }
    }
  }
  // CR relationship: target must exist and be TRACKED+
  if (state && tx.e === "relationship" && tx.op === "CR") {
    const id = tx.id ?? "";
    if (id.startsWith("pc-") && id.length > 3) {
      const otherId = id.slice("pc-".length);
      const char = state.characters?.[otherId] as Record<string, unknown> | undefined;
      const faction = state.factions?.[otherId] as Record<string, unknown> | undefined;
      const target = char ?? faction;
      let tier: string | null = null;
      if (target) {
        tier = String(target["tier"] ?? "").toUpperCase();
      } else if (pendingCreations?.char?.has(otherId)) {
        tier = String(pendingCreations.char.get(otherId) ?? "").toUpperCase();
      } else if (pendingCreations?.faction?.has(otherId)) {
        tier = String(pendingCreations.faction.get(otherId) ?? "").toUpperCase();
      }
      if (tier === null) {
        violations.push({ field: "id", message: `relationship target "${otherId}" does not exist as char or faction`, fix: "Create the char or faction at TRACKED+ tier first." });
      } else if (tier !== "TRACKED" && tier !== "PRINCIPAL") {
        violations.push({ field: "id", message: `relationship:pc-${otherId} requires target tier ≥ TRACKED (current: "${tier}")`, fix: "Promote the target to TRACKED first." });
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

// ─── validateBlock ─────────────────────────────────────────────────────────────

/**
 * Validate a block of transactions using a shadow-state walk.
 * Catches same-block exploits (e.g. two PRINCIPAL CRs in one block).
 */
export function validateBlock(
  txs: RawTransaction[],
  baseState: GravityState | null,
): { valid: boolean; violations: ValidationViolation[]; droppedTxs: Set<RawTransaction> } {
  const shadow: GravityState = {
    characters:    { ...(baseState?.characters    ?? {}) },
    factions:      { ...(baseState?.factions      ?? {}) },
    relationships: { ...(baseState?.relationships ?? {}) },
    constraints:   { ...(baseState?.constraints   ?? {}) },
    collisions:    { ...(baseState?.collisions     ?? {}) },
    combats:       { ...(baseState?.combats        ?? {}) },
    places:        { ...(baseState?.places         ?? {}) },
    pressures:     { ...(baseState?.pressures      ?? {}) },
    world:         { ...(baseState?.world          ?? {}) },
    divination:    { ...(baseState?.divination     ?? {}) },
    pc:            baseState?.pc ? { ...baseState.pc } : {},
    lastTxId:      baseState?.lastTxId ?? -1,
    _history:      {},
  };

  const violations: ValidationViolation[] = [];
  const droppedTxs = new Set<RawTransaction>();

  // Pre-pass: collect entities that will be CR'd in this block for forward-ref tolerance
  const pendingCreations: PendingCreations = {
    char: new Map<string, string>(),
    faction: new Map<string, string>(),
    place: new Set<string>(),
  };
  for (const tx of txs) {
    if (tx.op !== "CR") continue;
    const d = tx.d as Record<string, unknown> | undefined;
    if (tx.e === "char") pendingCreations.char.set(tx.id ?? "", String(d?.["tier"] ?? "KNOWN"));
    else if (tx.e === "faction") pendingCreations.faction.set(tx.id ?? "", String(d?.["tier"] ?? "KNOWN"));
    else if (tx.e === "place") pendingCreations.place.add(tx.id ?? "");
  }

  const applyTransaction = _applyTransactionFromCompute;
  const shadowAsRecord = shadow as unknown as Record<string, Record<string, Record<string, unknown>>>;

  for (const tx of txs) {
    const perTx = validateTransaction(tx, shadow, pendingCreations);
    if (!perTx.valid) {
      violations.push(...perTx.violations.map((v) => ({ ...v, tx: tx.tx })));
      droppedTxs.add(tx);
      continue;
    }
    // Deep-clone the entity being modified so shadow never mutates baseState objects
    const coll = tx.e ? ENTITY_TO_COLLECTION[tx.e] : undefined;
    if (coll && shadowAsRecord[coll] && shadowAsRecord[coll]![tx.id ?? ""] !== undefined) {
      shadowAsRecord[coll]![tx.id!] = structuredClone(shadowAsRecord[coll]![tx.id!] as Record<string, unknown>);
    }
    try {
      applyTransaction(shadow, tx);
    } catch (e) {
      const err = e as Error;
      violations.push({ field: "_apply", message: `applyTransaction threw: ${err.message}`, tx: tx.tx });
      droppedTxs.add(tx);
    }
  }

  return { valid: violations.length === 0, violations, droppedTxs };
}
