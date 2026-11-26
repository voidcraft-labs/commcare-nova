/**
 * The JSON carrier's plan over its three facts. The plausible failures: an
 * unchanged table rewritten on every publish, a row matched to a stranger's
 * by its values, a move that rewrites every row instead of the ones that
 * left the in-order run, a rank reused or past CommCare HQ's integer, and a
 * write planned over a table changed in CommCare HQ since the ledger.
 */
import { describe, expect, it } from "vitest";
import {
	type LookupJsonLedger,
	type LookupJsonLocalRow,
	type LookupJsonRemote,
	lookupJsonDefinitionDigest,
	lookupJsonRanks,
	lookupJsonRowDigest,
	planLookupJsonPublish,
	RANK_STEP,
} from "../lookupJsonPlan";

const DEFINITION = {
	tag: "types",
	fields: [{ name: "name", properties: [] }],
	itemAttributes: [],
};
const content = (name: string) => ({
	fields: { name: [{ value: name, properties: {} }] },
	itemAttributes: {},
});
const local = (...names: string[]): LookupJsonLocalRow[] =>
	names.map((name) => ({ novaRowId: `nova-${name}`, content: content(name) }));
const remoteId = (name: string) => name.padEnd(32, "0");

/** The ledger and CommCare HQ's table as Nova last left them: these rows at these ranks. */
function published(
	rows: readonly (readonly [name: string, sortKey: number])[],
	definition = DEFINITION,
): { ledger: LookupJsonLedger; remote: LookupJsonRemote } {
	const definitionDigest = lookupJsonDefinitionDigest(definition);
	const ledgerRows = rows.map(([name, sortKey]) => ({
		novaRowId: `nova-${name}`,
		remoteId: remoteId(name),
		sortKey,
		digest: lookupJsonRowDigest(content(name)),
	}));
	return {
		ledger: {
			remoteTableId: "f".repeat(32),
			tag: definition.tag,
			definitionDigest,
			rows: ledgerRows,
		},
		remote: {
			id: "f".repeat(32),
			tag: definition.tag,
			isGlobal: true,
			definitionDigest,
			rows: ledgerRows.map((row) => ({
				id: row.remoteId,
				sortKey: row.sortKey,
				digest: row.digest,
			})),
		},
	};
}

describe("planLookupJsonPublish", () => {
	it("creates a table at a vacant tag, then appends each row in Nova's order", () => {
		const plan = planLookupJsonPublish({
			definition: DEFINITION,
			rows: local("a", "b"),
			ledger: null,
			remote: null,
		});
		expect(plan).toEqual({
			kind: "operations",
			operations: [
				{ kind: "create-table", definition: DEFINITION },
				{
					kind: "create-row",
					novaRowId: "nova-a",
					row: { ...content("a"), sortKey: 1023 },
				},
				{
					kind: "create-row",
					novaRowId: "nova-b",
					row: { ...content("b"), sortKey: 2047 },
				},
			],
		});
	});

	it("sends nothing for a table already as Nova holds it", () => {
		const { ledger, remote } = published([
			["a", 0],
			["b", 1],
		]);
		expect(
			planLookupJsonPublish({
				definition: DEFINITION,
				rows: local("a", "b"),
				ledger,
				remote,
			}),
		).toEqual({ kind: "operations", operations: [] });
	});

	it("appends a new row, rewrites a changed one at its own id, and deletes only a removed one", () => {
		const { ledger, remote } = published([
			["a", 0],
			["b", 1],
			["c", 2],
		]);
		const rows = local("a", "c", "d");
		rows[1] = { novaRowId: "nova-c", content: content("c2") };
		const plan = planLookupJsonPublish({
			definition: DEFINITION,
			rows,
			ledger,
			remote,
		});
		expect(plan).toEqual({
			kind: "operations",
			operations: [
				{
					kind: "delete-row",
					novaRowId: "nova-b",
					remoteId: remoteId("b"),
					before: { sortKey: 1, digest: lookupJsonRowDigest(content("b")) },
				},
				{
					kind: "update-row",
					novaRowId: "nova-c",
					remoteId: remoteId("c"),
					row: { ...content("c2"), sortKey: 2 },
					before: { sortKey: 2, digest: lookupJsonRowDigest(content("c")) },
				},
				{
					kind: "create-row",
					novaRowId: "nova-d",
					row: { ...content("d"), sortKey: 2 + RANK_STEP },
				},
			],
		});
	});

	it("moves one row with one full rewrite, keeping every other row's rank", () => {
		const { ledger, remote } = published([
			["a", 0],
			["b", 10],
			["c", 20],
			["d", 30],
		]);
		const plan = planLookupJsonPublish({
			definition: DEFINITION,
			rows: local("a", "c", "d", "b"),
			ledger,
			remote,
		});
		expect(plan).toEqual({
			kind: "operations",
			operations: [
				{
					kind: "update-row",
					novaRowId: "nova-b",
					remoteId: remoteId("b"),
					row: { ...content("b"), sortKey: 30 + RANK_STEP },
					before: { sortKey: 10, digest: lookupJsonRowDigest(content("b")) },
				},
			],
		});
	});

	it("never takes two identical rows for one, nor a stranger's equal row for Nova's", () => {
		const { ledger, remote } = published([["a", 0]]);
		const twins: LookupJsonLocalRow[] = [
			{ novaRowId: "nova-a", content: content("a") },
			{ novaRowId: "nova-a-again", content: content("a") },
		];
		const plan = planLookupJsonPublish({
			definition: DEFINITION,
			rows: twins,
			ledger,
			remote,
		});
		expect(plan).toMatchObject({
			kind: "operations",
			operations: [{ kind: "create-row", novaRowId: "nova-a-again" }],
		});
		const stranger: LookupJsonRemote = {
			...remote,
			rows: [
				...remote.rows,
				{
					id: remoteId("z"),
					sortKey: 1,
					digest: lookupJsonRowDigest(content("a")),
				},
			],
		};
		expect(
			planLookupJsonPublish({
				definition: DEFINITION,
				rows: twins,
				ledger,
				remote: stranger,
			}),
		).toEqual({ kind: "review", reason: "rows-changed" });
	});

	it.each([
		[
			"a tag another table holds",
			(state: ReturnType<typeof published>) => ({
				ledger: null,
				remote: state.remote,
			}),
			"tag-held-elsewhere",
		],
		[
			"the held table recreated under another id",
			(state: ReturnType<typeof published>) => ({
				...state,
				remote: { ...state.remote, id: "e".repeat(32) },
			}),
			"table-moved",
		],
		[
			"the held table gone",
			(state: ReturnType<typeof published>) => ({ ...state, remote: null }),
			"table-moved",
		],
		[
			"a table restricted to some workers",
			(state: ReturnType<typeof published>) => ({
				...state,
				remote: { ...state.remote, isGlobal: false },
			}),
			"not-global",
		],
		[
			"a definition changed in CommCare HQ",
			(state: ReturnType<typeof published>) => ({
				...state,
				remote: { ...state.remote, definitionDigest: "0".repeat(64) },
			}),
			"definition-changed",
		],
		[
			"a row edited in CommCare HQ",
			(state: ReturnType<typeof published>) => ({
				...state,
				remote: {
					...state.remote,
					rows: state.remote.rows.map((row) => ({
						...row,
						digest: "0".repeat(64),
					})),
				},
			}),
			"rows-changed",
		],
		[
			"a row moved in CommCare HQ",
			(state: ReturnType<typeof published>) => ({
				...state,
				remote: {
					...state.remote,
					rows: state.remote.rows.map((row) => ({ ...row, sortKey: 7 })),
				},
			}),
			"rows-changed",
		],
		[
			"a row deleted in CommCare HQ",
			(state: ReturnType<typeof published>) => ({
				...state,
				remote: { ...state.remote, rows: [] },
			}),
			"rows-changed",
		],
	] as const)("plans no write over %s", (_label, change, reason) => {
		const state = published([["a", 0]]);
		expect(
			planLookupJsonPublish({
				definition: DEFINITION,
				rows: local("a"),
				...change(state),
			}),
		).toEqual({ kind: "review", reason });
	});

	it("updates the definition of a table with no rows, and holds a schema change over rows for review", () => {
		const wider = {
			...DEFINITION,
			fields: [...DEFINITION.fields, { name: "code", properties: [] }],
		};
		const empty = published([]);
		expect(
			planLookupJsonPublish({
				definition: wider,
				rows: [],
				...empty,
			}),
		).toEqual({
			kind: "operations",
			operations: [{ kind: "update-table", definition: wider }],
		});
		expect(
			planLookupJsonPublish({
				definition: wider,
				rows: local("a"),
				...published([["a", 0]]),
			}),
		).toEqual({ kind: "review", reason: "schema-change-over-rows" });
	});

	it("inserts and moves in a table the carrier made by writing the new or moved row alone", () => {
		/* The plausible failure: the ranks a create leaves have no room between
		 * them, so every later insert or move is held for review. */
		const created = planLookupJsonPublish({
			definition: DEFINITION,
			rows: local("a", "b", "c"),
			ledger: null,
			remote: null,
		});
		if (created.kind !== "operations") throw new Error("expected writes");
		const ranks = created.operations.flatMap((operation) =>
			operation.kind === "create-row"
				? [
						[
							operation.novaRowId.slice("nova-".length),
							operation.row.sortKey,
						] as const,
					]
				: [],
		);
		const state = published(ranks);
		for (const rows of [
			local("a", "new", "b", "c"),
			local("new", "a", "b", "c"),
			local("a", "c", "b"),
		]) {
			const plan = planLookupJsonPublish({
				definition: DEFINITION,
				rows,
				...state,
			});
			expect(plan.kind).toBe("operations");
			if (plan.kind !== "operations") continue;
			expect(plan.operations).toHaveLength(1);
		}
	});

	it("makes room in a table whose ranks leave none by moving the fewest kept rows after the insert", () => {
		/* Ranks 0, 1, 2 with no gap, as a table CommCare HQ ranked itself. */
		const { ledger, remote } = published([
			["a", 0],
			["b", 1],
			["c", 2],
		]);
		const middle = planLookupJsonPublish({
			definition: DEFINITION,
			rows: local("a", "new", "b", "c"),
			ledger,
			remote,
		});
		expect(middle).toEqual({
			kind: "operations",
			operations: [
				{
					kind: "update-row",
					novaRowId: "nova-b",
					remoteId: remoteId("b"),
					row: { ...content("b"), sortKey: 2 * RANK_STEP },
					before: { sortKey: 1, digest: lookupJsonRowDigest(content("b")) },
				},
				{
					kind: "update-row",
					novaRowId: "nova-c",
					remoteId: remoteId("c"),
					row: { ...content("c"), sortKey: 3 * RANK_STEP },
					before: { sortKey: 2, digest: lookupJsonRowDigest(content("c")) },
				},
				{
					kind: "create-row",
					novaRowId: "nova-new",
					row: { ...content("new"), sortKey: RANK_STEP },
				},
			],
		});
		const moved = planLookupJsonPublish({
			definition: DEFINITION,
			rows: local("a", "c", "b"),
			ledger,
			remote,
		});
		/* c leaves the run; b, after it with no rank free between, moves on. */
		expect(moved).toMatchObject({
			kind: "operations",
			operations: [
				{
					kind: "update-row",
					novaRowId: "nova-c",
					row: { sortKey: RANK_STEP },
				},
				{
					kind: "update-row",
					novaRowId: "nova-b",
					row: { sortKey: 2 * RANK_STEP },
				},
			],
		});
	});

	it("asks for review only where CommCare HQ's integer has no rank left after the last kept row", () => {
		const { ledger, remote } = published([["a", 2_147_483_647]]);
		expect(
			planLookupJsonPublish({
				definition: DEFINITION,
				rows: local("a", "new"),
				ledger,
				remote,
			}),
		).toEqual({ kind: "review", reason: "no-rank-room" });
	});
});

describe("lookupJsonRanks", () => {
	it("keeps the longest in-order run and spreads the rest within CommCare HQ's integer", () => {
		expect(lookupJsonRanks([0, null, 10])).toEqual([0, 5, 10]);
		expect(lookupJsonRanks([null, null, 3])).toEqual([0, 1, 3]);
		expect(lookupJsonRanks([30, 10, 20])).toEqual([4, 10, 20]);
		expect(lookupJsonRanks([2_147_483_647, null])).toBeNull();
		expect(lookupJsonRanks([0, 1, null, null])).toEqual([
			0,
			1,
			1 + RANK_STEP,
			1 + 2 * RANK_STEP,
		]);
		expect(lookupJsonRanks([0, null, 1, 2])).toEqual([
			0,
			RANK_STEP,
			2 * RANK_STEP,
			3 * RANK_STEP,
		]);
	});

	it("gives every row a distinct rank increasing in Nova's order", () => {
		const current = [50, null, 3, 40, null, 45, 7, null];
		const ranks = lookupJsonRanks(current);
		if (ranks === null) throw new Error("expected ranks");
		for (let index = 1; index < ranks.length; index++)
			expect(ranks[index] as number).toBeGreaterThan(
				ranks[index - 1] as number,
			);
		expect(ranks.every((rank) => rank >= 0 && rank <= 2_147_483_647)).toBe(
			true,
		);
	});
});
