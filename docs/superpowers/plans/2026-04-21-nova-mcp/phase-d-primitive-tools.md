# Phase D — Primitive tool handlers

**Goal:** Create 25 MCP tool files under `lib/mcp/tools/`, each a thin wrapper around existing helpers (`blueprintHelpers`, `validationLoop`, `commcare/*`, `db/apps`). No LLM calls, no orchestration — just compose-and-persist.

**Dependencies:** Phase C. Every tool imports `ToolContext` from `../types`, `McpContext` from `../context`, and `toMcpErrorResult` / `requireScope` / `requireOwnedApp` / `checkRateLimit` from their Phase C modules. Read the canonical template at the end of `phase-c-mcp-endpoint-skeleton.md` before starting any tool task.

**Task pattern:** one file per tool, one commit per tool, one test per tool. Tests stub `@/lib/db/apps`, `@/lib/log/writer`, `../rateLimit`, and any domain helpers the tool calls. Commit messages: `feat(mcp): <tool_name> tool`.

**Spec table** (scope, helper, stage tag per tool):

| Tool | Scope | Helper | Stage tag |
|---|---|---|---|
| list_apps | read | `listApps` (db/apps) | — |
| get_app | read | `buildSolutionsArchitectPrompt` (agent/prompts) | — |
| create_app | write | `createApp` (db/apps) | `app_created` |
| delete_app | write | `softDeleteApp` (new in D4) | — |
| generate_schema | write | `setCaseTypesMutations` | `schema_generated` |
| generate_scaffold | write | `setScaffoldMutations` | `scaffold_generated` |
| add_module | write | `addModuleMutations` | `module_added` |
| search_blueprint | read | read-only scan | — |
| get_module | read | read-only | — |
| get_form | read | read-only | — |
| get_field | read | read-only | — |
| add_fields | write | `addFieldMutations` (loop) | — |
| add_field | write | `addFieldMutations` | — |
| edit_field | write | `updateFieldMutations` | — |
| remove_field | write | `removeFieldMutations` | — |
| update_module | write | `updateModuleMutations` | — |
| update_form | write | `updateFormMutations` | — |
| create_form | write | `addFormMutations` | `form_added` |
| remove_form | write | `removeFormMutations` | — |
| create_module | write | `addModuleMutations` | `module_added` |
| remove_module | write | `removeModuleMutations` | — |
| validate_app | write | `validateAndFix` (agent/validationLoop) | `validation_started` / `validation_passed` |
| compile_app | read | `expandDoc` or `compileCcz` (commcare) | — |
| upload_app_to_hq | write | `importApp` + `getDecryptedCredentialsWithDomain` | `upload_started` / `upload_complete` |

---

## Task D0: Biome allowlist for the MCP tree

**Files:**
- Modify: `biome.json`

- [ ] **Step 1: Add MCP paths to the `@/lib/commcare` allowlist**

Edit `biome.json`. Find the second `overrides` entry (the one with `"includes"` listing `!app/api/compile/**`, etc.). Add two new entries to that `includes` array:

```
"!app/api/mcp/**",
"!lib/mcp/**",
```

Update the `noRestrictedImports` error message string for `@/lib/commcare` to list the new allowed consumers too, so the rule description stays accurate.

- [ ] **Step 2: Verify lint passes**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add biome.json
git commit -m "chore(mcp): allow @/lib/commcare imports from app/api/mcp + lib/mcp"
```

---

## Task D1: `list_apps` tool

**Files:**
- Create: `lib/mcp/tools/listApps.ts`
- Create: `lib/mcp/__tests__/listApps.test.ts`

- [ ] **Step 1: Write handler**

```ts
/**
 * nova.list_apps — enumerate the authenticated user's apps.
 *
 * Wraps lib/db/apps.listApps, filters soft-deleted entries, returns the
 * minimal shape a client needs to pick an app_id.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listApps } from "@/lib/db/apps";
import { toMcpErrorResult } from "../errors";
import { checkRateLimit } from "../rateLimit";
import { requireScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

export function registerListApps(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"list_apps",
		"List the authenticated user's Nova apps. Returns id, name, status, and updated_at for each.",
		{ type: "object", properties: {}, additionalProperties: false },
		async () => {
			try {
				requireScope(ctx, SCOPES.read);
				await checkRateLimit(ctx.userId, "list_apps");
				const apps = await listApps(ctx.userId);
				const visible = apps.filter((a) => a.status !== "deleted");
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								apps: visible.map((a) => ({
									app_id: a.appId,
									name: a.appName,
									status: a.status,
									updated_at: a.updatedAt,
								})),
							}),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err);
			}
		},
	);
}
```

- [ ] **Step 2: Test**

```ts
import { describe, expect, it, vi } from "vitest";
const listApps = vi.fn();
vi.mock("@/lib/db/apps", () => ({ listApps }));
vi.mock("../rateLimit", () => ({ checkRateLimit: vi.fn() }));

import { registerListApps } from "../tools/listApps";

function captureTool() {
	let handler: (...a: unknown[]) => Promise<unknown> = async () => ({});
	const server = {
		tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
			handler = h;
		},
	} as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
	return { server, get: () => handler };
}

describe("list_apps", () => {
	it("returns visible apps and filters deleted", async () => {
		listApps.mockResolvedValueOnce([
			{ appId: "a1", appName: "A1", status: "ready", updatedAt: 1 },
			{ appId: "a2", appName: "A2", status: "deleted", updatedAt: 2 },
		]);
		const { server, get } = captureTool();
		registerListApps(server, { userId: "u", scopes: ["nova.read"] });
		const res = (await get()({})) as { content: { text: string }[] };
		const parsed = JSON.parse(res.content[0].text);
		expect(parsed.apps).toHaveLength(1);
		expect(parsed.apps[0].app_id).toBe("a1");
	});

	it("returns insufficient_scope when nova.read missing", async () => {
		const { server, get } = captureTool();
		registerListApps(server, { userId: "u", scopes: [] });
		const res = (await get()({})) as {
			isError?: boolean;
			_meta?: { error_type?: string };
		};
		expect(res.isError).toBe(true);
		expect(res._meta?.error_type).toBe("insufficient_scope");
	});
});
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run lib/mcp/__tests__/listApps.test.ts
npx tsc --noEmit && echo "✓"
git add lib/mcp/tools/listApps.ts lib/mcp/__tests__/listApps.test.ts
git commit -m "feat(mcp): list_apps tool"
```

---

## Task D2: `get_app` tool

**Files:**
- Create: `lib/mcp/tools/getApp.ts`
- Create: `lib/mcp/__tests__/getApp.test.ts`

- [ ] **Step 1: Write handler**

```ts
/**
 * nova.get_app — blueprint summary for a single app.
 *
 * Reuses the SA's summary renderer so LLM clients see the same artifact
 * the web chat SA sees. Returns the "## Current blueprint" section (and
 * below) from the full SA system prompt.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildSolutionsArchitectPrompt } from "@/lib/agent/prompts";
import { loadApp } from "@/lib/db/apps";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { toMcpErrorResult } from "../errors";
import { requireOwnedApp } from "../ownership";
import { checkRateLimit } from "../rateLimit";
import { requireScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

export function registerGetApp(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"get_app",
		"Get a blueprint summary (human-readable markdown) for one of your apps.",
		{
			type: "object",
			properties: { app_id: { type: "string" } },
			required: ["app_id"],
			additionalProperties: false,
		},
		async (args: { app_id: string }) => {
			try {
				requireScope(ctx, SCOPES.read);
				await checkRateLimit(ctx.userId, "get_app");
				await requireOwnedApp(ctx.userId, args.app_id);
				const app = await loadApp(args.app_id);
				if (!app) throw new Error("not_found");
				const doc = { ...app, fieldParent: {} };
				rebuildFieldParent(doc);
				const full = buildSolutionsArchitectPrompt(doc);
				const marker = "## Current blueprint";
				const idx = full.indexOf(marker);
				return {
					content: [
						{ type: "text", text: idx >= 0 ? full.slice(idx) : full },
					],
				};
			} catch (err) {
				return toMcpErrorResult(err, { appId: args.app_id });
			}
		},
	);
}
```

- [ ] **Step 2: Test**

```ts
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db/apps", () => ({
	loadApp: vi.fn().mockResolvedValue({
		appId: "a", appName: "X", connectType: null, caseTypes: null,
		modules: {}, forms: {}, fields: {},
		moduleOrder: [], formOrder: {}, fieldOrder: {},
	}),
	loadAppOwner: vi.fn().mockResolvedValue("u"),
}));
vi.mock("../rateLimit", () => ({ checkRateLimit: vi.fn() }));

import { registerGetApp } from "../tools/getApp";

function captureTool() {
	let handler: (a: unknown) => Promise<unknown> = async () => ({});
	const server = {
		tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
			handler = h;
		},
	} as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
	return { server, get: () => handler };
}

describe("get_app", () => {
	it("returns text content for an owned app", async () => {
		const { server, get } = captureTool();
		registerGetApp(server, { userId: "u", scopes: ["nova.read"] });
		const res = (await get()({ app_id: "a" })) as {
			content: { text: string; type: string }[];
		};
		expect(res.content[0].type).toBe("text");
		expect(typeof res.content[0].text).toBe("string");
	});

	it("returns not_owner when foreign app", async () => {
		const { loadAppOwner } = await import("@/lib/db/apps");
		(loadAppOwner as ReturnType<typeof vi.fn>).mockResolvedValueOnce("other");
		const { server, get } = captureTool();
		registerGetApp(server, { userId: "u", scopes: ["nova.read"] });
		const res = (await get()({ app_id: "a" })) as {
			isError?: boolean;
			_meta?: { error_type?: string };
		};
		expect(res.isError).toBe(true);
		expect(res._meta?.error_type).toBe("not_owner");
	});
});
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run lib/mcp/__tests__/getApp.test.ts
git add lib/mcp/tools/getApp.ts lib/mcp/__tests__/getApp.test.ts
git commit -m "feat(mcp): get_app tool"
```

---

## Task D3: `create_app` tool

**Files:**
- Create: `lib/mcp/tools/createApp.ts`
- Create: `lib/mcp/__tests__/createApp.test.ts`

- [ ] **Step 1: Write handler**

```ts
/**
 * nova.create_app — mint an empty Nova app document.
 *
 * Required before any mutation tool can be called. Persists the doc under
 * the authenticated user and returns the generated app_id. Name is
 * optional; the LLM typically passes a sensible name up front.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApp, updateApp } from "@/lib/db/apps";
import { toMcpErrorResult } from "../errors";
import { checkRateLimit } from "../rateLimit";
import { requireScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

export function registerCreateApp(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"create_app",
		"Create an empty Nova app. Returns the new app_id. Required before any mutation tool can be called.",
		{
			type: "object",
			properties: { app_name: { type: "string" } },
			additionalProperties: false,
		},
		async (args: { app_name?: string }) => {
			try {
				requireScope(ctx, SCOPES.write);
				await checkRateLimit(ctx.userId, "create_app");
				const runId = crypto.randomUUID();
				const appId = await createApp(ctx.userId, runId);
				if (args.app_name?.trim()) {
					await updateApp(appId, { appName: args.app_name.trim() });
				}
				return {
					content: [
						{ type: "text", text: JSON.stringify({ app_id: appId }) },
					],
					_meta: { stage: "app_created", app_id: appId },
				};
			} catch (err) {
				return toMcpErrorResult(err);
			}
		},
	);
}
```

- [ ] **Step 2: Test** (mirrors the template; assert `createApp` + conditional `updateApp` called)

```ts
import { describe, expect, it, vi } from "vitest";
const createApp = vi.fn().mockResolvedValue("new-app-id");
const updateApp = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/db/apps", () => ({ createApp, updateApp }));
vi.mock("../rateLimit", () => ({ checkRateLimit: vi.fn() }));

import { registerCreateApp } from "../tools/createApp";

describe("create_app", () => {
	it("mints an app and renames when app_name given", async () => {
		let handler!: (a: unknown) => Promise<unknown>;
		const server = {
			tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
				handler = h;
			},
		} as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
		registerCreateApp(server, { userId: "u", scopes: ["nova.write"] });
		const res = (await handler({ app_name: "Hello" })) as {
			content: { text: string }[];
		};
		expect(JSON.parse(res.content[0].text).app_id).toBe("new-app-id");
		expect(updateApp).toHaveBeenCalledWith("new-app-id", { appName: "Hello" });
	});

	it("skips rename when app_name omitted", async () => {
		updateApp.mockClear();
		let handler!: (a: unknown) => Promise<unknown>;
		const server = {
			tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
				handler = h;
			},
		} as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
		registerCreateApp(server, { userId: "u", scopes: ["nova.write"] });
		await handler({});
		expect(updateApp).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run lib/mcp/__tests__/createApp.test.ts
git add lib/mcp/tools/createApp.ts lib/mcp/__tests__/createApp.test.ts
git commit -m "feat(mcp): create_app tool"
```

---

## Task D4: Soft-delete infrastructure + `delete_app` tool

**Files:**
- Modify: `lib/db/apps.ts`
- Create: `lib/mcp/tools/deleteApp.ts`
- Create: `lib/mcp/__tests__/deleteApp.test.ts`

- [ ] **Step 1: Add `softDeleteApp` to `lib/db/apps.ts`**

Append after the existing `updateApp` export:

```ts
/**
 * Soft-delete: mark the app as `deleted` with a timestamp. A scheduled
 * retention job (outside this file) hard-deletes soft-deleted apps after
 * 30 days. `listApps` filters these out; `loadApp` still returns them so
 * support-initiated recovery can read the blueprint within the window.
 *
 * Returns the ISO-8601 timestamp the 30-day window expires at so the tool
 * caller can tell the user when recovery will no longer be possible.
 */
export async function softDeleteApp(appId: string): Promise<string> {
	const now = Date.now();
	const expiresAt = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
	await getDb().collection("apps").doc(appId).update({
		status: "deleted",
		deleted_at: now,
		recoverable_until: expiresAt,
	});
	return expiresAt;
}
```

Also update `listApps` to filter deleted apps (query-side if the collection query supports `!=` on status; JS-side otherwise).

- [ ] **Step 2: Write `lib/mcp/tools/deleteApp.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { softDeleteApp } from "@/lib/db/apps";
import { toMcpErrorResult } from "../errors";
import { requireOwnedApp } from "../ownership";
import { checkRateLimit } from "../rateLimit";
import { requireScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

export function registerDeleteApp(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"delete_app",
		"Soft-delete an app. Recoverable by support for 30 days, after which a retention job hard-deletes the app + its event log.",
		{
			type: "object",
			properties: { app_id: { type: "string" } },
			required: ["app_id"],
			additionalProperties: false,
		},
		async (args: { app_id: string }) => {
			try {
				requireScope(ctx, SCOPES.write);
				await checkRateLimit(ctx.userId, "delete_app");
				await requireOwnedApp(ctx.userId, args.app_id);
				const expiresAt = await softDeleteApp(args.app_id);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								deleted: true,
								recoverable_until: expiresAt,
							}),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err, { appId: args.app_id });
			}
		},
	);
}
```

- [ ] **Step 3: Test**

```ts
import { describe, expect, it, vi } from "vitest";
const softDeleteApp = vi.fn().mockResolvedValue("2026-05-21T00:00:00.000Z");
vi.mock("@/lib/db/apps", () => ({
	softDeleteApp,
	loadAppOwner: vi.fn().mockResolvedValue("u"),
}));
vi.mock("../rateLimit", () => ({ checkRateLimit: vi.fn() }));

import { registerDeleteApp } from "../tools/deleteApp";

describe("delete_app", () => {
	it("returns recoverable_until", async () => {
		let handler!: (a: unknown) => Promise<unknown>;
		const server = {
			tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
				handler = h;
			},
		} as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
		registerDeleteApp(server, { userId: "u", scopes: ["nova.write"] });
		const res = (await handler({ app_id: "a" })) as {
			content: { text: string }[];
		};
		const parsed = JSON.parse(res.content[0].text);
		expect(parsed.deleted).toBe(true);
		expect(parsed.recoverable_until).toBe("2026-05-21T00:00:00.000Z");
	});
});
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run lib/db/__tests__ lib/mcp/__tests__/deleteApp.test.ts
git add lib/db/apps.ts lib/mcp/tools/deleteApp.ts lib/mcp/__tests__/deleteApp.test.ts
git commit -m "feat(mcp): soft-delete semantics + delete_app tool"
```

---

## Tasks D5 – D25: Remaining tools

Each tool follows the canonical template in `phase-c-mcp-endpoint-skeleton.md` with the helper, scope, and stage tag from the spec table at the top of this file. One commit per tool, one test per tool.

Per-tool order (recommend executing in this order so the test fixtures build up coherently):

1. **D5: `generate_schema`** — write, `setCaseTypesMutations`, stage `schema_generated`.
2. **D6: `generate_scaffold`** — write, `setScaffoldMutations`, stage `scaffold_generated`.
3. **D7: `add_module`** — write, `addModuleMutations`, stage `module_added`.
4. **D8: `search_blueprint`** — read, read-only scan over doc fields/forms/modules. Take a `query` string; return matches with their paths.
5. **D9: `get_module`** — read, read-only extraction of one module + its forms + fields.
6. **D10: `get_form`** — read.
7. **D11: `get_field`** — read.
8. **D12: `add_fields`** — write, batch `addFieldMutations`.
9. **D13: `add_field`** — write, single `addFieldMutations`.
10. **D14: `edit_field`** — write, `updateFieldMutations`.
11. **D15: `remove_field`** — write, `removeFieldMutations`.
12. **D16: `update_module`** — write, `updateModuleMutations`.
13. **D17: `update_form`** — write, `updateFormMutations`.
14. **D18: `create_form`** — write, `addFormMutations`, stage `form_added`.
15. **D19: `remove_form`** — write, `removeFormMutations`.
16. **D20: `create_module`** — write, `addModuleMutations`, stage `module_added`.
17. **D21: `remove_module`** — write, `removeModuleMutations`.
18. **D22: `validate_app`** — write (mutations are the validator's auto-fixes), calls `validateAndFix` from `lib/agent/validationLoop`, emits `validation_started` at entry + `validation_fix_applied` per fix + `validation_passed` at exit. Returns the final errors array (empty on success).
19. **D23: `compile_app`** — read, `format: "ccz" | "json"` input. CCZ → `compileCcz(expandDoc(doc))` (base64-encode), JSON → `expandDoc(doc)` directly (return as JSON text).
20. **D24: `upload_app_to_hq`** — write. Load `getDecryptedCredentialsWithDomain(userId)`; if domain mismatch → forbidden; expand doc; call `importApp`. Return `{ hq_app_id, url }` from the HQ response. Progress events `upload_started` and `upload_complete`.

For each, the task checklist is the same shape as D1–D4:

- [ ] **Step 1: Write the handler** following the template at the end of `phase-c-mcp-endpoint-skeleton.md`, substituting the scope + helper + stage tag from the spec table.
- [ ] **Step 2: Write a test** that stubs `@/lib/db/apps`, `@/lib/log/writer`, `../rateLimit`, and any domain helpers, then asserts:
  - Correct scope enforcement (insufficient_scope when missing).
  - Ownership enforcement (not_owner on foreign app, for tools that take app_id).
  - Helper called with expected args when inputs are valid.
  - Response content shape matches spec (text content; `_meta.stage` when applicable).
- [ ] **Step 3: Run the test + `npx tsc --noEmit && echo "✓"`.**
- [ ] **Step 4: Commit** with message `feat(mcp): <tool_name> tool`.

Notes on specific tools where the template needs adaptation:

**`search_blueprint`:** Read-only. Walk `doc.modules`, `doc.forms`, `doc.fields` and score matches against the `query` string. Use `fuse.js` (already a dep) for fuzzy matching rather than hand-rolling. Return an array of `{ kind: "module" | "form" | "field", id, path, snippet }` up to N results.

**`validate_app`:** This tool can itself mutate the doc (auto-fixes). Record every auto-fix batch through `mcpCtx.recordMutations(fixMuts, doc, "fix:attempt-N")`. On each fix attempt, emit a `validation_fix_applied` progress event with attempt number + remaining error count. At the end emit `validation_passed` with the final count (0 on success, >0 on give-up). Return `{ errors: ValidationError[] }`.

**`compile_app`:** For `format: "ccz"`, `compileCcz` returns a `Buffer`; encode as base64 and return as a text content part with `_meta: { encoding: "base64", format: "ccz" }` so the client knows to decode. For `format: "json"`, return the HQ JSON as plain text.

**`upload_app_to_hq`:** Three failure paths — no creds configured, domain mismatch, HQ non-success response — each mapped to a distinct `_meta.error_type` so clients can give actionable guidance. Emit `upload_started` progress with the domain; emit `upload_complete` with `hq_app_id`.

- [ ] **After all D5-D24 tools are committed:** run the full test suite once to confirm no cross-tool regressions.

```bash
npx vitest run
npx tsc --noEmit && echo "✓"
```

---

## Task D25: Biome `noRestrictedImports` sanity

One final sweep to make sure no tool accidentally imports from `@/lib/doc/store` or `@/lib/session/store` or a banned path.

- [ ] **Step 1: Lint**

```bash
npm run lint
```
Expected: clean.

- [ ] **Step 2: Skip commit (nothing to commit if lint is already clean).**
