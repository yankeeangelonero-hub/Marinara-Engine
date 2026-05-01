import { useEffect, useState } from "react";
import { useAgentStore } from "../../stores/agent.store";
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
