# Phase D — Tool extraction (shared foundation for SA + MCP)

**Goal:** Extract each Solutions Architect tool's definition out of `lib/agent/solutionsArchitect.ts` into its own module under `lib/agent/tools/<name>.ts`. Introduce a narrow `ToolExecutionContext` interface that `GenerationContext` (chat) and `McpContext` (MCP) both implement. `solutionsArchitect.ts` is refactored to import these modules and wrap them with the AI SDK's `tool()` factory; behavior on the chat surface is identical. Phase E then imports the same modules on the MCP side — zero duplication.

**Why this exists:** avoiding a second copy of every tool schema, description, and mutation-building path on the MCP side. Schema drift is a real maintenance hazard; one source of truth for ~19 tools eliminates it. Behavior change to chat is zero — the refactor moves code, it doesn't rewrite it.

**Dependencies:** Phase C (McpContext exists; its method set is the template for `ToolExecutionContext`).

**User sign-off:** explicit permission granted to touch `solutionsArchitect.ts` for this refactor; the "don't modify SA" repo memory applies to tool schemas and prompt text, which stay semantically unchanged here.

---

## Task D1: Define `ToolExecutionContext`

**Files:**
- Create: `lib/agent/toolExecutionContext.ts`

- [ ] **Step 1: Write the interface**

```ts
/**
 * Narrow context interface shared between the two surfaces that execute
 * SA tools:
 *
 *   - GenerationContext (lib/agent/generationContext.ts) — chat surface,
 *     implements this via its existing methods.
 *   - McpContext (lib/mcp/context.ts) — MCP surface, implements this by
 *     declaration.
 *
 * The interface is deliberately small. It exposes only what tool bodies
 * legitimately need to perform their domain work. Anything surface-
 * specific (spend cap, web UI state sync, SSE writer, progress token,
 * prompt cache) stays on the concrete class and never leaks into shared
 * tool logic.
 *
 * Tool modules in lib/agent/tools/<name>.ts take `ctx: ToolExecutionContext`
 * in their execute signature, never the concrete GenerationContext or
 * McpContext. The concrete class is chosen by the caller (chat route vs
 * MCP adapter).
 */

import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type {
	ConversationEvent,
	ConversationPayload,
	MutationEvent,
} from "@/lib/log/types";

export interface ToolExecutionContext {
	/** Current app id. Every tool operates against one app. */
	readonly appId: string;

	/** Authenticated user id. Used by tools that need to resolve
	 * user-scoped resources (e.g., KMS-encrypted HQ credentials). */
	readonly userId: string;

	/** Per-run grouping id. Stamped on every event envelope. */
	readonly runId: string;

	/**
	 * Persist a mutation batch to the durable event log and to Firestore.
	 * Returns the log envelopes so callers that need to correlate stages
	 * can read them.
	 *
	 * Async because implementations await the Firestore save before
	 * resolving — fail-closed persistence on both surfaces.
	 */
	recordMutations(
		mutations: Mutation[],
		doc: BlueprintDoc,
		stage?: string,
	): Promise<MutationEvent[]>;

	/** Persist a conversation event (assistant text/reasoning, tool
	 * call/result, user message, error). */
	recordConversation(payload: ConversationPayload): ConversationEvent;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/agent/toolExecutionContext.ts
git commit -m "feat(agent): ToolExecutionContext interface for dual-surface tool reuse"
```

---

## Task D2: Make `GenerationContext` + `McpContext` implement the interface

**Files:**
- Modify: `lib/agent/generationContext.ts`
- Modify: `lib/mcp/context.ts`

- [ ] **Step 1: Update `GenerationContext`**

`GenerationContext` currently has `emitMutations` + `emitConversation`. The interface wants `recordMutations` (async) + `recordConversation` (sync). Add wrapper methods that delegate to the existing implementations:

```ts
/**
 * ToolExecutionContext contract. Tool modules under lib/agent/tools/*
 * call these methods; the chat-specific wire fan-out (SSE, event log,
 * intermediate Firestore save) happens in the existing emit* methods
 * which these delegate to.
 */
async recordMutations(
	mutations: Mutation[],
	_doc: BlueprintDoc,
	stage?: string,
): Promise<MutationEvent[]> {
	/* The SA owns its working doc via a registered provider; emitMutations
	 * reads it at save time, so the `doc` arg passed by the shared tool is
	 * redundant on the chat surface. We accept it for interface
	 * compatibility. `emitMutations` returns void today — extend it to
	 * return the envelopes it already builds internally, or build them
	 * the same way here and return. */
	this.emitMutations(mutations, stage);
	/* TODO in the implementer: have emitMutations return the MutationEvent[]
	 * it already constructs; keep the void-returning behavior for call
	 * sites that don't need the return value. The interface can tolerate
	 * either Promise<MutationEvent[]> OR the eager-emit behavior as long
	 * as it resolves after the intermediate save fires. */
	return [];
}

recordConversation(payload: ConversationPayload): ConversationEvent {
	/* emitConversation returns void today; return the envelope it builds
	 * for interface parity. Same extend-return-type change. */
	this.emitConversation(payload);
	return {} as ConversationEvent;
}

/* readonly appId: string — already exists on GenerationContext.
 * readonly userId: string — add: getter reading this.session.user.id.
 * readonly runId: string — add: getter reading this.usage.runId. */
get userId(): string {
	return this.session.user.id;
}
get runId(): string {
	return this.usage.runId;
}
```

Declare `implements ToolExecutionContext` on the class:

```ts
export class GenerationContext implements ToolExecutionContext {
	// ...
}
```

The implementer executing this task should refactor `emitMutations` to return `MutationEvent[]` (it already constructs them internally — just return the array), then `recordMutations` becomes a clean delegation. Same for `emitConversation` → return the envelope. Both paths keep their existing SSE + log behavior; only the return-value shape changes.

- [ ] **Step 2: Declare `McpContext implements ToolExecutionContext`**

`McpContext` already has `appId`, `userId`, `runId`, `recordMutations` (async), `recordConversation` (sync) from Phase C Task C3. Just add the `implements` clause:

```ts
export class McpContext implements ToolExecutionContext {
	// ...existing body unchanged...
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit && echo "✓"
```

If either class is missing a method, the compiler errors here. Fix any gaps.

- [ ] **Step 4: Commit**

```bash
git add lib/agent/generationContext.ts lib/mcp/context.ts
git commit -m "refactor(agent): GenerationContext + McpContext implement ToolExecutionContext"
```

---

## Task D3 – D21: Extract each SA tool into its own module

Read `lib/agent/solutionsArchitect.ts` to enumerate the current tool list. The tools to extract are (exact names from the SA's `tool({...})` calls):

1. `generateSchema`
2. `generateScaffold`
3. `addModule`
4. `askQuestions` — chat-only (MCP uses AskUserQuestion via Claude Code). Extract anyway for consistency, but the MCP adapter never registers it.
5. `searchBlueprint`
6. `getModule`
7. `getForm`
8. `getField`
9. `addFields`
10. `addField`
11. `editField`
12. `removeField`
13. `updateModule`
14. `updateForm`
15. `createForm`
16. `removeForm`
17. `createModule`
18. `removeModule`
19. `validateApp`

Each extraction is one task, one commit. The pattern:

**Per-tool extraction task:**

**Files:**
- Create: `lib/agent/tools/<toolName>.ts`
- Modify: `lib/agent/solutionsArchitect.ts`

- [ ] **Step 1: Read the existing tool body**

In `solutionsArchitect.ts`, locate the `<toolName>: tool({ description, inputSchema, execute })` entry. Copy its description, inputSchema reference, and execute body.

- [ ] **Step 2: Write `lib/agent/tools/<toolName>.ts`**

Shape:

```ts
/**
 * SA tool: <toolName> — <purpose, lifted verbatim from the SA's current
 * description if it's a good description; otherwise a short gloss>.
 *
 * Surface-agnostic: takes a ToolExecutionContext, returns either
 * { mutations, summary } for mutating tools or just a summary string for
 * reads. The caller (SA factory / MCP adapter) applies the mutations and
 * threads the summary back to the LLM as tool output.
 */

import type { <InputType> } from "...";
import { <helperName> } from "@/lib/agent/blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { <inputSchema> } from "../toolSchemas";

export interface <ToolName>Output {
	/* For mutating tools: the mutations produced (caller applies). */
	mutations: Mutation[];
	/* Human-readable success string the LLM sees as tool output. */
	summary: string;
}

export const <toolName>Tool = {
	name: "<toolName>",
	description: "<description from SA>",
	inputSchema: <inputSchema>,
	async execute(
		input: <InputType>,
		ctx: ToolExecutionContext,
		/* Optional: some tools need the current doc. Shared tools don't
		 * own the doc — the caller (SA or MCP adapter) does. Pass it in
		 * if needed for this tool. */
		doc: BlueprintDoc,
	): Promise<<ToolName>Output> {
		/* Body: build mutations via blueprintHelpers, record them via ctx,
		 * build and return the summary. */
		const mutations = <helperName>(doc, input);
		await ctx.recordMutations(mutations, doc, "<stage>");
		return { mutations, summary: "<success summary>" };
	},
};
```

For read-only tools (`searchBlueprint`, `getModule`, `getForm`, `getField`) the return is just `{ summary: string }`.

For `validateApp`, the body calls `validateAndFix` from `lib/agent/validationLoop.ts` which produces its own mutation sequence. Return `{ mutations, summary, errors }` where `errors` is the final validator error array.

- [ ] **Step 3: Update `solutionsArchitect.ts` to import and wrap**

Replace the inline `<toolName>: tool({ ... })` entry with a wrapper over the extracted module:

```ts
import { <toolName>Tool } from "./tools/<toolName>";

// ...inside createSolutionsArchitect:
<toolName>: tool({
	description: <toolName>Tool.description,
	inputSchema: <toolName>Tool.inputSchema,
	execute: async (input) => {
		const doc = ctx.getCurrentDoc(); // existing SA helper that reads the working doc
		const result = await <toolName>Tool.execute(input, ctx, doc);
		/* The SA applies mutations to its in-memory doc. Pull the apply
		 * out into an existing helper if one exists; otherwise use immer
		 * produce over the same mutation applier lib/doc uses client-side. */
		applyMutationsToSaDoc(ctx, result.mutations);
		return result.summary;
	},
}),
```

Keep the SA's provider-options + cache-control wiring around these entries unchanged.

- [ ] **Step 4: Test chat behavior preserved**

Run the SA test suite: `npx vitest run lib/agent/__tests__/`
Expected: all tests green. If any tool test fails, the extraction altered behavior — fix before committing.

- [ ] **Step 5: Commit**

```bash
git add lib/agent/tools/<toolName>.ts lib/agent/solutionsArchitect.ts
git commit -m "refactor(agent): extract <toolName> into its own module"
```

**Execute this task once per tool (D3 through D21).** Commits are fine-grained so a bisect can pinpoint the exact extraction if any SA regression appears post-refactor.

---

## Task D22: Full SA regression check

**Files:** none (verification).

- [ ] **Step 1: Full test suite**

```bash
npx vitest run
```
Expected: all green. The pre-refactor baseline was 1442 tests; post-refactor should match.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit && echo "✓"
```

- [ ] **Step 3: Manual web-chat smoke**

Start dev; sign in; run a small build in the web UI:

```
Build me a simple patient registration app
```

Expected: identical behavior to main. Same tools called, same mutations emitted, same blueprint produced. If behavior differs, bisect to the offending extraction task.

- [ ] **Step 4: Commit nothing (verification-only); advance to Phase E if clean.**
