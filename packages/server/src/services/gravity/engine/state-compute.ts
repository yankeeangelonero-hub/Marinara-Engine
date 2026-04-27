/**
 * state-compute.ts — Derive current state from transactions.
 *
 * TypeScript port of ST/state-compute.js. Logic is identical; only types added.
 * Full Gravity v10 state model with field-level change history.
 * Every mutable field tracks its transitions with timestamps.
 *
 * API note: computeState(snapshot, transactions) — always two args.
 * Pass null as snapshot for a full replay from the empty state.
 */
import { logger } from "../../../lib/logger.ts";
import type { GravityState, RawTransaction } from "./types.ts";

// NOTE: spec §2 uses state.chars as shorthand; codebase keeps state.characters (D1 decision).
export const CATEGORY_DISTANCES: Record<string, number> = { IMMEDIATE: 1, SHORT: 10, MEDIUM: 20, LONG: 50 };
const MAX_COLLISION_ARCHIVE = 20;
const CHARACTER_TAGS_MAX = 5;

// ─── Internal helpers ──────────────────────────────────────────────────────────

/** Simple string similarity (Dice coefficient on bigrams). Returns 0.0–1.0. */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const lower = (s: string) => s.toLowerCase().trim();
  const bigrams = (s: string) => {
    const set = new Map<string, number>();
    const str = lower(s);
    for (let i = 0; i < str.length - 1; i++) {
      const bi = str.substring(i, i + 2);
      set.set(bi, (set.get(bi) ?? 0) + 1);
    }
    return set;
  };
  const aBi = bigrams(a);
  const bBi = bigrams(b);
  let intersection = 0;
  for (const [bi, count] of aBi) {
    intersection += Math.min(count, bBi.get(bi) ?? 0);
  }
  return (2 * intersection) / (a.length - 1 + b.length - 1);
}

export function createEmptyState(): GravityState {
  return {
    characters: {},
    constraints: {},
    collisions: {},
    combats: {},
    factions: {},
    places: {},
    pressures: {},
    relationships: {},
    world: {
      world_state: "",
      collision_archive: [],
    },
    pc: {
      name: "",
      demonstrated_traits: [],
      current_scene: "",
      current_place_id: "",
      scene_cast: [],
    },
    divination: {
      active_system: "arcana",
      last_draw: null,
      readings: [],
    },
    lastTxId: -1,
    _history: {},
  };
}

function coerceStringifiedArray(value: unknown): string[] | null {
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const m = trimmed.match(/^\[(.*)\]$/s);
  if (m) {
    const inner = (m[1] ?? "").trim();
    if (!inner) return [];
    return inner.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (trimmed) return [trimmed];
  return [];
}

function normalizeArrayFields(state: GravityState): void {
  for (const c of Object.values(state.collisions)) {
    for (const f of ["involved_chars", "parent_collision_ids", "successor_collision_ids"]) {
      if (c[f] !== undefined && c[f] !== null) {
        const coerced = coerceStringifiedArray(c[f]);
        if (coerced !== null) c[f] = coerced;
      }
    }
  }
  for (const p of Object.values(state.pressures)) {
    if (p.related_to !== undefined && p.related_to !== null) {
      const coerced = coerceStringifiedArray(p.related_to);
      if (coerced !== null) p.related_to = coerced;
    }
  }
  for (const f of Object.values(state.factions)) {
    for (const fld of ["members", "territory"]) {
      if (f[fld] !== undefined && f[fld] !== null) {
        const coerced = coerceStringifiedArray(f[fld]);
        if (coerced !== null) f[fld] = coerced;
      }
    }
  }
}

function normalizeCharacterKnowledgeAsymmetry(state: GravityState): void {
  for (const char of Object.values(state.characters)) {
    const tier = String(char?.tier ?? "").toUpperCase();
    if (!["KNOWN", "TRACKED", "PRINCIPAL"].includes(tier)) continue;
    const ka = char.knowledge_asymmetry;
    if (!ka || typeof ka !== "object" || Array.isArray(ka)) {
      char.knowledge_asymmetry = {};
    }
    if (char.last_seen_at === undefined || char.last_seen_at === null) {
      char.last_seen_at = "";
    }
    const kaObj = char.knowledge_asymmetry as Record<string, unknown>;
    const flatKeys = Object.keys(kaObj).filter((k) => typeof kaObj[k] === "string");
    if (flatKeys.length > 20) {
      for (const k of flatKeys.slice(20)) delete kaObj[k];
    }
  }
}

function normalizeFactionKnowledgeAsymmetry(state: GravityState): void {
  for (const faction of Object.values(state.factions)) {
    if (
      !faction.knowledge_asymmetry ||
      typeof faction.knowledge_asymmetry !== "object" ||
      Array.isArray(faction.knowledge_asymmetry)
    ) {
      faction.knowledge_asymmetry = {};
    }
    const kaObj = faction.knowledge_asymmetry as Record<string, unknown>;
    const kaKeys = Object.keys(kaObj);
    if (kaKeys.length > 20) {
      for (const k of kaKeys.slice(20)) delete kaObj[k];
    }
  }
}

export function getCollectionName(entityType: string): string {
  const map: Record<string, string> = {
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
  return map[entityType] ?? entityType;
}

// Aliases the LLM has used instead of canonical constraint field names.
const CONSTRAINT_FIELD_ALIASES: Record<string, string> = {
  description: "profile",
  shed: "shedding_order",
};

function normalizeConstraintFields(fields: Record<string, unknown>): Record<string, unknown> {
  if (!fields || typeof fields !== "object") return fields;
  const out = { ...fields };
  for (const [alias, canonical] of Object.entries(CONSTRAINT_FIELD_ALIASES)) {
    if (out[alias] !== undefined && out[canonical] === undefined) {
      out[canonical] = out[alias];
    }
    delete out[alias];
  }
  if (out.char !== undefined && out.owner_id === undefined) {
    out.owner_id = out.char;
  }
  delete out.char;
  if (typeof out.owner_id === "string" && out.owner_id.startsWith("char:")) {
    out.owner_id = out.owner_id.slice("char:".length);
  }
  return out;
}

function normalizeConstraintSField(field: string, value: unknown): { field: string; value: unknown } {
  if (CONSTRAINT_FIELD_ALIASES[field] !== undefined) {
    return { field: CONSTRAINT_FIELD_ALIASES[field], value };
  }
  if (field === "char") {
    const v =
      typeof value === "string" && value.startsWith("char:") ? value.slice("char:".length) : value;
    return { field: "owner_id", value: v };
  }
  if (field === "owner_id" && typeof value === "string" && value.startsWith("char:")) {
    return { field: "owner_id", value: value.slice("char:".length) };
  }
  return { field, value };
}

// Aliases the LLM has used instead of canonical character field names.
const CHARACTER_FIELD_ALIASES: Record<string, string> = {
  want: "agenda",
};

function normalizeCharacterFields(fields: Record<string, unknown>): Record<string, unknown> {
  if (!fields || typeof fields !== "object") return fields;
  const out = { ...fields };
  for (const [alias, canonical] of Object.entries(CHARACTER_FIELD_ALIASES)) {
    if (out[alias] !== undefined && out[canonical] === undefined) {
      out[canonical] = out[alias];
    }
    delete out[alias];
  }
  return out;
}

function normalizeCharacterSField(field: string, value: unknown): { field: string; value: unknown } {
  if (CHARACTER_FIELD_ALIASES[field] !== undefined) {
    return { field: CHARACTER_FIELD_ALIASES[field], value };
  }
  return { field, value };
}

function recordHistory(
  state: GravityState,
  entityType: string,
  entityId: string | undefined,
  field: string,
  from: unknown,
  to: unknown,
  tx: RawTransaction,
): void {
  const key = `${entityType}:${entityId ?? "_"}:${field}`;
  if (!state._history[key]) state._history[key] = [];
  (state._history[key] as unknown[]).push({
    from,
    to,
    t: tx.t ?? "",
    _ts: tx._ts ?? "",
    tx: tx.tx,
    r: tx.r ?? "",
  });
}

export function getFieldHistory(
  state: GravityState,
  entityType: string,
  entityId: string | undefined,
  field: string,
): unknown[] {
  const key = `${entityType}:${entityId ?? "_"}:${field}`;
  return (state._history[key] as unknown[]) ?? [];
}

function getArrayFieldHistory(
  state: GravityState,
  entityType: string,
  entityId: string | undefined,
  field: string,
): unknown[] {
  return getFieldHistory(state, entityType, entityId, `${field}[]`);
}

function toComparableArrayValue(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().toLowerCase()
    : JSON.stringify(value);
}

export function getArrayItemHistory(
  state: GravityState,
  entityType: string,
  entityId: string | undefined,
  field: string,
  value: unknown,
): unknown[] {
  const target = toComparableArrayValue(value);
  return getArrayFieldHistory(state, entityType, entityId, field).filter((entry) => {
    const e = entry as Record<string, unknown>;
    return toComparableArrayValue(e.to !== undefined ? e.to : e.from) === target;
  });
}

export function getEntityHistory(
  state: GravityState,
  entityType: string,
  entityId: string | undefined,
): Record<string, unknown[]> {
  const prefix = `${entityType}:${entityId ?? "_"}:`;
  const result: Record<string, unknown[]> = {};
  for (const [key, entries] of Object.entries(state._history)) {
    if (key.startsWith(prefix)) {
      const field = key.substring(prefix.length);
      result[field] = entries as unknown[];
    }
  }
  return result;
}

function adjustRelationshipStatus(
  state: GravityState,
  entityType: string,
  entityId: string,
  newStatus: string,
): void {
  if (entityType !== "char" && entityType !== "faction") return;
  const relId = `pc-${entityId}`;
  const rel = state.relationships?.[relId];
  if (!rel) return;
  if (rel.status === newStatus) return;
  if (rel.status === "archived") return; // terminal — no transitions out
  rel.status = newStatus;
}

// ─── Core transaction applicator ──────────────────────────────────────────────

/**
 * Apply a single transaction to the state (mutates in place, returns state).
 */
export function applyTransaction(state: GravityState, tx: RawTransaction): GravityState {
  const collection = getCollectionName(tx.e ?? "");
  const isSingleton = ["world", "pc", "divination"].includes(tx.e ?? "");

  // Cast state to allow dynamic string-key access for collection routing.
  const s = state as unknown as Record<string, Record<string, Record<string, unknown>>>;

  switch (tx.op) {
    case "CR": {
      if (isSingleton) {
        Object.assign(s[collection]!, tx.d ?? {});
      } else {
        let rawD = tx.d ?? {};
        if (tx.e === "constraint") rawD = normalizeConstraintFields(rawD);
        else if (tx.e === "char") rawD = normalizeCharacterFields(rawD);
        const data: Record<string, unknown> = { id: tx.id, ...rawD };
        if (tx.e === "place") {
          if (!data.reach) data.reach = "LOCAL";
          if (!data.state) data.state = "unknown";
        }
        if (tx.e === "pressure") {
          data.created_at_tx = tx.tx;
        }
        if (tx.e === "relationship") {
          if (!("last_shift" in data)) data.last_shift = null;
          if (!data.status) data.status = "active";
          if (!data.distance) data.distance = "fresh";
          if (!data.intensity) data.intensity = "simmering";
        }
        if (tx.e === "faction") {
          if (!data.tier) data.tier = "KNOWN";
        }
        if (tx.e === "char" && Array.isArray(data.tags)) {
          data.tags = Array.from(new Set(data.tags as unknown[]));
          if ((data.tags as unknown[]).length > CHARACTER_TAGS_MAX) {
            data.tags = (data.tags as unknown[]).slice(0, CHARACTER_TAGS_MAX);
          }
        }
        if (tx.e === "collision") {
          const distCat = data.distance_category as string | undefined;
          if (distCat) {
            data.distance = CATEGORY_DISTANCES[distCat] ?? 10;
          } else {
            data.distance_category = "SHORT";
            if (data.distance == null) data.distance = 10;
          }
          if (!data.status) data.status = "ACTIVE";
        }
        if (tx.id != null) s[collection]![tx.id] = data;
      }
      break;
    }

    case "TR": {
      const target = isSingleton
        ? (s[collection] as unknown as Record<string, unknown>)
        : s[collection]?.[tx.id ?? ""];
      if (!target) {
        if ((tx.tx ?? 0) > 0)
          logger.warn(`[state-compute] TR no-op: entity ${tx.e}:${tx.id} not found (tx ${tx.tx ?? "?"})`);
        break;
      }
      const d = tx.d as Record<string, unknown> | undefined;
      if (d?.f) {
        const oldVal = target[d.f as string];
        const toVal = d.to;
        target[d.f as string] = toVal;
        if (tx.e === "collision" && d.f === "status" && toVal === "CRASHED" && !target.outcome_type) {
          target.outcome_type = "CRASHED";
        }
        if (tx.e === "char" && d.f === "tier") {
          const TIER_ORDER = ["UNKNOWN", "KNOWN", "TRACKED", "PRINCIPAL"];
          const oldTier = TIER_ORDER.indexOf(String(oldVal ?? "").toUpperCase());
          const newTier = TIER_ORDER.indexOf(String(toVal ?? "").toUpperCase());
          if (newTier < oldTier) {
            if (newTier < TIER_ORDER.indexOf("PRINCIPAL")) {
              delete target.agenda;
              delete target.key_moments;
            }
            if (newTier <= TIER_ORDER.indexOf("UNKNOWN")) {
              delete target.location;
            }
          }
        }
        recordHistory(state, tx.e ?? "", tx.id, d.f as string, oldVal, toVal, tx);
        if ((tx.e === "char" || tx.e === "faction") && d.f === "tier") {
          const TIER_ORDER = ["UNKNOWN", "KNOWN", "TRACKED", "PRINCIPAL"];
          const fromIdx = TIER_ORDER.indexOf(String(oldVal ?? "").toUpperCase());
          const toIdx = TIER_ORDER.indexOf(String(toVal ?? "").toUpperCase());
          const trackedIdx = TIER_ORDER.indexOf("TRACKED");
          if (fromIdx >= trackedIdx && toIdx < trackedIdx) {
            adjustRelationshipStatus(state, tx.e, tx.id ?? "", "dormant");
          } else if (fromIdx < trackedIdx && toIdx >= trackedIdx) {
            adjustRelationshipStatus(state, tx.e, tx.id ?? "", "active");
          }
        }
      }
      break;
    }

    case "S": {
      const target = isSingleton
        ? (s[collection] as unknown as Record<string, unknown>)
        : s[collection]?.[tx.id ?? ""];
      if (!target) {
        if ((tx.tx ?? 0) > 0)
          logger.warn(
            `[state-compute] S no-op: entity ${tx.e}:${tx.id} not found (tx ${tx.tx ?? "?"}, field ${(tx.d as Record<string, unknown> | undefined)?.f})`,
          );
        break;
      }
      const d = tx.d as Record<string, unknown> | undefined;
      if (d?.f) {
        let sNorm: { field: string; value: unknown };
        if (tx.e === "constraint") sNorm = normalizeConstraintSField(d.f as string, d.v);
        else if (tx.e === "char") sNorm = normalizeCharacterSField(d.f as string, d.v);
        else sNorm = { field: d.f as string, value: d.v };
        const { field: sField, value: sVal } = sNorm;
        const oldVal = target[sField];
        let newVal = sVal;
        const MAP_BACKED_FIELDS = ["knowledge_asymmetry", "intimate_history", "wounds"];
        if (newVal === null && MAP_BACKED_FIELDS.includes(sField)) newVal = {};
        target[sField] = newVal;
        if (tx.e === "collision" && sField === "status" && newVal === "CRASHED" && !target.outcome_type) {
          target.outcome_type = "CRASHED";
        }
        if (tx.e === "char" && sField === "tags" && Array.isArray(target.tags)) {
          target.tags = Array.from(new Set(target.tags as unknown[]));
          if ((target.tags as unknown[]).length > CHARACTER_TAGS_MAX) {
            target.tags = (target.tags as unknown[]).slice(0, CHARACTER_TAGS_MAX);
          }
        }
        if (oldVal !== newVal) {
          recordHistory(state, tx.e ?? "", tx.id, sField, oldVal, newVal, tx);
        }
      }
      break;
    }

    case "A": {
      const target = isSingleton
        ? (s[collection] as unknown as Record<string, unknown>)
        : s[collection]?.[tx.id ?? ""];
      const d = tx.d as Record<string, unknown> | undefined;
      if (target && d?.f) {
        const field = d.f as string;
        if (!Array.isArray(target[field])) target[field] = [];
        const newVal = typeof d.v === "string" ? d.v : JSON.stringify(d.v);
        const exemptFromFuzzy =
          (tx.e === "world" && field === "collision_archive") ||
          (tx.e === "char" &&
            (field === "key_moments" || field === "intimate_history" || field === "demonstrated_traits")) ||
          (tx.e === "pc" && field === "demonstrated_traits");
        const isDuplicate = (target[field] as unknown[]).some((existing) => {
          const existingStr = typeof existing === "string" ? existing : JSON.stringify(existing);
          if (exemptFromFuzzy) return existingStr === newVal;
          return stringSimilarity(existingStr, newVal) > 0.8;
        });
        if (!isDuplicate) {
          (target[field] as unknown[]).push(d.v);
          recordHistory(state, tx.e ?? "", tx.id, `${field}[]`, undefined, d.v, tx);
          if (tx.e === "world" && field === "collision_archive") {
            const arr = state.world.collision_archive as unknown[];
            if (Array.isArray(arr) && arr.length > MAX_COLLISION_ARCHIVE) {
              state.world.collision_archive = arr.slice(-MAX_COLLISION_ARCHIVE);
            }
          }
          if (tx.e === "char" && field === "tags" && Array.isArray(target.tags)) {
            target.tags = Array.from(new Set(target.tags as unknown[]));
            if ((target.tags as unknown[]).length > CHARACTER_TAGS_MAX) {
              target.tags = (target.tags as unknown[]).slice(0, CHARACTER_TAGS_MAX);
            }
          }
        }
      }
      break;
    }

    case "R": {
      const target = isSingleton
        ? (s[collection] as unknown as Record<string, unknown>)
        : s[collection]?.[tx.id ?? ""];
      const d = tx.d as Record<string, unknown> | undefined;
      if (target && d?.f && Array.isArray(target[d.f as string])) {
        const field = d.f as string;
        const beforeLength = (target[field] as unknown[]).length;
        target[field] = (target[field] as unknown[]).filter((item) =>
          typeof item === "string" ? item !== d.v : JSON.stringify(item) !== JSON.stringify(d.v),
        );
        if ((target[field] as unknown[]).length !== beforeLength) {
          recordHistory(state, tx.e ?? "", tx.id, `${field}[]`, d.v, undefined, tx);
        }
      }
      break;
    }

    case "MS": {
      const target = isSingleton
        ? (s[collection] as unknown as Record<string, unknown>)
        : s[collection]?.[tx.id ?? ""];
      const d = tx.d as Record<string, unknown> | undefined;
      if (target && d?.f) {
        const field = d.f as string;
        const key = d.k as string;
        const dotted = key?.includes(".");
        let fieldVal = target[field];
        if (fieldVal === null) {
          target[field] = {};
          fieldVal = target[field];
        }
        if (typeof fieldVal !== "object" || Array.isArray(fieldVal)) {
          target[field] = {};
        }
        if (dotted && field === "knowledge_asymmetry") {
          const flatKey = key.replace(/\./g, "_");
          const kaObj = target[field] as Record<string, unknown>;
          const oldVal = kaObj[flatKey];
          kaObj[flatKey] = d.v;
          if (oldVal !== d.v) {
            recordHistory(state, tx.e ?? "", tx.id, `${field}.${flatKey}`, oldVal, d.v, tx);
          }
        } else if (dotted) {
          const keyParts = key.split(".");
          let obj = target[field] as Record<string, unknown>;
          for (let i = 0; i < keyParts.length - 1; i++) {
            const k = keyParts[i]!;
            if (typeof obj[k] !== "object" || obj[k] === null || Array.isArray(obj[k])) {
              obj[k] = {};
            }
            obj = obj[k] as Record<string, unknown>;
          }
          const leafKey = keyParts[keyParts.length - 1]!;
          const oldVal = obj[leafKey];
          obj[leafKey] = d.v;
          if (oldVal !== d.v) {
            recordHistory(state, tx.e ?? "", tx.id, `${field}.${key}`, oldVal, d.v, tx);
          }
        } else {
          const mapObj = target[field] as Record<string, unknown>;
          const oldVal = mapObj[key];
          mapObj[key] = d.v;
          if (oldVal !== d.v) {
            recordHistory(state, tx.e ?? "", tx.id, `${field}.${key}`, oldVal, d.v, tx);
          }
        }
        if (
          field === "knowledge_asymmetry" &&
          typeof target.knowledge_asymmetry === "object" &&
          target.knowledge_asymmetry !== null
        ) {
          const kaObj = target.knowledge_asymmetry as Record<string, unknown>;
          const kaKeys = Object.keys(kaObj);
          if (kaKeys.length > 20) {
            for (const k of kaKeys.slice(0, kaKeys.length - 20)) delete kaObj[k];
          }
        }
      }
      break;
    }

    case "MR": {
      const target = isSingleton
        ? (s[collection] as unknown as Record<string, unknown>)
        : s[collection]?.[tx.id ?? ""];
      const d = tx.d as Record<string, unknown> | undefined;
      if (target && d?.f) {
        const field = d.f as string;
        const key = d.k as string;
        if (key?.includes(".")) {
          const keyParts = key.split(".");
          let obj = target[field] as Record<string, unknown> | undefined;
          if (typeof obj !== "object" || Array.isArray(obj)) break;
          for (let i = 0; i < keyParts.length - 1; i++) {
            obj = obj?.[keyParts[i]!] as Record<string, unknown> | undefined;
            if (typeof obj !== "object" || Array.isArray(obj)) break;
          }
          if (obj && typeof obj === "object") {
            const leafKey = keyParts[keyParts.length - 1]!;
            const oldVal = obj[leafKey];
            delete obj[leafKey];
            recordHistory(state, tx.e ?? "", tx.id, `${field}.${key}`, oldVal, undefined, tx);
          }
        } else if (typeof target[field] === "object") {
          const mapObj = target[field] as Record<string, unknown>;
          const oldVal = mapObj[key];
          delete mapObj[key];
          recordHistory(state, tx.e ?? "", tx.id, `${field}.${key}`, oldVal, undefined, tx);
        }
      }
      break;
    }

    case "D": {
      if (!isSingleton && tx.id != null) {
        if (tx.e === "char" || tx.e === "faction") {
          const entity = s[collection]?.[tx.id];
          const relId = `pc-${tx.id}`;
          const rel = state.relationships?.[relId];
          if (rel && (entity as Record<string, unknown>)?.name) {
            rel.display_name = (entity as Record<string, unknown>).name;
          }
          adjustRelationshipStatus(state, tx.e, tx.id, "archived");
          const fqId = `${tx.e}:${tx.id}`;
          if (state.pc && Array.isArray(state.pc.scene_cast)) {
            state.pc.scene_cast = (state.pc.scene_cast as string[]).filter((ref) => ref !== fqId);
          }
        }
        delete s[collection]![tx.id];
      }
      break;
    }

    case "AMEND":
      break;

    default:
      break;
  }

  // Stamp last_active_tx on any char-touching transaction.
  if (tx.e === "char" && tx.id) {
    const ch = state.characters?.[tx.id];
    if (ch) ch.last_active_tx = tx.tx;
  }

  state.lastTxId = tx.tx ?? state.lastTxId;
  return state;
}

// ─── Full state computation ────────────────────────────────────────────────────

/**
 * Compute full state from a snapshot plus transactions.
 * Pass null as snapshot for a full replay from empty state.
 */
export function computeState(snapshot: GravityState | null, transactions: RawTransaction[]): GravityState {
  const state = snapshot ? structuredClone(snapshot) : createEmptyState();

  // Ensure fields that may be missing from old snapshots are present
  if (!state._history) state._history = {};
  if (!state.factions) state.factions = {};
  if (!state.divination)
    state.divination = { active_system: "arcana", last_draw: null, readings: [] };
  if (!state.relationships) state.relationships = {};

  // First pass: collect amendments
  const amendments = new Map<number, Record<string, unknown>>();
  for (const tx of transactions) {
    const d = tx.d as Record<string, unknown> | undefined;
    if (tx.op === "AMEND" && d?.target_tx != null && d?.correction) {
      amendments.set(d.target_tx as number, d.correction as Record<string, unknown>);
    }
  }

  // Second pass: apply
  for (const tx of transactions) {
    if (tx.op === "SNAP" || tx.op === "ROLL" || tx.op === "AMEND") continue;

    if (tx.tx != null && amendments.has(tx.tx)) {
      applyTransaction(state, {
        ...(amendments.get(tx.tx) as unknown as RawTransaction),
        tx: tx.tx,
      });
    } else {
      applyTransaction(state, tx);
    }
  }

  normalizeArrayFields(state);
  normalizeCharacterKnowledgeAsymmetry(state);
  normalizeFactionKnowledgeAsymmetry(state);

  return state;
}

// ─── Diff utility ─────────────────────────────────────────────────────────────

export function diffStates(
  before: GravityState,
  after: GravityState,
): Array<{ entity: string; id: string; type: string; field?: string; from?: unknown; to?: unknown; data?: unknown }> {
  const changes: Array<{
    entity: string;
    id: string;
    type: string;
    field?: string;
    from?: unknown;
    to?: unknown;
    data?: unknown;
  }> = [];
  for (const col of ["characters", "constraints", "collisions", "factions", "places", "pressures"]) {
    const bc = (before as unknown as Record<string, Record<string, Record<string, unknown>>>)[col] ?? {};
    const ac = (after as unknown as Record<string, Record<string, Record<string, unknown>>>)[col] ?? {};
    for (const id of Object.keys(ac)) {
      if (!bc[id]) {
        changes.push({ entity: col, id, type: "created", data: ac[id]! });
        continue;
      }
      for (const field of new Set([...Object.keys(bc[id]!), ...Object.keys(ac[id]!)])) {
        if (JSON.stringify(bc[id]![field]) !== JSON.stringify(ac[id]![field])) {
          changes.push({ entity: col, id, type: "changed", field, from: bc[id]![field], to: ac[id]![field] });
        }
      }
    }
    for (const id of Object.keys(bc)) {
      if (!ac[id]) changes.push({ entity: col, id, type: "deleted" });
    }
  }
  for (const singleton of ["world", "pc", "divination"]) {
    const bSingle = (before as unknown as Record<string, Record<string, unknown>>)[singleton] ?? {};
    const aSingle = (after as unknown as Record<string, Record<string, unknown>>)[singleton] ?? {};
    for (const field of new Set([...Object.keys(bSingle), ...Object.keys(aSingle)])) {
      if (JSON.stringify(bSingle[field]) !== JSON.stringify(aSingle[field])) {
        changes.push({ entity: singleton, id: singleton, type: "changed", field, from: bSingle[field], to: aSingle[field] });
      }
    }
  }
  return changes;
}

// ─── Travel Plausibility ──────────────────────────────────────────────────────

const TRAVEL_REACH_ORDER = ["LOCAL", "DISTRICT", "CITY", "REGIONAL", "REMOTE"];
const ON_FOOT_MAX = "DISTRICT";

export function validateTravel(
  charId: string,
  fromPlaceId: string,
  toPlaceId: string,
  state: GravityState,
  turnMode: string,
): { valid: boolean; error?: string; fix?: string } {
  if (turnMode === "advance") return { valid: true };
  const fromPlace = state.places?.[fromPlaceId];
  const toPlace = state.places?.[toPlaceId];
  if (!fromPlace || !toPlace) return { valid: true };
  if (fromPlaceId === toPlaceId) return { valid: true };
  const fromIdx = TRAVEL_REACH_ORDER.indexOf((fromPlace.reach as string) ?? "LOCAL");
  const toIdx = TRAVEL_REACH_ORDER.indexOf((toPlace.reach as string) ?? "LOCAL");
  const maxIdx = TRAVEL_REACH_ORDER.indexOf(ON_FOOT_MAX);
  if (toIdx > maxIdx || fromIdx > maxIdx) {
    return {
      valid: false,
      error: `Travel from "${fromPlace.name}" (${fromPlace.reach}) to "${toPlace.name}" (${toPlace.reach}) is implausible in a 15-minute scene window.`,
      fix: `Use an ADVANCE turn to timeskip travel, or add a narrative justification (vehicle, special transport) before the location change.`,
    };
  }
  return { valid: true };
}

function getPhonebook(state: GravityState): {
  principal: string | null;
  tracked: string[];
  known: string[];
} {
  const result: { principal: string | null; tracked: string[]; known: string[] } = {
    principal: null,
    tracked: [],
    known: [],
  };
  for (const char of Object.values(state.characters)) {
    switch (char.tier) {
      case "PRINCIPAL":
        result.principal = (char.name ?? char.id) as string;
        break;
      case "TRACKED":
        result.tracked.push((char.name ?? char.id) as string);
        break;
      case "KNOWN":
        result.known.push((char.name ?? char.id) as string);
        break;
    }
  }
  return result;
}

// Export getPhonebook for potential use by director modules
export { getPhonebook };
