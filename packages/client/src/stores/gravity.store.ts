// ──────────────────────────────────────────────
// Zustand Store: Gravity Ledger Slice
// ──────────────────────────────────────────────
import { create } from "zustand";

export interface GravityDirectorResult {
  committed: number;
  rejected: number;
  newArrivalIds: string[];
  durationMs: number;
  model: string;
}

interface GravityState {
  /** Result from the most recent director run. */
  lastDirectorResult: GravityDirectorResult | null;
  /** Running total of committed transactions across all turns this session. */
  totalCommitted: number;
  /** Archive version fingerprint from the last inject run. */
  archiveVersion: string | null;

  setDirectorResult: (result: GravityDirectorResult) => void;
  setArchiveVersion: (v: string) => void;
  reset: () => void;
}

export const useGravityStore = create<GravityState>((set) => ({
  lastDirectorResult: null,
  totalCommitted: 0,
  archiveVersion: null,

  setDirectorResult: (result) =>
    set((s) => ({
      lastDirectorResult: result,
      totalCommitted: s.totalCommitted + result.committed,
    })),

  setArchiveVersion: (archiveVersion) => set({ archiveVersion }),

  reset: () => set({ lastDirectorResult: null, totalCommitted: 0, archiveVersion: null }),
}));
