/**
 * `CanonicalMutationWorkspace` — the contract every canonical tool invocation
 * runs under.
 *
 * Pins the properties the SA's retired closure-doc + microtask-FIFO chain
 * only held implicitly:
 *
 *   - invocation order is allocated SYNCHRONOUSLY at dispatch and enforced —
 *     a branch whose body dawdles (the async-hook / SDK-parallelism hazard)
 *     cannot run ahead of an earlier dispatch;
 *   - each invocation reads one immutable snapshot, may perform at most ONE
 *     workspace mutation operation, and a stashed (stale-revision) context
 *     is a loud protocol error, never a silent overwrite;
 *   - a gate rejection persists nothing and advances nothing;
 *   - an accepted commit adopts the HOST's committed doc (a peer edit merged
 *     in), which the next invocation reads;
 *   - an authoritative commit conflict adopts one fresh authorized snapshot
 *     through the host's reload before the error surfaces — and without a
 *     reload (the MCP per-call host) the document stays put and the error
 *     propagates unchanged.
 */

import { describe, expect, it, vi } from "vitest";
import {
	echoLookupDefinitions,
	LOOKUP_SELECT_DOC,
	lookupSelectDoc,
	lookupTableDefinition,
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import { replaceFieldOptionsSourceMutation } from "@/lib/doc/lookupOptionsSourceMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import type { ToolInvocationContext } from "../types";

function renameBatch(name: string): Mutation[] {
	return [{ kind: "setAppName", name }];
}

describe("CanonicalMutationWorkspace — ordering", () => {
	it("runs invocations strictly in dispatch order even when an earlier body is artificially delayed", async () => {
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		const order: string[] = [];

		/* Dispatch A and B back-to-back without awaiting — the AI SDK's
		 * parallel tool_use shape. A's body awaits a long macrotask chain
		 * before writing; if ordering depended on completion timing rather
		 * than dispatch order, B would observe the pre-A document. */
		const a = h.workspace.invoke({
			toolName: "slow-first",
			execute: async (ctx) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				order.push("a");
				return ctx.applyBatch({ mutations: renameBatch("First wins") });
			},
		});
		const b = h.workspace.invoke({
			toolName: "fast-second",
			execute: async (ctx) => {
				order.push("b");
				expect(ctx.snapshot.doc.appName).toBe("First wins");
				return ctx.applyBatch({ mutations: renameBatch("Second lands") });
			},
		});
		await Promise.all([a, b]);

		expect(order).toEqual(["a", "b"]);
		expect(h.currentDoc().appName).toBe("Second lands");
		expect(h.recordMutations).toHaveBeenCalledTimes(2);
	});

	it("allocates ordinals synchronously at dispatch", async () => {
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		const ordinals: number[] = [];
		const invocations = [0, 1, 2].map((n) =>
			h.workspace.invoke({
				toolName: `t${n}`,
				execute: async (ctx) => {
					ordinals.push(ctx.invocation.invocationOrdinal);
				},
			}),
		);
		await Promise.all(invocations);
		expect(ordinals).toEqual([0, 1, 2]);
	});

	it("a failing invocation does not poison the chain for later ones", async () => {
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		await expect(
			h.workspace.invoke({
				toolName: "boom",
				execute: async () => {
					throw new Error("boom");
				},
			}),
		).rejects.toThrow("boom");
		const after = await h.workspace.invoke({
			toolName: "after",
			execute: async (ctx) => ctx.snapshot.doc.appName,
		});
		expect(after).toBe(h.currentDoc().appName);
	});
});

describe("CanonicalMutationWorkspace — one write per invocation, exact revision", () => {
	it("rejects a second workspace mutation in one invocation", async () => {
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		await expect(
			h.workspace.invoke({
				toolName: "double-writer",
				execute: async (ctx) => {
					await ctx.applyBatch({ mutations: renameBatch("Once") });
					await ctx.applyBatch({ mutations: renameBatch("Twice") });
				},
			}),
		).rejects.toThrow(/at most one/);
		/* The first write landed before the protocol error; nothing else did. */
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		expect(h.currentDoc().appName).toBe("Once");
	});

	it("rejects a stashed invocation context whose revision is stale", async () => {
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		let stashed: ToolInvocationContext | undefined;
		await h.workspace.invoke({
			toolName: "stasher",
			execute: async (ctx) => {
				stashed = ctx;
			},
		});
		await h.workspace.invoke({
			toolName: "advancer",
			execute: (ctx) => ctx.applyBatch({ mutations: renameBatch("Moved on") }),
		});
		if (stashed === undefined) throw new Error("context was not stashed");
		await expect(
			stashed.applyBatch({ mutations: renameBatch("From the past") }),
		).rejects.toThrow(/stale workspace revision/);
		expect(h.currentDoc().appName).toBe("Moved on");
	});

	it("an empty batch neither persists nor advances the revision", async () => {
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		const before = h.workspace.currentSnapshot().revision;
		const outcome = await h.workspace.invoke({
			toolName: "no-op",
			execute: (ctx) => ctx.applyBatch({ mutations: [] }),
		});
		expect(outcome).toMatchObject({ ok: true, mutations: [] });
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(h.workspace.currentSnapshot().revision).toBe(before);
	});

	it("a gate rejection persists nothing and advances nothing", async () => {
		const doc = makeCanonicalGenesisDoc();
		const h = makeToolWorkspaceHarness(doc);
		const before = h.workspace.currentSnapshot().revision;
		const outcome = await h.workspace.invoke({
			toolName: "rejected",
			// A blank app name fails the gate's shape rules.
			execute: (ctx) => ctx.applyBatch({ mutations: renameBatch("") }),
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error).toContain("wasn't applied");
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(h.workspace.currentSnapshot().revision).toBe(before);
		expect(h.currentDoc()).toBe(doc);
	});
});

describe("CanonicalMutationWorkspace — adoption", () => {
	it("adopts the host's committed doc, including a peer edit merged in", async () => {
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		h.recordMutations.mockImplementationOnce(async (prepared) => {
			const merged = structuredClone(prepared.nextDoc);
			merged.appName = "Peer suffix added";
			return { events: [], committedDoc: merged, seq: 7 };
		});
		const outcome = await h.workspace.invoke({
			toolName: "committer",
			execute: (ctx) => ctx.applyBatch({ mutations: renameBatch("Mine") }),
		});
		expect(outcome).toMatchObject({ ok: true });
		if (outcome.ok) expect(outcome.newDoc.appName).toBe("Peer suffix added");
		expect(h.currentDoc().appName).toBe("Peer suffix added");
		expect(h.workspace.currentSnapshot().canonicalSeq).toBe(7);
	});

	it("adoptAuthoritativeSnapshot advances the workspace and consumes the write budget", async () => {
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		const fresh = makeCanonicalGenesisDoc("Fresh proof");
		await expect(
			h.workspace.invoke({
				toolName: "proof-then-write",
				execute: async (ctx) => {
					ctx.adoptAuthoritativeSnapshot({ doc: fresh, canonicalSeq: 12 });
					await ctx.applyBatch({ mutations: renameBatch("Too late") });
				},
			}),
		).rejects.toThrow(/at most one/);
		expect(h.currentDoc()).toBe(fresh);
		expect(h.workspace.currentSnapshot().canonicalSeq).toBe(12);
	});
});

describe("CanonicalMutationWorkspace — authoritative conflict recovery", () => {
	it("adopts one fresh authorized snapshot through the host's reload, then surfaces the conflict", async () => {
		const freshDoc = makeCanonicalGenesisDoc("Reloaded fresh");
		const reload = vi.fn(async () => ({ doc: freshDoc, canonicalSeq: 42 }));
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc(), {
			reloadAuthorizedSnapshot: reload,
		});
		h.recordMutations.mockRejectedValueOnce(
			new BlueprintCommitRejectedError("a peer removed the target"),
		);

		await expect(
			h.workspace.invoke({
				toolName: "conflicted",
				execute: (ctx) => ctx.applyBatch({ mutations: renameBatch("Race") }),
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);

		expect(reload).toHaveBeenCalledTimes(1);
		expect(h.currentDoc()).toBe(freshDoc);
		/* The adopted sequence is the RELOAD's, never the pre-conflict one. */
		expect(h.workspace.currentSnapshot().canonicalSeq).toBe(42);
		/* The next invocation builds on the reloaded state. */
		const seen = await h.workspace.invoke({
			toolName: "next",
			execute: async (ctx) => ctx.snapshot.doc,
		});
		expect(seen).toBe(freshDoc);
	});

	it("without a host reload (the per-call MCP host), the conflict propagates and the document stays put", async () => {
		const initial = makeCanonicalGenesisDoc();
		const h = makeToolWorkspaceHarness(initial);
		h.recordMutations.mockRejectedValueOnce(
			new BlueprintCommitRejectedError("a peer removed the target"),
		);
		await expect(
			h.workspace.invoke({
				toolName: "conflicted",
				execute: (ctx) => ctx.applyBatch({ mutations: renameBatch("Race") }),
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(h.currentDoc()).toBe(initial);
	});
});

describe("ToolInvocationContext — no persistence bypass", () => {
	it("exposes no host persistence methods to the tool body", async () => {
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		await h.workspace.invoke({
			toolName: "introspect",
			execute: async (ctx) => {
				const keys = Object.keys(ctx);
				expect(keys).not.toContain("recordMutations");
				expect(keys).not.toContain("recordMutationStages");
				expect(keys).not.toContain("recordConversation");
				expect(keys).not.toContain("consumeParkedNote");
			},
		});
	});
});

/* Lookup-context union: the gate resolves definitions for the tables of the
 * snapshot AND the candidate. A swap from table A to table B is the case that
 * tells the three apart — the union asks for [A, B]; a snapshot-only gate asks
 * for [A] (and calls B unavailable); a candidate-only gate asks for [B]. */
const TABLE_A = lookupTableIdSchema.parse(
	"01912d68-783e-7000-8000-00000000a001",
);
const TABLE_B = lookupTableIdSchema.parse(
	"01912d68-783e-7000-8000-00000000a002",
);
const VALUE_COLUMN = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c001",
);
const LABEL_COLUMN = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c002",
);
const CATALOG = [TABLE_A, TABLE_B].map((id) =>
	lookupTableDefinition({
		id,
		name: `Table ${id}`,
		tag: "table",
		columns: [
			{ id: VALUE_COLUMN, wireName: "code", label: "Code" },
			{ id: LABEL_COLUMN, wireName: "name", label: "Name" },
		],
	}),
);

function lookupSource(tableId: LookupTableId) {
	return {
		kind: "lookup" as const,
		tableId,
		valueColumnId: VALUE_COLUMN,
		labelColumnId: LABEL_COLUMN,
	};
}

function swapToTableB(): Mutation {
	return replaceFieldOptionsSourceMutation(
		LOOKUP_SELECT_DOC.selectUuid,
		"single_select",
		lookupSource(TABLE_B),
	);
}

function makeLookupHarness() {
	const lookupDefinitions = echoLookupDefinitions(CATALOG);
	const h = makeToolWorkspaceHarness(lookupSelectDoc(lookupSource(TABLE_A)), {
		lookupDefinitions,
	});
	return { h, lookupDefinitions };
}

describe("CanonicalMutationWorkspace — lookup context", () => {
	it("applyBatch resolves definitions for the union of the snapshot's and the candidate's tables", async () => {
		const { h, lookupDefinitions } = makeLookupHarness();

		const out = await h.workspace.invoke({
			toolName: "swap-table",
			execute: (ctx) => ctx.applyBatch({ mutations: [swapToTableB()] }),
		});

		expect(out).toMatchObject({ ok: true });
		expect(lookupDefinitions).toHaveBeenCalledTimes(1);
		expect(lookupDefinitions).toHaveBeenCalledWith([TABLE_A, TABLE_B]);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		expect(h.currentDoc().fields[LOOKUP_SELECT_DOC.selectUuid]).toMatchObject({
			optionsSource: { kind: "lookup", tableId: TABLE_B },
		});
	});

	it("applyStages resolves the same union", async () => {
		const { h, lookupDefinitions } = makeLookupHarness();

		const out = await h.workspace.invoke({
			toolName: "swap-table-staged",
			execute: (ctx) =>
				ctx.applyStages({
					stages: [{ stage: "swap", mutations: [swapToTableB()] }],
				}),
		});

		expect(out).toMatchObject({ ok: true });
		expect(lookupDefinitions).toHaveBeenCalledTimes(1);
		expect(lookupDefinitions).toHaveBeenCalledWith([TABLE_A, TABLE_B]);
		expect(h.recordMutationStages).toHaveBeenCalledTimes(1);
	});
});
