// scripts/__tests__/migrate-case-refs.test.ts
//
// Coverage for the pure `migrateDocCaseRefs` core — every ref class against a
// synthetic three-level case hierarchy (visit → pregnancy → mother). Asserts
// both the rewritten doc text AND the per-ref change classification
// (clean / wire-change / unresolved), since the report drives the operator's
// decision on apply.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import { migrateDocCaseRefs, type RefChange, run } from "../migrate-case-refs";

// ── Synthetic doc builder ────────────────────────────────────────────────────
//
// mother (root)         props: household_code
//   └ pregnancy         props: edd
//       └ visit         props: temperature
//
// One module on case type `visit`, so a case-loading form there reaches
// visit (depth 0) / pregnancy (depth 1) / mother (depth 2).

const u = (s: string) => s as unknown as Uuid;

const CASE_TYPES = [
	{
		name: "mother",
		properties: [{ name: "household_code", label: "HH code" }],
	},
	{
		name: "pregnancy",
		parent_type: "mother",
		properties: [{ name: "edd", label: "EDD" }],
	},
	{
		name: "visit",
		parent_type: "pregnancy",
		properties: [{ name: "temperature", label: "Temp" }],
	},
];

/** A field carrying arbitrary surface values; cast to Field because the pure
 *  core reads untyped and the synthetic shape need not satisfy Zod. */
function field(
	uuid: string,
	id: string,
	surfaces: Record<string, unknown>,
): Field {
	return {
		uuid: u(uuid),
		id,
		kind: "text",
		label: "L",
		...surfaces,
	} as unknown as Field;
}

/**
 * Build a one-module doc. `formType` picks the form's case behavior; `fields`
 * are placed directly under the form (flat, no nesting) in order.
 */
function makeDoc(formType: string, fields: Field[]): BlueprintDoc {
	const fieldMap: Record<string, Field> = {};
	const fieldOrder: Record<string, Uuid[]> = { form1: [] };
	for (const f of fields) {
		fieldMap[f.uuid] = f;
		fieldOrder.form1.push(f.uuid);
	}
	return {
		appId: "app-test",
		appName: "Test App",
		connectType: null,
		caseTypes: CASE_TYPES,
		modules: { mod1: { uuid: u("mod1"), name: "Visits", caseType: "visit" } },
		forms: {
			form1: { uuid: u("form1"), id: "f_visit", name: "Visit", type: formType },
		},
		fields: fieldMap,
		moduleOrder: [u("mod1")],
		formOrder: { mod1: [u("form1")] },
		fieldOrder,
	} as unknown as BlueprintDoc;
}

/** Find the single change for a field id (asserts exactly one). */
function changeFor(changes: RefChange[], fieldId: string): RefChange {
	const matches = changes.filter((c) => c.fieldId === fieldId);
	expect(matches).toHaveLength(1);
	return matches[0];
}

describe("migrateDocCaseRefs — ref classes on a case-loading form", () => {
	it("#case/case_id → #<own>/case_id (clean)", () => {
		const doc = makeDoc("followup", [
			field("x1", "a", { relevant: "#case/case_id" }),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(doc);
		const c = changeFor(changes, "a");
		expect(c).toMatchObject({
			surface: "relevant",
			from: "#case/case_id",
			to: "#visit/case_id",
			kind: "clean",
			appId: "app-test",
			formId: "f_visit",
		});
		expect((out.fields.x1 as Record<string, unknown>).relevant).toBe(
			"#visit/case_id",
		);
	});

	it("#case/<ownprop> → #<own>/<ownprop> (clean, no wire change)", () => {
		const doc = makeDoc("followup", [
			field("x2", "b", { calculate: "#case/temperature" }),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(doc);
		const c = changeFor(changes, "b");
		expect(c).toMatchObject({
			surface: "calculate",
			to: "#visit/temperature",
			kind: "clean",
		});
		expect((out.fields.x2 as Record<string, unknown>).calculate).toBe(
			"#visit/temperature",
		);
	});

	it("#case/<ancestorprop> own lacks it → #<ancestor>/<prop> (wire-change)", () => {
		// `edd` lives on pregnancy (depth 1), not the own type visit.
		const doc = makeDoc("followup", [
			field("x3", "c", { relevant: "#case/edd" }),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(doc);
		const c = changeFor(changes, "c");
		expect(c).toMatchObject({
			from: "#case/edd",
			to: "#pregnancy/edd",
			kind: "wire-change",
		});
		expect((out.fields.x3 as Record<string, unknown>).relevant).toBe(
			"#pregnancy/edd",
		);
	});

	it("#case/parent/<prop> → #<parent>/<prop> (clean, same wire walk)", () => {
		const doc = makeDoc("followup", [
			field("x4", "d", { relevant: "#case/parent/edd" }),
		]);
		const { changes } = migrateDocCaseRefs(doc);
		expect(changeFor(changes, "d")).toMatchObject({
			from: "#case/parent/edd",
			to: "#pregnancy/edd",
			kind: "clean",
		});
	});

	it("#case/parent/parent/<prop> → grandparent (clean)", () => {
		const doc = makeDoc("followup", [
			field("x5", "e", { relevant: "#case/parent/parent/household_code" }),
		]);
		const { changes } = migrateDocCaseRefs(doc);
		expect(changeFor(changes, "e")).toMatchObject({
			to: "#mother/household_code",
			kind: "clean",
		});
	});

	it("prop on no reachable type → #<own>/<prop> (unresolved, loud)", () => {
		const doc = makeDoc("followup", [
			field("x6", "f", { calculate: "#case/missing_prop" }),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(doc);
		expect(changeFor(changes, "f")).toMatchObject({
			to: "#visit/missing_prop",
			kind: "unresolved",
		});
		// Rewritten (anchored to own type) so the validator flags it.
		expect((out.fields.x6 as Record<string, unknown>).calculate).toBe(
			"#visit/missing_prop",
		);
	});

	it("a prose label ref is rewritten too", () => {
		const doc = makeDoc("followup", [
			field("x7", "g", { label: "Temp was **#case/temperature** today" }),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(doc);
		expect(changeFor(changes, "g")).toMatchObject({
			surface: "label",
			to: "#visit/temperature",
			kind: "clean",
		});
		expect((out.fields.x7 as Record<string, unknown>).label).toBe(
			"Temp was **#visit/temperature** today",
		);
	});

	it("a too-deep parent walk is unresolved and LEFT AS-IS", () => {
		// depth 3 (great-grandparent) does not exist in the hierarchy.
		const doc = makeDoc("followup", [
			field("x8", "h", { relevant: "#case/parent/parent/parent/x" }),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(doc);
		const c = changeFor(changes, "h");
		expect(c.kind).toBe("unresolved");
		expect(c.from).toBe("#case/parent/parent/parent/x");
		expect(c.to).toBe(c.from); // unchanged
		expect((out.fields.x8 as Record<string, unknown>).relevant).toBe(
			"#case/parent/parent/parent/x",
		);
	});
});

describe("migrateDocCaseRefs — forms with no readable case", () => {
	it("a survey form leaves every #case/ ref as-is (unresolved)", () => {
		const doc = makeDoc("survey", [
			field("x9", "i", { relevant: "#case/temperature" }),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(doc);
		const c = changeFor(changes, "i");
		expect(c.kind).toBe("unresolved");
		expect(c.to).toBe("#case/temperature"); // left as-is
		expect((out.fields.x9 as Record<string, unknown>).relevant).toBe(
			"#case/temperature",
		);
	});
});

describe("migrateDocCaseRefs — nested surfaces", () => {
	it("rewrites a select option label", () => {
		const doc = makeDoc("followup", [
			field("x10", "j", {
				kind: "single_select",
				options: [
					{ value: "1", label: "Above #case/temperature" },
					{ value: "2", label: "no ref here" },
				],
			}),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(doc);
		expect(changeFor(changes, "j")).toMatchObject({
			surface: "option_label",
			to: "#visit/temperature",
			kind: "clean",
		});
		const opts = (out.fields.x10 as { options: { label: string }[] }).options;
		expect(opts[0].label).toBe("Above #visit/temperature");
		expect(opts[1].label).toBe("no ref here");
	});

	it("rewrites a query-bound repeat's data_source.ids_query", () => {
		const doc = makeDoc("followup", [
			field("x11", "k", {
				kind: "repeat",
				data_source: { ids_query: "instance('casedb')[#case/edd]" },
			}),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(doc);
		expect(changeFor(changes, "k")).toMatchObject({
			surface: "ids_query",
			to: "#pregnancy/edd",
			kind: "wire-change",
		});
		const ds = (out.fields.x11 as { data_source: { ids_query: string } })
			.data_source;
		expect(ds.ids_query).toBe("instance('casedb')[#pregnancy/edd]");
	});

	it("recurses into a group's child fields (same form case type)", () => {
		// A group container with one child carrying a ref. The child lives under
		// `fieldOrder[group]`, so it is only reached by the recursive walk — and
		// it must inherit the form's reachable types (own type = visit).
		const group = field("grp", "g_meta", { kind: "group" });
		const child = field("child", "c1", { calculate: "#case/temperature" });
		const doc = {
			appId: "app-test",
			appName: "Test App",
			connectType: null,
			caseTypes: CASE_TYPES,
			modules: { mod1: { uuid: u("mod1"), name: "Visits", caseType: "visit" } },
			forms: {
				form1: {
					uuid: u("form1"),
					id: "f_visit",
					name: "Visit",
					type: "followup",
				},
			},
			fields: { grp: group, child },
			moduleOrder: [u("mod1")],
			formOrder: { mod1: [u("form1")] },
			fieldOrder: { form1: [u("grp")], grp: [u("child")] },
		} as unknown as BlueprintDoc;

		const { doc: out, changes } = migrateDocCaseRefs(doc);
		expect(changeFor(changes, "c1")).toMatchObject({
			to: "#visit/temperature",
			kind: "clean",
		});
		expect((out.fields.child as Record<string, unknown>).calculate).toBe(
			"#visit/temperature",
		);
	});
});

describe("migrateDocCaseRefs — multiple refs & immutability", () => {
	it("rewrites every ref in one string and reports each", () => {
		const doc = makeDoc("followup", [
			field("x12", "m", {
				calculate: "#case/temperature + #case/parent/edd + #case/missing",
			}),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(doc);
		const mine = changes.filter((c) => c.fieldId === "m");
		expect(mine).toHaveLength(3);
		expect(mine.map((c) => c.kind)).toEqual(["clean", "clean", "unresolved"]);
		expect((out.fields.x12 as Record<string, unknown>).calculate).toBe(
			"#visit/temperature + #pregnancy/edd + #visit/missing",
		);
	});

	it("does not mutate the input doc and leaves ref-free apps untouched", () => {
		const doc = makeDoc("followup", [
			field("x13", "n", { relevant: "#case/temperature" }),
		]);
		const before = (doc.fields.x13 as Record<string, unknown>).relevant;
		migrateDocCaseRefs(doc);
		expect((doc.fields.x13 as Record<string, unknown>).relevant).toBe(before);

		const clean = makeDoc("followup", [
			field("x14", "o", { relevant: "1 = 1" }),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(clean);
		expect(changes).toHaveLength(0);
		expect(out).toBe(clean); // same reference when nothing changed
	});

	it("#caseload and #case_id-like tokens are not matched", () => {
		const doc = makeDoc("followup", [
			field("x15", "p", { calculate: "#caseload/foo and bare_case_id" }),
		]);
		const { changes } = migrateDocCaseRefs(doc);
		expect(changes).toHaveLength(0);
	});
});

describe("migrateDocCaseRefs — production-faithful detection (parser, not substring)", () => {
	it("does NOT rewrite #case/ inside an XPath string literal", () => {
		// Only the real HashtagRef (`#case/temperature`) is a ref; the
		// `'#case/legacy'` text is a string-literal value the read side never
		// treats as a ref — the parser must leave it byte-for-byte.
		const doc = makeDoc("followup", [
			field("lit", "q", {
				default_value: "if(#case/temperature > 0, '#case/legacy', 'x')",
			}),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(doc);
		const mine = changes.filter((c) => c.fieldId === "q");
		expect(mine).toHaveLength(1);
		expect(mine[0].to).toBe("#visit/temperature");
		expect((out.fields.lit as Record<string, unknown>).default_value).toBe(
			"if(#visit/temperature > 0, '#case/legacy', 'x')",
		);
	});

	it("captures a Unicode property segment whole (no ASCII truncation)", () => {
		const doc = makeDoc("followup", [
			field("uni", "r", { calculate: "#case/bébé" }),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(doc);
		// The whole `bébé` segment migrates — NOT truncated to `#visit/b` + "ébé".
		expect((out.fields.uni as Record<string, unknown>).calculate).toBe(
			"#visit/bébé",
		);
		expect(changeFor(changes, "r").from).toBe("#case/bébé");
	});

	it("leaves a bare #case/parent (related-node ref) as-is, unresolved", () => {
		const doc = makeDoc("followup", [
			field("bp", "s", { relevant: "#case/parent" }),
		]);
		const { doc: out, changes } = migrateDocCaseRefs(doc);
		const c = changeFor(changes, "s");
		expect(c.kind).toBe("unresolved");
		expect(c.to).toBe("#case/parent"); // left as-is, not rewritten to inert `#pregnancy`
		expect((out.fields.bp as Record<string, unknown>).relevant).toBe(
			"#case/parent",
		);
	});
});

describe("migrateDocCaseRefs — form-type validity classification", () => {
	it("registration: only own case_id is clean; other refs are unresolved", () => {
		const doc = makeDoc("registration", [
			field("rc", "t", { relevant: "#case/case_id" }),
			field("rt", "u", { calculate: "#case/temperature" }),
		]);
		const { changes } = migrateDocCaseRefs(doc);
		// case_id is the one ref a registration form legitimately reads.
		expect(changeFor(changes, "t")).toMatchObject({
			to: "#visit/case_id",
			kind: "clean",
		});
		// A real property on a registration form: rewritten (so #case/ is gone)
		// but classified unresolved because the read side's accept map rejects it.
		expect(changeFor(changes, "u")).toMatchObject({
			to: "#visit/temperature",
			kind: "unresolved",
		});
	});
});

describe("migrateDocCaseRefs — resilience", () => {
	it("does not throw on a malformed doc (no moduleOrder), returns empty", () => {
		expect(() =>
			migrateDocCaseRefs({} as unknown as BlueprintDoc),
		).not.toThrow();
		const { changes } = migrateDocCaseRefs({} as unknown as BlueprintDoc);
		expect(changes).toHaveLength(0);
	});
});

// ── Apply I/O wrapper (mocked Firestore) ─────────────────────────────────────
//
// `run` is where the prod-write safety lives (status filter, dry-run gating,
// `lastUpdateTime` precondition, per-app try/catch). It takes the Firestore
// surface as a parameter so these behaviors are pinned against a mock instead of
// the real database.

type RunDb = Parameters<typeof run>[0];
type Update = (...args: unknown[]) => Promise<unknown>;

/** A blueprint with one followup field carrying a `#case/temperature` ref —
 *  rewrites to `#visit/temperature` (clean), so the doc changes and `--apply`
 *  writes it. */
function blueprintWithRef(): unknown {
	return makeDoc("followup", [
		field("x", "xid", { relevant: "#case/temperature" }),
	]);
}

function fakeApp(
	id: string,
	blueprint: unknown,
	update: Update,
	updateTime: unknown = "ut",
): unknown {
	return {
		id,
		exists: true,
		updateTime,
		data: () => ({ blueprint, app_name: "App", owner: "owner" }),
		ref: { update },
	};
}

/** Bulk-query mock — records the `where(...)` filter args so the test can assert
 *  the status / deleted_at filter is applied. */
function bulkDb(docs: unknown[], whereCalls?: unknown[][]): RunDb {
	const get = async () => ({ docs });
	return {
		collection: () => ({
			doc: () => ({
				get: async () => ({
					id: "missing",
					exists: false,
					data: () => undefined,
					ref: { update: async () => undefined },
				}),
			}),
			where: (f: string, o: string, v: unknown) => {
				whereCalls?.push([f, o, v]);
				return {
					where: (f2: string, o2: string, v2: unknown) => {
						whereCalls?.push([f2, o2, v2]);
						return { get };
					},
				};
			},
		}),
	} as unknown as RunDb;
}

/** Single-doc mock for the `--app <id>` path. */
function singleDb(snap: unknown): RunDb {
	return {
		collection: () => ({
			doc: () => ({ get: async () => snap }),
			where: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }),
		}),
	} as unknown as RunDb;
}

describe("run — Firestore apply I/O (mocked)", () => {
	beforeEach(() => {
		// Silence the per-app report so the suite output stays clean; assertions
		// run against the returned summary and the update mock, not stdout.
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("dry run writes nothing", async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		const summary = await run(
			bulkDb([fakeApp("a1", blueprintWithRef(), update)]),
			{
				apply: false,
			},
		);
		expect(update).not.toHaveBeenCalled();
		expect(summary.appsWithRefs).toBe(1);
		expect(summary.appsWritten).toBe(0);
		expect(summary.totals.clean).toBe(1);
	});

	it("apply writes blueprint + updated_at with a lastUpdateTime precondition", async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		const summary = await run(
			bulkDb([fakeApp("a1", blueprintWithRef(), update, "UT-7")]),
			{ apply: true },
		);
		expect(update).toHaveBeenCalledTimes(1);
		const [data, precondition] = update.mock.calls[0];
		expect(data).toHaveProperty("blueprint");
		expect(data).toHaveProperty("updated_at");
		expect(precondition).toEqual({ lastUpdateTime: "UT-7" });
		expect(summary.appsWritten).toBe(1);
	});

	it("a rejected write (concurrent edit) is skipped, not fatal", async () => {
		const update = vi.fn().mockRejectedValue(new Error("FAILED_PRECONDITION"));
		const summary = await run(
			bulkDb([fakeApp("a1", blueprintWithRef(), update)]),
			{ apply: true },
		);
		expect(summary.appsSkippedConcurrent).toBe(1);
		expect(summary.appsWritten).toBe(0);
	});

	it("one bad doc is isolated — reported and skipped, run continues", async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		const bad = {
			id: "bad",
			exists: true,
			updateTime: "ut",
			data: () => {
				throw new Error("corrupt snapshot");
			},
			ref: { update },
		};
		const good = fakeApp("good", blueprintWithRef(), update);
		const summary = await run(bulkDb([bad, good]), { apply: false });
		expect(summary.appsFailed).toBe(1);
		expect(summary.appsWithRefs).toBe(1); // the good doc still processed
	});

	it("the bulk query filters to complete, non-deleted apps", async () => {
		const whereCalls: unknown[][] = [];
		await run(bulkDb([], whereCalls), { apply: false });
		expect(whereCalls).toContainEqual(["deleted_at", "==", null]);
		expect(whereCalls).toContainEqual(["status", "==", "complete"]);
	});

	it("--app <id> not found reports notFound without scanning", async () => {
		const missing = {
			id: "nope",
			exists: false,
			data: () => undefined,
			ref: { update: vi.fn() },
		};
		const summary = await run(singleDb(missing), {
			apply: false,
			onlyApp: "nope",
		});
		expect(summary.notFound).toBe(true);
		expect(summary.scanned).toBe(0);
	});

	it("--app <id> writes the single app, bypassing the status filter", async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		const summary = await run(
			singleDb(fakeApp("only1", blueprintWithRef(), update)),
			{ apply: true, onlyApp: "only1" },
		);
		expect(update).toHaveBeenCalledTimes(1);
		expect(summary.appsWritten).toBe(1);
	});
});
