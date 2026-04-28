# Gravity Integration — Fork Notice

This is a fork of [Pasta-Devs/Marinara-Engine](https://github.com/Pasta-Devs/Marinara-Engine), with one additional integration: the **Gravity Ledger** — a deterministic state-tracking system that runs as two built-in agents (`gravity-ledger-inject` pre-generation, `gravity-ledger-director` post-processing).

## What this fork adds

Self-contained Gravity-related code lives under:

- `packages/server/src/services/gravity/` — engine, agents, director module
- `packages/server/src/db/schema/gravity-*.ts` — four DB tables
- `packages/server/src/routes/gravity.routes.ts` — `/gravity/*` HTTP routes
- `packages/client/src/stores/gravity.store.ts` — UI state
- `packages/client/src/components/chat/GravityLedgerDrawer.tsx` — inspection panel

Plus minimal integration touch-points in upstream files (agent-executor maps, route registration, schema re-exports, drawer mount). The diff is deliberately narrow so upstream rebases stay tractable.

The `gravity-integration` branch carries this work; `main` mirrors upstream `Pasta-Devs/Marinara-Engine` and is kept in sync via `git fetch upstream && git merge upstream/main` periodically.

## License

This fork is distributed under the **GNU Affero General Public License v3.0**, the same license as upstream Marinara. See `LICENSE` for the full text. Per AGPL-3.0:

- Source code is available at this repository.
- If you run a modified version as a network service for users, you must offer them the source.
- Any redistribution must remain under AGPL-3.0.

The Gravity-specific code added by this fork (everything under `packages/{server,client}/src/.../gravity/` and the integration touch-points) is also distributed under AGPL-3.0 to keep the project consistent with upstream's license.

## Upstream

Upstream project: <https://github.com/Pasta-Devs/Marinara-Engine>

This fork tracks upstream and aims to stay close to it. Issues unrelated to Gravity should be reported upstream. Issues with the Gravity integration specifically can be reported here.

## Reproduction

To run this fork:

```bash
git clone -b gravity-integration https://github.com/yankeeangelonero-hub/Marinara-Engine.git
cd Marinara-Engine
pnpm install
pnpm db:push
pnpm dev
```

See upstream's `README.md` and `CONTRIBUTING.md` for general Marinara setup, configuration, and release guidance — those are unchanged.
