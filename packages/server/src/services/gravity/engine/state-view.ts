/**
 * state-view.ts — Format computed state for prompt injection.
 *
 * TypeScript port of ST/state-view.js. Logic is identical; only types added.
 *
 * Provides:
 * 1. formatStateView(state, mode?) — full state overview injected pre-generation
 * 2. computeArchiveVersion(state) — fingerprint to skip redundant archive re-injection
 * 3. buildNudge(mode, state) — turn-mode deduction template
 * 4. buildRecentTail(txns, n?) — last N accepted transactions as JSON string
 */

import { logger } from "../../../lib/logger.ts";
import type { GravityState, TurnMode, RawTransaction } from "./types.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────────

type EntityObj = Record<string, unknown>;

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function formatCardName(slug: unknown): string {
  if (!slug || typeof slug !== "string") return "";
  return slug
    .split("-")
    .map((w) => {
      if (w.length <= 2) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function getCollisionForcesText(col: EntityObj): string {
  if (Array.isArray(col["forces"])) {
    return (col["forces"] as unknown[])
      .map((force) => {
        if (force && typeof force === "object") {
          return normalizeText((force as EntityObj)["name"] ?? force);
        }
        return normalizeText(force);
      })
      .filter(Boolean)
      .join(" | ");
  }
  return normalizeText(col["forces"]);
}

function getCollisionNarrativeLines(col: EntityObj): string[] {
  const lines: string[] = [];
  if (col["forces"]) lines.push(`Forces: ${getCollisionForcesText(col)}`);
  if (col["cost"]) lines.push(`Scenario: ${normalizeText(col["cost"])}`);
  if (col["ignition_class"] || col["fires_when"]) {
    const cls = col["ignition_class"] ? String(col["ignition_class"]).toLowerCase() : "";
    const trigger = col["fires_when"] ? normalizeText(col["fires_when"]) : "";
    if (cls && trigger) lines.push(`Ignition: ${cls} — fires when ${trigger}`);
    else if (cls) lines.push(`Ignition: ${cls}`);
    else lines.push(`Fires when: ${trigger}`);
  }
  if (col["location"]) lines.push(`Location: ${String(col["location"])}`);
  const involved = toList(col["involved_chars"]);
  if (involved.length) lines.push(`Involved: ${involved.join(", ")}`);
  if (col["aftermath"]) lines.push(`Aftermath: ${String(col["aftermath"])}`);
  return lines;
}

function toList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return (value as unknown[]).filter(Boolean).map(String);
  return [String(value)];
}

function formatPowerTag(entity: EntityObj): string {
  const hasCurrent = entity["power"] != null;
  const hasBase = entity["power_base"] != null;
  if (!hasCurrent && !hasBase) return "";
  if (hasCurrent && hasBase) return ` [power:${String(entity["power"])}|base:${String(entity["power_base"])}]`;
  return hasCurrent ? ` [power:${String(entity["power"])}]` : ` [base:${String(entity["power_base"])}]`;
}

function formatRelationshipStage(rel: EntityObj): string {
  const d = rel["distance"];
  const i = rel["intensity"];
  if (typeof d !== "string" || typeof i !== "string") return "";
  return ` · ${d} / ${i}`;
}

function formatCollisionArchive(state: GravityState): string {
  const world = state.world as EntityObj;
  const archiveEntries = Array.isArray(world["collision_archive"]) ? (world["collision_archive"] as unknown[]) : [];
  if (!archiveEntries.length) return "";
  const activeCollisionCount = Object.values(state.collisions).filter(
    (c) => (String((c as EntityObj)["status"] ?? "")).toUpperCase() === "ACTIVE",
  ).length;
  if (activeCollisionCount > 2) return "";
  const lines = ["Collision Archive (last resolved — pool is thin, seed new collisions from these hooks):"];
  for (const entry of archiveEntries.slice(-5)) {
    lines.push(`  • ${String(entry ?? "")}`);
  }
  return lines.join("\n");
}

// ─── formatChallenge ───────────────────────────────────────────────────────────

function formatChallenge(challenge: EntityObj, { compact = false } = {}): string[] {
  const type = String(challenge["kind"] ?? challenge["challenge_type"] ?? "combat");
  const lines: string[] = [];
  if (type === "combat") {
    if (compact) {
      let combatLine = `  ${String(challenge["name"] ?? challenge["id"] ?? "")} [${String(challenge["status"] ?? "ACTIVE")}]`;
      if (challenge["primary_enemy"]) {
        const pe =
          typeof challenge["primary_enemy"] === "object"
            ? String((challenge["primary_enemy"] as EntityObj)["name"] ?? (challenge["primary_enemy"] as EntityObj)["id"] ?? "?")
            : String(challenge["primary_enemy"]);
        combatLine += ` vs ${pe}`;
      }
      if (challenge["opened_from"]) combatLine += ` (from collision:${String(challenge["opened_from"])})`;
      combatLine += ` → id: ${String(challenge["id"] ?? "")}`;
      lines.push(combatLine);
    } else {
      lines.push(`  ⚔ ${String(challenge["name"] ?? challenge["id"] ?? "")} [${String(challenge["status"] ?? "ACTIVE")}] → id: ${String(challenge["id"] ?? "")}`);
      if (challenge["primary_enemy"]) {
        const pe =
          typeof challenge["primary_enemy"] === "object"
            ? String((challenge["primary_enemy"] as EntityObj)["name"] ?? (challenge["primary_enemy"] as EntityObj)["id"] ?? "?")
            : String(challenge["primary_enemy"]);
        lines.push(`    Primary enemy: ${pe}`);
      }
      if (challenge["opened_from"]) lines.push(`    Opened from: collision:${String(challenge["opened_from"])}`);
      if (challenge["outcome"]) lines.push(`    Outcome: ${String(challenge["outcome"])}`);
      if (challenge["aftermath"]) lines.push(`    Aftermath: ${String(challenge["aftermath"])}`);
    }
    return lines;
  }
  return lines;
}

// ─── computeArchiveVersion ────────────────────────────────────────────────────

/**
 * Fingerprint used to skip redundant archive re-injection (§4.3).
 */
export function computeArchiveVersion(state: GravityState): string {
  const world = state.world as EntityObj;
  const archiveEntries = Array.isArray(world["collision_archive"]) ? (world["collision_archive"] as unknown[]) : [];
  const activeCollisionCount = Object.values(state.collisions).filter(
    (c) => (String((c as EntityObj)["status"] ?? "")).toUpperCase() === "ACTIVE",
  ).length;
  const thin = activeCollisionCount <= 2 ? "thin" : "ok";
  const fingerprint = archiveEntries
    .slice(-5)
    .map((e) => String(e ?? "").slice(0, 20))
    .join("|");
  return `${archiveEntries.length}:${thin}:${fingerprint}`;
}

// ─── formatStateView ──────────────────────────────────────────────────────────

type FormatMode = "full" | "lite" | "combat" | "intimacy";
type FormatOpts = FormatMode | { mode?: FormatMode; includeArchive?: boolean };

/**
 * Format the full state into a prompt-friendly string.
 * Includes entity IDs so the LLM knows exactly what to target in ledger transactions.
 */
export function formatStateView(
  state: GravityState,
  modeOrOpts: FormatOpts = "full",
  includeArchiveArg = true,
): string {
  let mode: FormatMode;
  let includeArchive: boolean;
  if (modeOrOpts && typeof modeOrOpts === "object") {
    mode = modeOrOpts.mode ?? "full";
    includeArchive = modeOrOpts.includeArchive !== undefined ? modeOrOpts.includeArchive : true;
  } else {
    mode = modeOrOpts;
    includeArchive = includeArchiveArg;
  }

  const lines: string[] = [];
  const isLite = mode === "lite";
  const isCombat = mode === "combat";
  const isIntimacy = mode === "intimacy";
  const isFull = mode === "full";
  const showPower = isCombat || isFull;
  const showIntimacy = isIntimacy || isFull;
  const showConstraintDetail = isIntimacy || isFull;
  const showConstants = isCombat || isFull;
  const showFullDetail = isFull;

  lines.push("═══ GRAVITY STATE VIEW ═══");
  lines.push("");
  lines.push("ENTITY REGISTRY — use these IDs in ledger transactions");

  // ── Characters ──────────────────────────────────────────────────────────

  lines.push("");
  lines.push("Characters:");

  const renderFullCharDossier = (id: string, char: EntityObj): void => {
    const tier = String(char["tier"] ?? "KNOWN");
    const isPrincipal = tier === "PRINCIPAL";
    lines.push(`CHARACTER: ${String(char["name"] ?? id)} [${tier}] → id: ${id}`);
    if (char["location"]) lines.push(`    Location: ${String(char["location"])}`);
    if (Array.isArray(char["tags"]) && (char["tags"] as unknown[]).length > 0) {
      lines.push(`    Tags: [${(char["tags"] as unknown[]).join(", ")}]`);
    }
    const rel = state.relationships[`pc-${id}`] as EntityObj | undefined;
    if (rel && rel["status"] === "active") {
      const orientLabel = rel["orientation"] === "reversed" ? "reversed" : "upright";
      lines.push(`    ♥ Bond (PC): ${formatCardName(rel["card"])} · ${orientLabel}${formatRelationshipStage(rel)}`);
      if (rel["nuance"]) lines.push(`      "${String(rel["nuance"])}"`);
    }
    const ka = char["knowledge_asymmetry"];
    if (ka !== undefined && ka !== null) {
      if (typeof ka === "object" && !Array.isArray(ka)) {
        const kaLines: string[] = [];
        for (const [k, v] of Object.entries(ka as Record<string, unknown>)) {
          if (typeof v === "string" && v) kaLines.push(`      ${k}: ${v}`);
        }
        if (kaLines.length) {
          lines.push("    Knowledge asymmetry:");
          lines.push(...kaLines);
        }
      }
    }
    if (char["agenda"]) lines.push(`    Agenda: ${normalizeText(char["agenda"])}`);
    if (char["last_seen_at"] !== undefined && char["last_seen_at"] !== null && normalizeText(char["last_seen_at"])) {
      lines.push(`    Last seen at: ${normalizeText(char["last_seen_at"])}`);
    }
    if (showPower) {
      const powerTag = formatPowerTag(char);
      if (powerTag) lines.push(`    Power:${powerTag.replace(/^\s*\[/, " [")}`);
      if (char["power_basis"]) lines.push(`    Power basis: ${String(char["power_basis"])}`);
      const abilities = toList(char["abilities"]);
      if (abilities.length) lines.push(`    Abilities: ${abilities.join(" | ")}`);
      const wounds = char["wounds"];
      if (wounds && typeof wounds === "object" && Object.keys(wounds as object).length) {
        const woundList = Object.entries(wounds as Record<string, unknown>)
          .map(([k, v]) => `${k}: ${String(v)}`)
          .join(", ");
        lines.push(`    Wounds: ${woundList}`);
      }
    }
    if (isPrincipal) {
      const moments = Array.isArray(char["key_moments"]) ? (char["key_moments"] as unknown[]) : [];
      const displayMoments = moments.slice(-10);
      if (displayMoments.length) {
        const capNote = moments.length > displayMoments.length ? `, showing last ${displayMoments.length}` : "";
        lines.push(`    Key moments (${moments.length}${capNote}):`);
        for (const m of displayMoments) lines.push(`      - ${String(m)}`);
      }
    }
  };

  const castSet = new Set(
    Array.isArray(state.pc["scene_cast"]) ? (state.pc["scene_cast"] as unknown[]).map(String) : [],
  );
  const currentPlace = String(state.pc["current_place_id"] ?? "");
  const currentPlaceBare = currentPlace.startsWith("place:") ? currentPlace.slice("place:".length) : currentPlace;

  type CharEntry = [string, EntityObj];
  type CharRelEntry = [string, EntityObj, EntityObj];

  const inCast: CharEntry[] = [];
  const inCastKnown: CharEntry[] = [];
  const offStagePrincipal: CharEntry[] = [];
  const offStageTracked: CharEntry[] = [];
  const dormantOnStageByLocation: CharRelEntry[] = [];
  const knownList: CharEntry[] = [];

  for (const [id, charRaw] of Object.entries(state.characters)) {
    const char = charRaw as EntityObj;
    if (char["tier"] === "UNKNOWN") continue;
    const fqId = `char:${id}`;
    const tier = String(char["tier"] ?? "KNOWN").toUpperCase();
    const onStage = castSet.has(fqId);
    const rel = state.relationships[`pc-${id}`] as EntityObj | undefined;
    const isDormantOnStage =
      rel &&
      rel["status"] === "dormant" &&
      currentPlaceBare &&
      (char["location"] === currentPlaceBare || char["location"] === currentPlace);

    if (onStage && (tier === "TRACKED" || tier === "PRINCIPAL")) {
      inCast.push([id, char]);
    } else if (onStage && tier === "KNOWN") {
      inCastKnown.push([id, char]);
    } else if (tier === "PRINCIPAL") {
      offStagePrincipal.push([id, char]);
    } else if (tier === "TRACKED") {
      offStageTracked.push([id, char]);
    } else if (isDormantOnStage && rel) {
      dormantOnStageByLocation.push([id, char, rel]);
    } else if (tier === "KNOWN") {
      knownList.push([id, char]);
    }
  }

  for (const [id, char] of inCast) {
    renderFullCharDossier(id, char);
  }
  for (const [id, char] of inCastKnown) {
    lines.push(`CHARACTER: ${String(char["name"] ?? id)} [KNOWN · on-stage] → id: ${id}`);
    if (char["location"]) lines.push(`    Location: ${String(char["location"])}`);
    if (Array.isArray(char["tags"]) && (char["tags"] as unknown[]).length > 0) {
      lines.push(`    Tags: [${(char["tags"] as unknown[]).join(", ")}]`);
    }
    if (char["agenda"]) lines.push(`    Agenda: ${normalizeText(char["agenda"])}`);
  }
  for (const [id, char] of offStagePrincipal) {
    const rel = state.relationships[`pc-${id}`] as EntityObj | undefined;
    const cardFrag =
      rel && rel["status"] === "active"
        ? ` · Bond (PC): ${formatCardName(rel["card"])} · ${String(rel["orientation"] ?? "")}${formatRelationshipStage(rel)}`
        : "";
    const loc = char["location"] ? ` — last seen ${String(char["location"])}` : "";
    lines.push(`PRINCIPAL (off-stage): ${String(char["name"] ?? id)}${loc}${cardFrag} → id: ${id}`);
    if (Array.isArray(char["tags"]) && (char["tags"] as unknown[]).length > 0) {
      lines.push(`    Tags: [${(char["tags"] as unknown[]).join(", ")}]`);
    }
  }
  for (const [id, char] of offStageTracked) {
    const loc = char["location"] ? ` @ ${String(char["location"])}` : "";
    lines.push(`TRACKED (off-stage): ${String(char["name"] ?? id)}${loc} → id: ${id}`);
  }
  for (const [id, char, rel] of dormantOnStageByLocation) {
    lines.push(`DORMANT (on-stage): ${String(char["name"] ?? id)} · ${formatCardName(rel["card"])} ${String(rel["orientation"] ?? "")} → id: ${id}`);
    if (rel["nuance"]) lines.push(`    "${String(rel["nuance"])}"`);
  }

  if (knownList.length > 0) {
    const sorted = knownList.slice().sort(([, a], [, b]) => {
      return (Number(b["last_active_tx"] ?? 0)) - (Number(a["last_active_tx"] ?? 0));
    });
    const TOP_N = 15;
    const top = sorted.slice(0, TOP_N);
    const older = sorted.slice(TOP_N);

    lines.push("");
    lines.push(`KNOWN (${top.length} most-recently-active${older.length ? `; ${older.length} older below` : ""}):`);
    for (const [id, char] of top) {
      const tagsFrag =
        Array.isArray(char["tags"]) && (char["tags"] as unknown[]).length > 0
          ? ` [${(char["tags"] as unknown[]).join(", ")}]`
          : "";
      const fallback = !tagsFrag && char["agenda"] ? ` — "${normalizeText(char["agenda"]).slice(0, 80)}"` : "";
      const locFallback = !tagsFrag && !char["agenda"] && char["location"] ? ` @ ${String(char["location"])}` : "";
      lines.push(`  • ${String(char["name"] ?? id)}${tagsFrag}${fallback}${locFallback} → id: ${id}`);
    }
    if (older.length > 0) {
      const names = older.map(([, c]) => String(c["name"] ?? "<unnamed>")).join(", ");
      lines.push(`Older KNOWN (${older.length} inactive): ${names}`);
    }
  }

  if (Object.keys(state.characters).length === 0) lines.push("  (none)");

  // ── Constraints ──────────────────────────────────────────────────────────

  const constraints = Object.values(state.constraints) as EntityObj[];
  if (constraints.length) {
    lines.push("");
    lines.push("Constraints:");
    for (const c of constraints) {
      const owner = state.characters[String(c["owner_id"] ?? "")] as EntityObj | undefined;
      const ownerName = String(owner?.["name"] ?? c["owner_id"] ?? "");
      const drifts: string[] = [];
      if (!c["owner_id"]) {
        const aliasChar = typeof c["char"] === "string" && c["char"] ? (c["char"] as string).replace(/^char:/, "") : "";
        drifts.push(
          aliasChar
            ? `owner_id missing — 'char' was used instead. Fix: S constraint:${String(c["id"] ?? "")} field=owner_id value=${aliasChar}`
            : `owner_id missing. Fix: S constraint:${String(c["id"] ?? "")} field=owner_id value=<char_id>`,
        );
      }
      if (!c["integrity"]) {
        drifts.push(`integrity missing. Fix: S constraint:${String(c["id"] ?? "")} field=integrity value=<STABLE|STRESSED|CRITICAL|BREACHED>`);
      }
      if (!c["name"]) {
        drifts.push(`name missing. Fix: S constraint:${String(c["id"] ?? "")} field=name value="..."`);
      }
      let cLine = `  ${String(c["name"] ?? "(unnamed)")} [${String(c["integrity"] ?? "UNKNOWN")}] (${ownerName || "?"})`;
      if (c["shedding_order"]) cLine += ` shed:${String(c["shedding_order"])}`;
      cLine += ` → id: ${String(c["id"] ?? "")}`;
      lines.push(cLine);
      for (const d of drifts) lines.push(`    [SCHEMA DRIFT] ${d}`);
      if (isCombat && !showConstraintDetail && c["current_pressure"]) {
        lines.push(`    Pressure: ${String(c["current_pressure"])}`);
      }
      if (showConstraintDetail) {
        if (c["profile"]) {
          lines.push(`    ${String(c["profile"])}`);
        } else {
          if (c["prevents"]) lines.push(`    Prevents: ${String(c["prevents"])}`);
          if (c["threshold"]) lines.push(`    Threshold: ${String(c["threshold"])}`);
          if (c["replacement"]) lines.push(`    Replacement: ${String(c["replacement"])}${c["replacement_type"] ? ` (${String(c["replacement_type"])})` : ""}`);
        }
        if (c["current_pressure"]) lines.push(`    Pressure: ${String(c["current_pressure"])}`);
      }
    }
  }

  // ── Collisions registry ──────────────────────────────────────────────────

  const allCollisions = Object.values(state.collisions).filter(
    (c) => (c as EntityObj)["status"] !== "RESOLVED" && (c as EntityObj)["status"] !== "CRASHED",
  ) as EntityObj[];
  if (allCollisions.length) {
    lines.push("");
    lines.push("Collisions:");
    for (const col of allCollisions) {
      const catLabel = col["distance_category"] ? ` ${String(col["distance_category"])}` : "";
      let colLine = `  ${String(col["name"] ?? col["id"] ?? "")} [${String(col["status"] ?? "")}]${catLabel} dist:${col["distance"] != null ? String(col["distance"]) : "?"}`;
      colLine += ` → id: ${String(col["id"] ?? "")}`;
      lines.push(colLine);
    }
  }

  // ── Combats registry ─────────────────────────────────────────────────────

  const activeCombats = Object.values(state.combats).filter(
    (combat) => String((combat as EntityObj)["status"] ?? "").toUpperCase() !== "RESOLVED",
  ) as EntityObj[];
  if (activeCombats.length) {
    lines.push("");
    lines.push("Combats:");
    for (const combat of activeCombats) {
      lines.push(...formatChallenge(combat, { compact: true }));
    }
  }

  // ── Singletons ───────────────────────────────────────────────────────────

  lines.push("");
  lines.push("Singletons (no id needed):");
  lines.push("  world — power_scale, power_ceiling, power_notes, world_state, collision_archive");
  const pc = state.pc as EntityObj;
  if (pc["name"]) {
    let pcSingleton = `  pc — "${String(pc["name"])}"`;
    if (pc["location"] && !pc["current_scene"]) pcSingleton += ` @ ${String(pc["location"])}`;
    lines.push(pcSingleton);
    if (pc["current_scene"]) {
      lines.push(`    SCENE: ${String(pc["current_scene"])}`);
    }
    if (showPower) {
      if (pc["equipment"]) lines.push(`    Equipment: ${String(pc["equipment"])}`);
      if (pc["power_basis"]) lines.push(`    Power basis: ${String(pc["power_basis"])}`);
      const pcAbilities = toList(pc["abilities"]);
      if (pcAbilities.length) lines.push(`    Abilities: ${pcAbilities.join(" | ")}`);
      const pcWounds = pc["wounds"] && typeof pc["wounds"] === "object" ? (pc["wounds"] as Record<string, unknown>) : {};
      if (Object.keys(pcWounds).length) {
        lines.push(`    Wounds: ${Object.entries(pcWounds).map(([k, v]) => `${k}: ${String(v)}`).join(", ")}`);
      }
    }
  } else {
    lines.push("  pc — (not initialized)");
  }

  const div = state.divination as EntityObj;
  const divSys = div["active_system"];
  if (divSys) {
    if (isLite) {
      lines.push(`  divination — system: ${String(divSys)}`);
    } else {
      lines.push(`  divination — system: ${String(divSys)}${div["last_draw"] ? `, last draw: ${String(div["last_draw"])}` : ""}`);
    }
  }

  // ── Factions ─────────────────────────────────────────────────────────────

  const factionEntities = Object.values(state.factions) as EntityObj[];
  if (factionEntities.length) {
    lines.push("");
    lines.push("Factions:");

    const renderFullFaction = (id: string, faction: EntityObj): void => {
      const territoryStr = Array.isArray(faction["territory"])
        ? (faction["territory"] as unknown[]).join(", ")
        : (faction["territory"] ? String(faction["territory"]) : "");
      const territory = territoryStr ? ` @ ${territoryStr}` : "";
      const fState = faction["state"] ? ` [${String(faction["state"])}]` : "";
      lines.push(`  ${String(faction["name"] ?? id)}${territory}${fState} → id: ${id}`);
      if (Array.isArray(faction["tags"]) && (faction["tags"] as unknown[]).length > 0) {
        lines.push(`    Tags: [${(faction["tags"] as unknown[]).join(", ")}]`);
      }
      const rel = state.relationships[`pc-${id}`] as EntityObj | undefined;
      if (rel && rel["status"] === "active") {
        const orientLabel = rel["orientation"] === "reversed" ? "reversed" : "upright";
        lines.push(`    ♥ Bond (PC): ${formatCardName(rel["card"])} · ${orientLabel}${formatRelationshipStage(rel)}`);
        if (rel["nuance"]) lines.push(`      "${String(rel["nuance"])}"`);
      }
      if (isLite) {
        const ka = faction["knowledge_asymmetry"];
        if (ka && typeof ka === "object" && !Array.isArray(ka)) {
          for (const [k, v] of Object.entries(ka as Record<string, unknown>)) {
            if (typeof v === "string" && v) lines.push(`    ${k}: ${v}`);
          }
        }
      }
    };

    const inCastFaction: CharEntry[] = [];
    const inCastKnownFaction: CharEntry[] = [];
    const offStagePrincipalFaction: CharEntry[] = [];
    const offStageTrackedFaction: CharEntry[] = [];
    const dormantOnStageFaction: CharRelEntry[] = [];
    const knownFactionList: CharEntry[] = [];

    for (const [id, factionRaw] of Object.entries(state.factions)) {
      const faction = factionRaw as EntityObj;
      const fqId = `faction:${id}`;
      const tier = String(faction["tier"] ?? "KNOWN").toUpperCase();
      const onStage = castSet.has(fqId);
      const rel = state.relationships[`pc-${id}`] as EntityObj | undefined;
      const isDormantFactionOnStage =
        rel &&
        rel["status"] === "dormant" &&
        currentPlaceBare &&
        Array.isArray(faction["territory"]) &&
        ((faction["territory"] as unknown[]).includes(currentPlaceBare) ||
          (faction["territory"] as unknown[]).includes(currentPlace));

      if (onStage && (tier === "TRACKED" || tier === "PRINCIPAL")) {
        inCastFaction.push([id, faction]);
      } else if (onStage && tier === "KNOWN") {
        inCastKnownFaction.push([id, faction]);
      } else if (tier === "PRINCIPAL") {
        offStagePrincipalFaction.push([id, faction]);
      } else if (tier === "TRACKED") {
        offStageTrackedFaction.push([id, faction]);
      } else if (isDormantFactionOnStage && rel) {
        dormantOnStageFaction.push([id, faction, rel]);
      } else {
        knownFactionList.push([id, faction]);
      }
    }

    for (const [id, faction] of inCastFaction) {
      renderFullFaction(id, faction);
    }
    for (const [id, faction] of inCastKnownFaction) {
      const territoryStr = Array.isArray(faction["territory"])
        ? (faction["territory"] as unknown[]).join(", ")
        : (faction["territory"] ? String(faction["territory"]) : "");
      const territory = territoryStr ? ` @ ${territoryStr}` : "";
      lines.push(`FACTION: ${String(faction["name"] ?? id)} [KNOWN · on-stage]${territory} → id: ${id}`);
      if (faction["agenda"]) lines.push(`    Agenda: ${normalizeText(faction["agenda"])}`);
    }
    for (const [id, faction] of offStagePrincipalFaction) {
      const rel = state.relationships[`pc-${id}`] as EntityObj | undefined;
      const cardFrag =
        rel && rel["status"] === "active"
          ? ` · ${formatCardName(rel["card"])} ${String(rel["orientation"] ?? "")}`
          : "";
      lines.push(`PRINCIPAL faction (off-stage): ${String(faction["name"] ?? id)}${cardFrag} → id: ${id}`);
    }
    for (const [id, faction] of offStageTrackedFaction) {
      lines.push(`TRACKED faction (off-stage): ${String(faction["name"] ?? id)} → id: ${id}`);
    }
    for (const [id, faction, rel] of dormantOnStageFaction) {
      lines.push(`DORMANT faction (on-stage): ${String(faction["name"] ?? id)} · ${formatCardName(rel["card"])} ${String(rel["orientation"] ?? "")} → id: ${id}`);
    }
    for (const [id, faction] of knownFactionList) {
      const territoryStr = Array.isArray(faction["territory"])
        ? (faction["territory"] as unknown[]).join(", ")
        : (faction["territory"] ? String(faction["territory"]) : "");
      const territory = territoryStr ? ` @ ${territoryStr}` : "";
      const fState = faction["state"] ? ` [${String(faction["state"])}]` : "";
      lines.push(`  ${String(faction["name"] ?? id)}${territory}${fState} → id: ${id}`);
    }
  }

  // ── Places ───────────────────────────────────────────────────────────────

  const placeEntities = Object.values(state.places) as EntityObj[];
  if (placeEntities.length) {
    lines.push("");
    lines.push("Places:");
    for (const p of placeEntities) {
      lines.push(`  ${String(p["name"] ?? p["id"] ?? "")} [${String(p["state"] ?? "unknown")}] (${String(p["reach"] ?? "LOCAL")}) → id: ${String(p["id"] ?? "")}`);
      if (p["description"]) lines.push(`    ${String(p["description"])}`);
    }
  }

  // ── Current State ─────────────────────────────────────────────────────────

  lines.push("");
  lines.push("─── CURRENT STATE ───");

  if (showConstants) {
    const w = state.world as EntityObj;
    const constantLines: string[] = [];
    if (w["power_scale"]) constantLines.push(`  Power Scale: ${normalizeText(w["power_scale"])}`);
    if (w["power_ceiling"] != null) constantLines.push(`  Power Ceiling: ${String(w["power_ceiling"])}`);
    if (w["power_notes"]) constantLines.push(`  Power Notes: ${normalizeText(w["power_notes"])}`);
    if (constantLines.length) {
      lines.push("");
      lines.push("POWER CONTEXT");
      lines.push(...constantLines);
    }
  }

  const worldState = (state.world as EntityObj)["world_state"];
  if (worldState) {
    lines.push("");
    lines.push("WORLD STATE");
    lines.push(`  ${String(worldState)}`);
  }

  if (!isLite) {
    const liveCollisions = Object.values(state.collisions).filter(
      (cl) => (cl as EntityObj)["status"] !== "RESOLVED" && (cl as EntityObj)["status"] !== "CRASHED",
    ) as EntityObj[];
    if (liveCollisions.length) {
      lines.push("");
      lines.push("COLLISIONS");
      for (const col of liveCollisions) {
        const catLabel = col["distance_category"] ? ` ${String(col["distance_category"])}` : "";
        lines.push(`  ⊕ ${String(col["name"] ?? col["id"] ?? "")} [${String(col["status"] ?? "")}]${catLabel} dist:${col["distance"] != null ? String(col["distance"]) : "?"} → id: ${String(col["id"] ?? "")}`);
        const narrativeLines = getCollisionNarrativeLines(col);
        for (const narrativeLine of narrativeLines) {
          lines.push(`    ${narrativeLine}`);
        }
      }
    }
  }

  if (showPower && activeCombats.length) {
    lines.push("");
    lines.push("COMBATS");
    for (const combat of activeCombats) {
      lines.push(...formatChallenge(combat, { compact: false }));
    }
  }

  if (showFullDetail && factionEntities.length) {
    lines.push("");
    lines.push("FACTIONS");
    for (const f of factionEntities) {
      const header: string[] = [`  ${String(f["name"] ?? f["id"] ?? "")}`];
      if (f["territory"]) {
        const territoryStr = Array.isArray(f["territory"])
          ? (f["territory"] as unknown[]).join(", ")
          : String(f["territory"]);
        header.push(`territory: ${territoryStr}`);
      }
      if (f["state"]) header.push(`state: ${String(f["state"])}`);
      lines.push(header.join(" | "));
      if (f["agenda"]) lines.push(`    Agenda: ${normalizeText(f["agenda"])}`);
      const members = toList(f["members"]);
      if (members.length) lines.push(`    Members: ${members.join(", ")}`);
      const ka = f["knowledge_asymmetry"];
      if (ka && typeof ka === "object" && !Array.isArray(ka)) {
        const kaLines: string[] = [];
        for (const [k, v] of Object.entries(ka as Record<string, unknown>)) {
          if (typeof v === "string" && v) kaLines.push(`      ${k}: ${v}`);
        }
        if (kaLines.length) {
          lines.push("    Knowledge asymmetry:");
          lines.push(...kaLines);
        }
      }
    }
  }

  // ── Pressure Points ───────────────────────────────────────────────────────

  const pressureEntities = Object.values(state.pressures) as EntityObj[];
  if (pressureEntities.length) {
    lines.push("");
    lines.push("Pressure Points:");
    for (const p of pressureEntities) {
      const related =
        Array.isArray(p["related_to"]) && (p["related_to"] as unknown[]).length
          ? ` → ${(p["related_to"] as unknown[]).join(", ")}`
          : "";
      lines.push(`  • ${String(p["name"] ?? p["id"] ?? "")} [${String(p["source"] ?? "?")}]${related}`);
    }
  }

  // ── Collision Archive ─────────────────────────────────────────────────────

  if (includeArchive) {
    const archiveBlock = formatCollisionArchive(state);
    if (archiveBlock) {
      lines.push("");
      lines.push(archiveBlock);
    }
  }

  // ── PC Dossier ────────────────────────────────────────────────────────────

  if (showIntimacy && pc["name"]) {
    lines.push("");
    lines.push(`PC DOSSIER: ${String(pc["name"])}`);
    const allTraitsRaw = pc["demonstrated_traits"];
    const allTraits: string[] = Array.isArray(allTraitsRaw)
      ? (allTraitsRaw as unknown[]).map(String)
      : allTraitsRaw
        ? [String(allTraitsRaw)]
        : [];
    const traitCap = isFull ? 10 : 5;
    const traits = allTraits.slice(-traitCap);
    if (traits.length) {
      const traitPrefix =
        allTraits.length > traitCap
          ? `  Traits (${allTraits.length} total, showing last ${traitCap}): `
          : "  Traits: ";
      lines.push(`${traitPrefix}${traits.join(", ")}`);
    }
    const pcReads: { who: string; entries: string[] }[] = [];
    const pcName = String(pc["name"]).toLowerCase();
    for (const charRaw of Object.values(state.characters)) {
      const char = charRaw as EntityObj;
      if (char["tier"] === "UNKNOWN") continue;
      if (isIntimacy && !isFull && char["tier"] === "KNOWN") continue;
      const ka = char["knowledge_asymmetry"];
      if (!ka || typeof ka !== "object" || Array.isArray(ka)) continue;
      const pcEntries: string[] = [];
      for (const [k, v] of Object.entries(ka as Record<string, unknown>)) {
        if (typeof v !== "string" || !v) continue;
        if (k.endsWith("_pc") || k.includes("_pc_") || k.toLowerCase().includes(pcName)) {
          pcEntries.push(`${k}: ${v}`);
        }
      }
      if (pcEntries.length) pcReads.push({ who: String(char["name"] ?? char["id"] ?? ""), entries: pcEntries });
    }
    if (pcReads.length) {
      lines.push("  How others see PC:");
      for (const { who, entries } of pcReads) {
        lines.push(`    ${who}:`);
        for (const e of entries) lines.push(`      - ${e}`);
      }
    }
  }

  // ── Memorials ─────────────────────────────────────────────────────────────

  {
    const memorials: [string, EntityObj][] = [];
    for (const [relId, relRaw] of Object.entries(state.relationships)) {
      const rel = relRaw as EntityObj;
      if (rel["status"] !== "archived") continue;
      if (!relId.startsWith("pc-")) continue;
      const otherId = relId.slice("pc-".length);
      const stillLive = state.characters[otherId] || state.factions[otherId];
      if (stillLive) continue;
      memorials.push([otherId, rel]);
    }
    if (memorials.length > 0) {
      lines.push("");
      lines.push(`MEMORIALS (${memorials.length}):`);
      for (const [otherId, rel] of memorials) {
        const displayName = String(rel["display_name"] ?? otherId);
        const lastShift = rel["last_shift"] as EntityObj | undefined;
        const reason = lastShift?.["reason"]
          ? ` — ${normalizeText(lastShift["reason"]).slice(0, 60)}`
          : "";
        lines.push(`  † ${displayName} · ${formatCardName(rel["card"])} ${String(rel["orientation"] ?? "")}${reason}`);
      }
    }
  }

  // ── Token budget warning ──────────────────────────────────────────────────

  const stateText = lines.join("\n");
  const approxTokens = Math.ceil(stateText.length / 4);
  if (approxTokens > 8000) {
    logger.warn(`[GravityLedger:StateView] State view ~${approxTokens} tokens — over 8k budget. Consider consolidation.`);
  } else if (approxTokens > 6000) {
    logger.warn(`[GravityLedger:StateView] State view ~${approxTokens} tokens — approaching 6k budget.`);
  }

  lines.push("");
  lines.push("═══ END STATE VIEW ═══");
  return lines.join("\n");
}

// ─── buildNudge ───────────────────────────────────────────────────────────────

/**
 * Build the turn-mode deduction nudge for prompt injection.
 * Returns a brief mode-appropriate reminder block.
 * (Full deduction templates live in director/prompt.ts.)
 */
export function buildNudge(mode: TurnMode, _state: GravityState): string {
  const modeLabels: Record<TurnMode, string> = {
    regular: "REGULAR TURN — update collisions, constraints, characters, and relationships from prose.",
    advance: "ADVANCE TURN — advance the world: collisions approach, factions act, pressures accumulate.",
    combat: "COMBAT TURN — update wounds, power deltas, distance, and combat status.",
    intimacy: "INTIMACY TURN — update relationship card, distance, intensity, and nuance.",
    integration: "INTEGRATION TURN — apply setup or timeskip changes to the ledger.",
  };
  return modeLabels[mode] ?? "";
}

// ─── buildRecentTail ─────────────────────────────────────────────────────────

/**
 * Serialize the last N accepted transactions for the recent-tail cache column.
 */
export function buildRecentTail(txns: RawTransaction[], n = 20): string {
  return JSON.stringify(txns.slice(-n));
}
