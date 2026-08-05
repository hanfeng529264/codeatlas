# Multi-Project Workspace Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let one CodeAtlas workspace register, index, aggregate, filter, and visualize multiple projects through one CLI process and one Web application.

**Architecture:** Each project owns an independent CodeGraph SQLite index. CodeAtlas migrates the workspace config to Schema 2, namespaces each project graph while loading, aggregates compatible project snapshots, and adds explicit project-level dependency edges from package manifests. The existing graph API and React interface gain project-aware status, filtering, search, and presentation.

**Tech Stack:** Node.js 22, TypeScript, Commander, Fastify, SQLite, Zod, React, Vite, Graphology, Sigma.js, Vitest, Playwright, GitHub Actions.

---

Implementation runs on `codex/v0.2-multi-project`. Each task ends in a focused verification and an iteration commit.

### Task 1: Iteration Records and CI Baseline

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `docs/iterations/2026-08-05-v0.2.0.md`
- Modify: `docs/adr/README.md`
- Create: `docs/adr/0006-project-index-aggregation.md`

**Steps:**
1. Record scope, decisions, acceptance criteria and checkpoints.
2. Add CI for Node 22 with `npm ci`, unit tests, typecheck and production build.
3. Run the same commands locally; expect pass.
4. Commit with `chore: establish v0.2 iteration baseline`.

### Task 2: Schema 2 Workspace and Project Registry

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/workspace.ts`
- Modify: `tests/workspace.test.ts`

**Steps:**
1. Write failing tests for Schema 1 migration, empty initialization, add/list/remove, duplicate paths and paths outside the workspace.
2. Run `npm test -- tests/workspace.test.ts`; expect the new tests to fail.
3. Implement Schema 2 parsing, migration and atomic config updates.
4. Implement project registry operations with portable relative paths and stable IDs.
5. Re-run the focused tests; expect pass.
6. Commit with `feat: add multi-project workspace registry`.

### Task 3: Project CLI and Per-Project Lifecycle

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`

**Steps:**
1. Write failing CLI tests for `init --empty`, `project add`, `project list`, `project remove` and JSON output.
2. Run `npm test -- tests/cli.test.ts`; expect failure.
3. Implement nested project commands and project-specific CodeGraph initialization.
4. Update `status` and `sync` to report and process each configured project.
5. Re-run CLI tests; expect pass.
6. Commit with `feat: manage workspace projects from the CLI`.

### Task 4: Aggregate Independent CodeGraph Indexes

**Files:**
- Modify: `src/adapters/codegraph.ts`
- Modify: `tests/fixtures/codegraph-db.ts`
- Modify: `tests/codegraph-adapter.test.ts`

**Steps:**
1. Create two project fixtures whose raw file and symbol IDs overlap.
2. Write failing tests for project namespaces, aggregate totals, partial health and project containment.
3. Run `npm test -- tests/codegraph-adapter.test.ts`; expect failure.
4. Extract a project snapshot loader and implement workspace aggregation with one global budget.
5. Add package-manifest `DEPENDS_ON` edges between matching workspace packages.
6. Re-run adapter tests; expect pass.
7. Commit with `feat: aggregate project CodeGraph indexes`.

### Task 5: Project-Aware API and Graph Store

**Files:**
- Modify: `src/server/graph-store.ts`
- Modify: `src/server/app.ts`
- Modify: `tests/server.test.ts`

**Steps:**
1. Write failing tests for per-project status, graph filtering and scoped search.
2. Run `npm test -- tests/server.test.ts`; expect failure.
3. Add project filters to graph projections and search without changing full graph semantics.
4. Return project health and counts from `/api/status`.
5. Re-run server tests; expect pass.
6. Commit with `feat: expose project-aware graph queries`.

### Task 6: Multi-Project Web Experience

**Files:**
- Modify: `web/types.ts`
- Modify: `web/App.tsx`
- Modify: `web/graph/GraphCanvas.tsx`
- Modify: `web/graph/NodeHoverCard.tsx`
- Modify: `web/styles.css`
- Modify: `tests/e2e/codeatlas.spec.ts`

**Steps:**
1. Extend the E2E fixture/API with two projects and write a failing project-switch test.
2. Add the project selector, scope label, project health and project identity in node details.
3. Pass the selected project to graph and search queries.
4. Add stable project colors while preserving node-kind readability and focus isolation.
5. Run typecheck, build and E2E tests; expect pass.
6. Inspect the full workspace and filtered project views visually.
7. Commit with `feat: add multi-project graph exploration`.

### Task 7: Documentation and Delivery

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/iterations/2026-08-05-v0.2.0.md`

**Steps:**
1. Document the new CLI, migration behavior, supported dependency evidence and limitations.
2. Record every commit, test result and remaining gap in the iteration log.
3. Run `npm test`, `npm run typecheck`, `npm run build`, `npm run test:e2e`, and `git diff --check`; expect pass.
4. Push `codex/v0.2-multi-project` and open a PR into protected `main`.
5. Commit documentation with `docs: record v0.2 multi-project iteration`.
