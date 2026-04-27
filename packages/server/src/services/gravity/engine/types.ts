// ──────────────────────────────────────────────
// Gravity Engine — Shared Types
// ──────────────────────────────────────────────

export type TxOp = "CR" | "S" | "TR" | "A" | "R" | "MS" | "MR" | "D" | "SNAP" | "ROLL" | "AMEND";

export type EntityType =
  | "char"
  | "constraint"
  | "collision"
  | "combat"
  | "faction"
  | "place"
  | "pressure"
  | "world"
  | "pc"
  | "divination"
  | "relationship";

export type TurnMode = "regular" | "advance" | "combat" | "intimacy" | "integration";

export interface RawTransaction {
  op: TxOp;
  e?: EntityType;
  id?: string;
  d?: Record<string, unknown>;
  r?: string; // reason tag (engine-generated)
  /** Sequence number (stamped by engine at commit time; absent on pre-commit transactions). */
  tx?: number;
  /** Turn identifier. */
  t?: string;
  /** ISO timestamp. */
  _ts?: string;
}

export interface GravityState {
  characters: Record<string, Record<string, unknown>>;
  constraints: Record<string, Record<string, unknown>>;
  collisions: Record<string, Record<string, unknown>>;
  combats: Record<string, Record<string, unknown>>;
  factions: Record<string, Record<string, unknown>>;
  places: Record<string, Record<string, unknown>>;
  pressures: Record<string, Record<string, unknown>>;
  relationships: Record<string, Record<string, unknown>>;
  world: Record<string, unknown>;
  pc: Record<string, unknown>;
  divination: Record<string, unknown>;
  lastTxId: number;
  _history: Record<string, unknown[]>;
}

export interface ValidationError {
  field?: string;
  message: string;
  fix?: string;
}

export interface ValidationResult {
  valid: RawTransaction[];
  errors: Record<string, ValidationError[]>;
}

export interface TransitionResult {
  valid: boolean;
  error?: string;
  fix?: string;
}
