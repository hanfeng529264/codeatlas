# CodeAtlas MVP Vertical Slice Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a runnable local-first CodeAtlas vertical slice with workspace initialization, CodeGraph detection, graph API, interactive full-space visualization, and verified CLI workflows.

**Architecture:** A TypeScript CLI initializes `.codeatlas/`, supervises a loopback-only Fastify server, and reads code facts through a version-aware CodeGraph adapter. A React/Vite frontend renders the same normalized graph with Sigma.js/WebGL and allows search, view switching, node inspection, neighborhood focus, and returning to the complete workspace graph.

**Tech Stack:** Node.js 22, TypeScript, Commander, Fastify, React, Vite, Graphology, Sigma.js, Vitest, Playwright.

---

The repository is already an isolated new project, so implementation occurs on a dedicated `codex/mvp` branch rather than creating another worktree.

### Task 1: Project Toolchain

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `.gitignore`

**Steps:**
1. Define build, test, dev, CLI, and typecheck scripts.
2. Install pinned runtime and development dependencies.
3. Add TypeScript configs for Node and Web targets.
4. Run `npm run typecheck`; expect an empty project to pass.
5. Commit the toolchain.

### Task 2: Workspace Initialization

**Files:**
- Create: `src/core/workspace.ts`
- Create: `src/core/types.ts`
- Create: `tests/workspace.test.ts`

**Steps:**
1. Write tests for current-directory initialization, explicit paths, idempotency, relative stored paths, and invalid roots.
2. Run `npm test -- tests/workspace.test.ts`; expect failure.
3. Implement `.codeatlas/workspace.json` creation and loading.
4. Re-run the focused test; expect pass.
5. Commit workspace initialization.

### Task 3: CodeGraph Adapter and Normalized Graph

**Files:**
- Create: `src/adapters/codegraph.ts`
- Create: `src/core/graph.ts`
- Create: `tests/codegraph-adapter.test.ts`
- Create: `tests/fixtures/codegraph-db.ts`

**Steps:**
1. Write a fixture SQLite database containing files, nodes, and edges.
2. Write tests for status detection, unsupported/missing indexes, type mapping, evidence mapping, and complete counts.
3. Run the focused tests; expect failure.
4. Implement CLI status detection plus a read-only, schema-checked SQLite compatibility layer.
5. Build directory/project nodes and normalize CodeGraph symbols and relationships.
6. Re-run tests; expect pass.
7. Commit the adapter.

### Task 4: Local Query Service

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/graph-store.ts`
- Create: `tests/server.test.ts`

**Steps:**
1. Write API tests for workspace status, complete graph, search, node details, and neighborhood projection.
2. Run focused tests; expect failure.
3. Implement in-memory indexes and budget-aware projections.
4. Return `totalMatched`, `returned`, `truncated`, and graph version in every graph response.
5. Bind production startup to loopback only and require a generated session token for API calls.
6. Re-run tests; expect pass.
7. Commit the query service.

### Task 5: CLI

**Files:**
- Create: `src/cli.ts`
- Create: `tests/cli.test.ts`

**Steps:**
1. Write CLI tests for `init`, `status`, `sync`, and `open --no-browser`.
2. Run focused tests; expect failure.
3. Implement commands with actionable errors and JSON status output.
4. Re-run tests; expect pass.
5. Commit CLI commands.

### Task 6: Interactive Web Visualization

**Files:**
- Create: `index.html`
- Create: `web/main.tsx`
- Create: `web/App.tsx`
- Create: `web/graph/GraphCanvas.tsx`
- Create: `web/styles.css`
- Create: `web/types.ts`

**Steps:**
1. Implement an industrial cartography visual system with an atmospheric dark canvas and drafting accents.
2. Load the complete graph and display explicit total/rendered counts.
3. Add full-space, directory, code-structure, method, and call view controls.
4. Add search, node selection, details, upstream/downstream focus, relationship legend, and return-to-full-space.
5. Keep labels and edges level-of-detail aware; never silently hide totals.
6. Run the production build and typecheck; expect pass.
7. Commit the frontend.

### Task 7: End-to-End Verification

**Files:**
- Create: `tests/e2e/codeatlas.spec.ts`
- Modify: `README.md`

**Steps:**
1. Initialize CodeGraph and CodeAtlas against the repository or a representative fixture workspace.
2. Build all packages and start `codeatlas open --no-browser`.
3. Verify status and graph API responses with actual output.
4. Use Playwright to verify full-space rendering, search, node selection, view switching, and neighborhood focus.
5. Capture and inspect a screenshot; fix visual defects before delivery.
6. Document setup and current limitations.
7. Run the complete test suite and commit verification work.

### Task 8: Delivery Check

**Steps:**
1. Run `npm run typecheck`, `npm test`, `npm run build`, and the end-to-end test.
2. Run `git diff --check` and confirm only intended files changed.
3. Confirm `.codegraph/`, `.codeatlas/`, build output, and test artifacts are ignored.
4. Report the exact runnable commands, test results, screenshot, and remaining MVP gaps.
