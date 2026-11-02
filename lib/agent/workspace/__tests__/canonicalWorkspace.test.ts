/** Real workspace state transitions over controlled host receipts. These
 * tests prove invocation ownership and adoption, not SQL persistence/locking;
 * native SDK sibling dispatch is covered by the SA concurrency suite. */

import { describe, expect, it, vi } from "vitest";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import {
	echoLookupDefinitions,
	LOOKUP_SELECT_DOC,
	lookupSelectDoc,
	lookupTableDefinition,
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import {
	FOLLOWUP,
	holdVisits,
	moveFixture,
	PATIENTS_NAMED,
	U,
} from "@/lib/doc/__tests__/placementMoveFixture";
import type { PreparedMutationCandidate } from "@/lib/doc/commitVerdicts";
import { replaceFieldOptionsSourceMutation } from "@/lib/doc/lookupOptionsSourceMutations";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { AdmittedMutationStages } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import {
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type { ToolInvocationContext, WorkspaceMutationOutcome } from "../types";

function renameBatch(name: string): Mutation[] {
	return [{ kind: "setAppName", name }];
}

describe("CanonicalMutationWorkspace — ordering", () => {
	it("holds a later invocation behind the first body and preserves its snapshot", async () => {
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		const order: string[] = [];

		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const ordinals: number[] = [];
		const a = h.workspace.invoke({
			toolName: "slow-first",
			execute: async (ctx) => {
				ordinals.push(ctx.invocation.invocationOrdinal);
				entered.resolve();
				await release.promise;
				order.push("a");
				return ctx.applyBatch({ mutations: renameBatch("First wins") });
			},
		});
		const b = h.workspace.invoke({
			toolName: "fast-second",
			execute: async (ctx) => {
				ordinals.push(ctx.invocation.invocationOrdinal);
				order.push("b");
				expect(ctx.snapshot.doc.appName).toBe("First wins");
				return ctx.applyBatch({ mutations: renameBatch("Second lands") });
			},
		});
		try {
			await entered.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(order).toEqual([]);
			expect(ordinals).toEqual([0]);
			expect(h.recordMutations).not.toHaveBeenCalled();
			release.resolve();
			await Promise.all([a, b]);
		} finally {
			release.resolve();
			await Promise.allSettled([a, b]);
		}
		expect(ordinals).toEqual([0, 1]);
		expect(order).toEqual(["a", "b"]);
		expect(h.currentDoc().appName).toBe("Second lands");
		expect(h.recordMutations).toHaveBeenCalledTimes(2);
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
	it("adopts the complete host receipt even when it differs from the optimistic candidate", async () => {
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		h.recordMutations.mockImplementationOnce(
			async (prepared: PreparedMutationCandidate) => {
				const merged = structuredClone(prepared.nextDoc);
				merged.appName = "Peer suffix added";
				return { events: [], committedDoc: expectAdmittedDoc(merged), seq: 7 };
			},
		);
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
const VALUE_COLUMN_B = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c003",
);
const LABEL_COLUMN_B = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c004",
);
const CATALOG = [TABLE_A, TABLE_B].map((id, index) =>
	lookupTableDefinition({
		id,
		name: `Table ${id}`,
		tag: index === 0 ? "table_a" : "table_b",
		columns: [
			{
				id: index === 0 ? VALUE_COLUMN : VALUE_COLUMN_B,
				wireName: "code",
				label: "Code",
			},
			{
				id: index === 0 ? LABEL_COLUMN : LABEL_COLUMN_B,
				wireName: "name",
				label: "Name",
			},
		],
	}),
);

function lookupSource(tableId: LookupTableId) {
	return {
		kind: "lookup" as const,
		tableId,
		valueColumnId: tableId === TABLE_A ? VALUE_COLUMN : VALUE_COLUMN_B,
		labelColumnId: tableId === TABLE_A ? LABEL_COLUMN : LABEL_COLUMN_B,
	};
}

function swapToTableB(): Mutation {
	return replaceFieldOptionsSourceMutation(
		LOOKUP_SELECT_DOC.selectUuid,
		"single_select",
		lookupSource(TABLE_B),
	);
}

const lookupContext: LookupValidationContext = {
	kind: "available",
	projectId: "project-test",
	projectRevision: parseLookupRevision("1"),
	definitions: CATALOG,
};
function makeLookupHarness() {
	const lookupDefinitions = echoLookupDefinitions(CATALOG);
	const h = makeToolWorkspaceHarness(
		expectAdmittedDoc(lookupSelectDoc(lookupSource(TABLE_A)), lookupContext),
		{
			lookupDefinitions,
		},
	);
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
		expectAdmittedDoc(h.currentDoc(), lookupContext);
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
		expectAdmittedDoc(h.currentDoc(), lookupContext);
		expect(lookupDefinitions).toHaveBeenCalledTimes(1);
		expect(lookupDefinitions).toHaveBeenCalledWith([TABLE_A, TABLE_B]);
		expect(h.recordMutationStages).toHaveBeenCalledTimes(1);
	});
});

describe("CanonicalMutationWorkspace — identity moves", () => {
	/** The follow-up's query repeat, published with its rows set when the
	 *  form opens; a query that reads an answer strands that hold. */
	const VISITS = U("visits");
	const strandVisits: Mutation = {
		kind: "updateField",
		uuid: VISITS,
		targetKind: "repeat",
		patch: { data_source: { ids_query: PATIENTS_NAMED } },
	} as Mutation;
	const published = () => holdVisits(moveFixture(), "model-iteration");
	const mutate = (mutations: readonly Mutation[]) => ({
		kind: "mutate" as const,
		mutations,
		result: { ok: true },
	});

	it("a canonical applyBatch returns the moves and the tool result carries them", async () => {
		const h = makeToolWorkspaceHarness(published());
		const outcomes: WorkspaceMutationOutcome[] = [];
		const result = await h.workspace.invoke({
			toolName: "editField",
			execute: async (ctx) => {
				const applied = await ctx.applyBatch({ mutations: [strandVisits] });
				outcomes.push(applied);
				if (!applied.ok) throw new Error(applied.error);
				return mutate(applied.mutations);
			},
		});
		const [outcome] = outcomes;
		if (outcome === undefined || !outcome.ok)
			throw new Error("The batch was applied.");
		const subject = {
			kind: "query-repeat",
			formUuid: FOLLOWUP,
			fieldUuid: VISITS,
		};
		expect(outcome.identityMoves.map((move) => move.subject)).toEqual([
			subject,
		]);
		expect(result.result).toEqual({
			ok: true,
			identityMoves: outcome.identityMoves,
		});
		// The committed batch carries the hold change, so the commit kernel
		// sees the move made by the batch that needs it.
		expect(outcome.mutations.at(-1)?.kind).toBe("holdPlacements");
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		const visits = h.currentDoc().fields[VISITS];
		expect(
			visits?.kind === "repeat" &&
				visits.repeat_mode === "query_bound" &&
				visits.placement,
		).toBe("count");
	});

	it("applyStages puts the hold change in the last stage", async () => {
		const h = makeToolWorkspaceHarness(published());
		const result = await h.workspace.invoke({
			toolName: "editField",
			execute: async (ctx) => {
				const outcome = await ctx.applyStages({
					stages: [
						{ stage: "rename", mutations: renameBatch("Visits") },
						{ stage: "query", mutations: [strandVisits] },
					],
				});
				if (!outcome.ok) throw new Error(outcome.error);
				return mutate(outcome.mutations);
			},
		});
		expect(result.result).toMatchObject({
			identityMoves: [{ subject: { kind: "query-repeat" } }],
		});
		const stages: AdmittedMutationStages | undefined =
			h.recordMutationStages.mock.calls[0]?.[1];
		if (stages === undefined) throw new Error("The stages were not saved.");
		expect(stages.slices.map((slice) => slice.stage)).toEqual([
			"rename",
			"query",
		]);
		expect(stages.slices.at(-1)?.end).toBe(stages.batch.length);
		expect(stages.batch.map((mutation) => mutation.kind)).toEqual([
			"setAppName",
			"updateField",
			"holdPlacements",
		]);
	});

	it("leaves a result alone where nothing moves", async () => {
		const h = makeToolWorkspaceHarness(published());
		const result = await h.workspace.invoke({
			toolName: "updateApp",
			execute: async (ctx) => {
				const outcome = await ctx.applyBatch({
					mutations: renameBatch("Clinic"),
				});
				if (!outcome.ok) throw new Error(outcome.error);
				expect(outcome.identityMoves).toEqual([]);
				return mutate(outcome.mutations);
			},
		});
		expect(result.result).toEqual({ ok: true });
	});
});
