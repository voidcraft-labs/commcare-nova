# Phase E — MCP adapters + MCP-only tools

**Goal:** Register every Nova MCP tool on the server. Shared SA tools (extracted in Phase D) get thin adapters that add ownership + per-call plumbing + MCP-shaped return conversion. ~6 MCP-only tools (list / get / create / delete / compile / upload) get full handler modules — they're genuinely not present on the SA surface.

**Dependencies:** Phases C + D.

**Scope enforcement is at the verify layer.** The MCP route handler (Phase G) declares each tool-mount with its required scope via `verifyAccessToken({ scopes })`. A bearer missing the required scope is rejected before any adapter runs. Adapters don't re-check scope.

---

## Task E1: Biome allowlist for the MCP + shared-tools trees

**Files:**
- Modify: `biome.json`

- [ ] **Step 1: Add paths to the `@/lib/commcare` allowlist**

Edit `biome.json`. Find the second `overrides` entry. Add to its `includes`:

```
"!app/api/[transport]/**",
"!lib/mcp/**",
"!lib/agent/tools/**"
```

Update the `noRestrictedImports` error message string for `@/lib/commcare` to list the new allowed consumers.

- [ ] **Step 2: Verify lint clean**

```bash
npm run lint
```

- [ ] **Step 3: Commit**

```bash
git add biome.json
git commit -m "chore(mcp): allow @/lib/commcare imports from app/api/[transport] + lib/mcp + lib/agent/tools"
```

---

## Task E2: Extract `summarizeBlueprint` out of `buildSolutionsArchitectPrompt`

`get_app` needs the blueprint summary. Today it's embedded in the SA prompt builder. Extract it first so `get_app` and the SA share one renderer — no string-slicing of the SA prompt.

**Files:**
- Create: `lib/agent/summarizeBlueprint.ts`
- Modify: `lib/agent/prompts.ts`

- [ ] **Step 1: Move the `summarize*` functions into a dedicated module**

Find `summarizeField`, `summarizeForm`, `summarizeModule`, `summarizeBlueprint` in `lib/agent/prompts.ts`. Move all four to `lib/agent/summarizeBlueprint.ts` as named exports. Keep internal helpers private to the new module.

- [ ] **Step 2: Have `buildSolutionsArchitectPrompt` import from the new module**

In `lib/agent/prompts.ts`:

```ts
import { summarizeBlueprint } from "./summarizeBlueprint";
```

The prompt builder still calls `summarizeBlueprint(doc)` in the same place.

- [ ] **Step 3: Run the SA test suite**

```bash
npx vitest run lib/agent/__tests__/
```
Expected: green. No behavior change.

- [ ] **Step 4: Commit**

```bash
git add lib/agent/summarizeBlueprint.ts lib/agent/prompts.ts
git commit -m "refactor(agent): extract summarizeBlueprint for dual-surface reuse"
```

---

## Task E3: `sharedToolAdapter` — one wrapper for all shared tools

**Files:**
- Create: `lib/mcp/adapters/sharedToolAdapter.ts`

- [ ] **Step 1: Write the adapter**

```ts
/**
 * Wrap a shared SA tool module (lib/agent/tools/<name>.ts) as an MCP
 * server.tool registration. Adds ownership + per-call plumbing; defers
 * to the shared execute for domain logic.
 *
 * Caller (lib/mcp/server.ts) passes the shared tool module + the
 * ToolContext from the verified JWT. The adapter produces a
 * server.tool(...) registration.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { produce } from "immer";
import { applyMutation } from "@/lib/doc/applyMutation";
import { loadApp } from "@/lib/db/apps";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LogWriter } from "@/lib/log/writer";
import { McpContext } from "../context";
import { toMcpErrorResult } from "../errors";
import { requireOwnedApp } from "../ownership";
import { createProgressEmitter } from "../progress";
import type { ToolContext } from "../types";
import type { BlueprintDoc } from "@/lib/domain";
import type { Mutation } from "@/lib/doc/types";

/**
 * Shape of a shared tool module. Read tools return just a summary; write
 * tools return mutations + summary. The adapter discriminates at apply
 * time via the presence of `mutations`.
 */
export interface SharedReadTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>; // Zod raw shape
	execute(
		input: unknown,
		ctx: McpContext,
		doc: BlueprintDoc,
	): Promise<{ summary: string }>;
}

export interface SharedWriteTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>; // Zod raw shape
	readonly stage?: string;
	execute(
		input: unknown,
		ctx: McpContext,
		doc: BlueprintDoc,
	): Promise<{ mutations: Mutation[]; summary: string }>;
}

export type SharedTool = SharedReadTool | SharedWriteTool;

export function registerSharedTool(
	server: McpServer,
	tool: SharedTool,
	ctx: ToolContext,
): void {
	server.tool(
		tool.name,
		tool.description,
		/* Pass the shared tool's inputSchema through verbatim — it's
		 * already a Zod raw shape produced in lib/agent/tools/*.ts. */
		tool.inputSchema,
		async (
			args: { app_id: string; [k: string]: unknown },
			extra: { _meta?: { progressToken?: string | number; run_id?: string } },
		) => {
			try {
				await requireOwnedApp(ctx.userId, args.app_id);

				const runId = extra._meta?.run_id ?? crypto.randomUUID();
				const logWriter = new LogWriter(args.app_id, "mcp");
				const progress = createProgressEmitter(server, extra._meta?.progressToken);
				const mcpCtx = new McpContext({
					appId: args.app_id,
					userId: ctx.userId,
					runId,
					logWriter,
					progress,
				});

				try {
					const app = await loadApp(args.app_id);
					if (!app) throw new Error("not_found");
					const doc = { ...app, fieldParent: {} };
					rebuildFieldParent(doc);

					const result = await tool.execute(args, mcpCtx, doc);

					if ("mutations" in result && result.mutations.length > 0) {
						const next = produce(doc, (draft) => {
							for (const m of result.mutations) applyMutation(draft, m);
						});
						await mcpCtx.recordMutations(
							result.mutations,
							next,
							(tool as SharedWriteTool).stage,
						);
					}

					return {
						content: [{ type: "text", text: result.summary }],
						_meta: {
							app_id: args.app_id,
							run_id: runId,
							...((tool as SharedWriteTool).stage && {
								stage: (tool as SharedWriteTool).stage,
							}),
						},
					};
				} finally {
					await logWriter.flush();
				}
			} catch (err) {
				return toMcpErrorResult(err, { appId: args.app_id });
			}
		},
	);
}
```

If `lib/doc/applyMutation` doesn't exist under that exact path, use whatever the repo's canonical mutation applier is (grep for the function the client-side `docStore.applyMany` calls). The applier must be the same one SA, MCP, and the client all use — that's the invariant.

- [ ] **Step 2: Commit**

```bash
git add lib/mcp/adapters/sharedToolAdapter.ts
git commit -m "feat(mcp): sharedToolAdapter — thin wrapper over lib/agent/tools/*"
```

---

## Task E4: `list_apps` (MCP-only)

**Files:**
- Create: `lib/mcp/tools/listApps.ts`
- Create: `lib/mcp/__tests__/listApps.test.ts`

- [ ] **Step 1: Write handler**

```ts
/**
 * nova.list_apps — enumerate the authenticated user's apps.
 *
 * Scope: nova.read. Filters soft-deleted entries.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listApps } from "@/lib/db/apps";
import { toMcpErrorResult } from "../errors";
import type { ToolContext } from "../types";

export function registerListApps(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"list_apps",
		"List the authenticated user's Nova apps. Returns id, name, status, and updated_at for each.",
		{}, // empty Zod raw shape = no inputs
		async () => {
			try {
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

Stub `@/lib/db/apps.listApps`. Assert the handler filters `status: "deleted"` and returns the expected JSON shape.

- [ ] **Step 3: Run + commit**

```bash
npx vitest run lib/mcp/__tests__/listApps.test.ts
npx tsc --noEmit && echo "✓"
git add lib/mcp/tools/listApps.ts lib/mcp/__tests__/listApps.test.ts
git commit -m "feat(mcp): list_apps tool"
```

---

## Task E5: `get_app` (MCP-only — uses extracted `summarizeBlueprint`)

**Files:**
- Create: `lib/mcp/tools/getApp.ts`
- Create: `lib/mcp/__tests__/getApp.test.ts`

- [ ] **Step 1: Write handler**

```ts
/**
 * nova.get_app — blueprint summary for one owned app.
 *
 * Scope: nova.read. Uses the shared summarizeBlueprint renderer so the
 * wire format matches what the SA sees in its own system prompt.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { summarizeBlueprint } from "@/lib/agent/summarizeBlueprint";
import { loadApp } from "@/lib/db/apps";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { toMcpErrorResult } from "../errors";
import { requireOwnedApp } from "../ownership";
import type { ToolContext } from "../types";

export function registerGetApp(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"get_app",
		"Get a blueprint summary (human-readable markdown) for one of your apps.",
		{ app_id: z.string() },
		async (args: { app_id: string }) => {
			try {
				await requireOwnedApp(ctx.userId, args.app_id);
				const app = await loadApp(args.app_id);
				if (!app) throw new Error("not_found");
				const doc = { ...app, fieldParent: {} };
				rebuildFieldParent(doc);
				return {
					content: [{ type: "text", text: summarizeBlueprint(doc) }],
				};
			} catch (err) {
				return toMcpErrorResult(err, { appId: args.app_id });
			}
		},
	);
}
```

- [ ] **Step 2: Test** (mock `@/lib/db/apps`, assert ownership + summary return)

- [ ] **Step 3: Run + commit**

```bash
npx vitest run lib/mcp/__tests__/getApp.test.ts
git add lib/mcp/tools/getApp.ts lib/mcp/__tests__/getApp.test.ts
git commit -m "feat(mcp): get_app tool using shared summarizeBlueprint"
```

---

## Task E6: `create_app` (MCP-only)

**Files:**
- Create: `lib/mcp/tools/createApp.ts`
- Create: `lib/mcp/__tests__/createApp.test.ts`

- [ ] **Step 1: Write handler**

```ts
/**
 * nova.create_app — mint an empty Nova app document.
 *
 * Scope: nova.write. Required before any mutation tool can run.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createApp, updateApp } from "@/lib/db/apps";
import { toMcpErrorResult } from "../errors";
import type { ToolContext } from "../types";

export function registerCreateApp(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"create_app",
		"Create an empty Nova app. Returns the new app_id.",
		{ app_name: z.string().optional() },
		async (args: { app_name?: string }) => {
			try {
				const runId = crypto.randomUUID();
				const appId = await createApp(ctx.userId, runId);
				if (args.app_name?.trim()) {
					await updateApp(appId, { appName: args.app_name.trim() });
				}
				return {
					content: [{ type: "text", text: JSON.stringify({ app_id: appId }) }],
					_meta: { stage: "app_created", app_id: appId },
				};
			} catch (err) {
				return toMcpErrorResult(err);
			}
		},
	);
}
```

- [ ] **Step 2: Test + commit**

```bash
git add lib/mcp/tools/createApp.ts lib/mcp/__tests__/createApp.test.ts
git commit -m "feat(mcp): create_app tool"
```

---

## Task E7: Soft-delete infrastructure + `delete_app` tool

**Files:**
- Modify: `lib/db/apps.ts`
- Create: `lib/mcp/tools/deleteApp.ts`
- Create: `lib/mcp/__tests__/deleteApp.test.ts`

- [ ] **Step 1: Add `softDeleteApp` to `lib/db/apps.ts`**

```ts
/**
 * Soft-delete: mark the app as `deleted` with a timestamp. A scheduled
 * retention job (outside this file) hard-deletes soft-deleted apps after
 * 30 days. `listApps` filters these out; `loadApp` still returns them so
 * support-initiated recovery can read the blueprint within the window.
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

Also update `listApps` to filter `status: "deleted"` rows.

- [ ] **Step 2: Write `lib/mcp/tools/deleteApp.ts`**

Handler takes `app_id`, runs `requireOwnedApp`, calls `softDeleteApp`, returns the recovery window.

- [ ] **Step 3: Test + commit**

```bash
git add lib/db/apps.ts lib/mcp/tools/deleteApp.ts lib/mcp/__tests__/deleteApp.test.ts
git commit -m "feat(mcp): soft-delete semantics + delete_app tool"
```

---

## Task E8: `compile_app` (MCP-only)

**Files:**
- Create: `lib/mcp/tools/compileApp.ts`
- Create: `lib/mcp/__tests__/compileApp.test.ts`

- [ ] **Step 1: Write handler**

```ts
/**
 * nova.compile_app — produce the CommCare HQ wire format (JSON) or the
 * binary app archive (ccz).
 *
 * Scope: nova.read. JSON is returned inline as pretty-printed text; ccz
 * is base64-encoded with `_meta.encoding` so clients know to decode.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { loadApp } from "@/lib/db/apps";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { toMcpErrorResult } from "../errors";
import { requireOwnedApp } from "../ownership";
import type { ToolContext } from "../types";

export function registerCompileApp(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"compile_app",
		"Compile an owned app to CommCare HQ format. `format: \"json\"` returns the HQ JSON; `format: \"ccz\"` returns the binary archive (base64-encoded).",
		{
			app_id: z.string(),
			format: z.enum(["json", "ccz"]),
		},
		async (args: { app_id: string; format: "json" | "ccz" }) => {
			try {
				await requireOwnedApp(ctx.userId, args.app_id);
				const app = await loadApp(args.app_id);
				if (!app) throw new Error("not_found");
				const doc = { ...app, fieldParent: {} };
				rebuildFieldParent(doc);
				const hqJson = expandDoc(doc);

				if (args.format === "json") {
					return {
						content: [
							{ type: "text", text: JSON.stringify(hqJson, null, 2) },
						],
						_meta: { format: "json", app_id: args.app_id },
					};
				}

				const cczBuf = compileCcz(hqJson);
				return {
					content: [{ type: "text", text: cczBuf.toString("base64") }],
					_meta: { format: "ccz", encoding: "base64", app_id: args.app_id },
				};
			} catch (err) {
				return toMcpErrorResult(err, { appId: args.app_id });
			}
		},
	);
}
```

- [ ] **Step 2: Test + commit**

---

## Task E9: `upload_app_to_hq` (MCP-only, explicit 4-gate sequence)

**Files:**
- Create: `lib/mcp/tools/uploadAppToHq.ts`
- Create: `lib/mcp/__tests__/uploadAppToHq.test.ts`

- [ ] **Step 1: Write handler with the explicit gate sequence**

```ts
/**
 * nova.upload_app_to_hq — upload a blueprint to CommCare HQ as a new app.
 *
 * Scope: nova.write. Preserves the existing chat-surface guarantees:
 *
 *   Gate 1: domain argument regex-validated via isValidDomainSlug
 *           (prevents path-traversal / SSRF into the HQ base URL).
 *   Gate 2: KMS-encrypted creds decrypted server-side via
 *           getDecryptedCredentialsWithDomain(userId). No creds
 *           configured → user-actionable "configure in Settings" error.
 *   Gate 3: decrypted.domain === args.domain. A user with creds for
 *           domain A cannot upload to domain B.
 *   Gate 4: importApp against the hardcoded HQ base URL only. The
 *           hardcoded URL is the SSRF boundary.
 *
 * All four gates MUST pass before any network call leaves the server.
 * Each gate produces a distinct _meta.error_type so clients can surface
 * actionable guidance.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { importApp, isValidDomainSlug } from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { loadApp } from "@/lib/db/apps";
import { getDecryptedCredentialsWithDomain } from "@/lib/db/settings";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LogWriter } from "@/lib/log/writer";
import { McpContext } from "../context";
import { toMcpErrorResult } from "../errors";
import { requireOwnedApp } from "../ownership";
import { createProgressEmitter } from "../progress";
import type { ToolContext } from "../types";

export function registerUploadAppToHq(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.tool(
		"upload_app_to_hq",
		"Upload an owned app to CommCare HQ as a new app in the specified project space.",
		{
			app_id: z.string(),
			domain: z.string(),
			app_name: z.string().optional(),
		},
		async (
			args: { app_id: string; domain: string; app_name?: string },
			extra: { _meta?: { progressToken?: string | number; run_id?: string } },
		) => {
			try {
				await requireOwnedApp(ctx.userId, args.app_id);

				/* Gate 1: regex validate the domain slug. */
				if (!isValidDomainSlug(args.domain)) {
					throw Object.assign(new Error("invalid domain slug"), {
						_errorType: "invalid_domain",
					});
				}

				/* Gate 2: decrypt KMS creds; missing creds is user-actionable. */
				const settings = await getDecryptedCredentialsWithDomain(ctx.userId);
				if (!settings) {
					throw Object.assign(
						new Error(
							"CommCare HQ is not configured. Add your API key in Settings.",
						),
						{ _errorType: "hq_not_configured" },
					);
				}

				/* Gate 3: domain match. A user can only upload to the domain
				 * their credentials authorize. */
				if (settings.domain.name !== args.domain) {
					throw Object.assign(
						new Error("You can only upload to your authorized project space."),
						{ _errorType: "domain_mismatch" },
					);
				}

				const app = await loadApp(args.app_id);
				if (!app) throw new Error("not_found");
				const doc = { ...app, fieldParent: {} };
				rebuildFieldParent(doc);

				const runId = extra._meta?.run_id ?? crypto.randomUUID();
				const logWriter = new LogWriter(args.app_id, "mcp");
				const progress = createProgressEmitter(server, extra._meta?.progressToken);
				const mcpCtx = new McpContext({
					appId: args.app_id,
					userId: ctx.userId,
					runId,
					logWriter,
					progress,
				});

				try {
					progress.notify("upload_started", `Uploading to ${args.domain}`, {
						app_id: args.app_id,
					});

					/* Gate 4: SSRF boundary is inside importApp via the
					 * hardcoded COMMCARE_HQ_URL in lib/commcare/client. */
					const hqJson = expandDoc(doc);
					const result = await importApp(
						settings.creds,
						args.domain,
						args.app_name?.trim() ?? app.appName,
						hqJson,
					);

					if (!result.success) {
						throw Object.assign(
							new Error(`HQ upload failed (HTTP ${result.status})`),
							{ _errorType: "hq_upload_failed" },
						);
					}

					progress.notify("upload_complete", `Uploaded: ${result.appId}`, {
						app_id: args.app_id,
						hq_app_id: result.appId,
					});

					mcpCtx.recordConversation({
						type: "tool-result",
						toolCallId: runId,
						toolName: "upload_app_to_hq",
						output: { hq_app_id: result.appId, url: result.url },
					});

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									hq_app_id: result.appId,
									url: result.url,
								}),
							},
						],
						_meta: {
							stage: "upload_complete",
							app_id: args.app_id,
							run_id: runId,
						},
					};
				} finally {
					await logWriter.flush();
				}
			} catch (err) {
				const tagged = (err as { _errorType?: string })._errorType;
				if (tagged) {
					return {
						isError: true,
						content: [{ type: "text", text: (err as Error).message }],
						_meta: { error_type: tagged, app_id: args.app_id },
					};
				}
				return toMcpErrorResult(err, { appId: args.app_id });
			}
		},
	);
}
```

- [ ] **Step 2: Test**

Cover all four gate failures plus the happy path. Stub `@/lib/db/settings`, `@/lib/commcare/client`, `@/lib/commcare/expander`.

- [ ] **Step 3: Run + commit**

```bash
git add lib/mcp/tools/uploadAppToHq.ts lib/mcp/__tests__/uploadAppToHq.test.ts
git commit -m "feat(mcp): upload_app_to_hq with explicit 4-gate validation sequence"
```

---

## Task E10: Full MCP adapter + tool registration sanity check

- [ ] **Step 1: Type-check**

```bash
npx tsc --noEmit && echo "✓"
```

- [ ] **Step 2: Full test suite**

```bash
npx vitest run
```
Expected: green. All MCP adapter + MCP-only tool tests pass. SA regression tests pass (from Phase D extraction verification).

- [ ] **Step 3: Lint**

```bash
npm run lint
```
