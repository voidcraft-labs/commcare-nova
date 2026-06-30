// Tests for the deterministic, position-seeded backfill.
//
// Two contracts matter most: (1) a LEGACY doc — no `order` keys anywhere and
// select options without `uuid` — still parses through `blueprintDocSchema`
// (the new slots are optional), and (2) backfill is DETERMINISTIC and
// IDEMPOTENT, so two independent hydrations of the same legacy doc produce
// byte-identical keys/uuids and the client never references an entity the
// server minted differently.

import { describe, expect, it } from "vitest";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import { backfillOptionUuids, backfillOrderKeys } from "../backfill";
import { bySortKey } from "../compare";

/** A legacy blueprint: every entity lacks `order`, every option lacks `uuid`. */
function legacyRaw() {
	return {
		appId: "app1",
		appName: "Legacy App",
		connectType: null,
		caseTypes: null,
		modules: {
			m1: {
				uuid: "m1",
				id: "intake",
				name: "Intake",
				caseType: "patient",
				caseListConfig: {
					columns: [
						{ uuid: "col1", kind: "plain", field: "name", header: "Name" },
						{ uuid: "col2", kind: "plain", field: "age", header: "Age" },
					],
					searchInputs: [
						{
							uuid: "si1",
							kind: "simple",
							name: "q_name",
							label: "Name",
							type: "text",
							property: "name",
						},
					],
				},
			},
		},
		forms: {
			f1: {
				uuid: "f1",
				id: "register",
				name: "Register",
				type: "registration",
			},
			f2: { uuid: "f2", id: "followup", name: "Follow-up", type: "followup" },
		},
		fields: {
			t1: { uuid: "t1", id: "full_name", kind: "text", label: "Full name" },
			s1: {
				uuid: "s1",
				id: "gender",
				kind: "single_select",
				label: "Gender",
				options: [
					{ value: "m", label: "Male" },
					{ value: "f", label: "Female" },
				],
			},
		},
		moduleOrder: ["m1"],
		formOrder: { m1: ["f1", "f2"] },
		fieldOrder: { f1: ["t1", "s1"], f2: [] },
	};
}

/** Parse the legacy fixture and widen to an in-memory `BlueprintDoc`. */
function hydrate(): BlueprintDoc {
	const parsed = blueprintDocSchema.parse(legacyRaw());
	return { ...structuredClone(parsed), fieldParent: {} } as BlueprintDoc;
}

describe("legacy-fixture Zod round-trip", () => {
	it("parses a doc with no `order` and options without `uuid`", () => {
		expect(() => blueprintDocSchema.parse(legacyRaw())).not.toThrow();
		const parsed = blueprintDocSchema.parse(legacyRaw());
		expect(parsed.modules.m1.order).toBeUndefined();
		const s1 = parsed.fields.s1;
		if (!("options" in s1)) throw new Error("expected a select field");
		expect(s1.options[0].uuid).toBeUndefined();
		expect(s1.options[0].order).toBeUndefined();
	});
});

describe("backfillOrderKeys", () => {
	it("seeds `order` on every structural + collection entity", () => {
		const doc = hydrate();
		backfillOrderKeys(doc);
		expect(doc.modules.m1.order).toBeDefined();
		expect(doc.forms.f1.order).toBeDefined();
		expect(doc.forms.f2.order).toBeDefined();
		expect(doc.fields.t1.order).toBeDefined();
		expect(doc.fields.s1.order).toBeDefined();
		const config = doc.modules.m1.caseListConfig;
		if (!config) throw new Error("expected a caseListConfig");
		expect(config.columns[0].order).toBeDefined();
		expect(config.columns[1].order).toBeDefined();
		expect(config.searchInputs[0].order).toBeDefined();
		const s1 = doc.fields.s1;
		if (!("options" in s1)) throw new Error("expected a select field");
		expect(s1.options[0].order).toBeDefined();
		expect(s1.options[1].order).toBeDefined();
	});

	it("seeds keys in ascending array position (sorting reproduces the array)", () => {
		const doc = hydrate();
		backfillOrderKeys(doc);
		const formsInOrder = [doc.forms.f1, doc.forms.f2]
			.slice()
			.sort(bySortKey)
			.map((f) => f.uuid);
		expect(formsInOrder).toEqual(["f1", "f2"]);
		const fieldsInOrder = [doc.fields.t1, doc.fields.s1]
			.slice()
			.sort(bySortKey)
			.map((f) => f.uuid);
		expect(fieldsInOrder).toEqual(["t1", "s1"]);
	});

	it("is idempotent — a second pass changes nothing", () => {
		const doc = hydrate();
		backfillOrderKeys(doc);
		const snapshot = JSON.stringify(doc);
		backfillOrderKeys(doc);
		expect(JSON.stringify(doc)).toBe(snapshot);
	});
});

describe("backfillOptionUuids", () => {
	it("mints stable uuids from (field uuid, option index)", () => {
		const doc = hydrate();
		backfillOptionUuids(doc);
		const s1 = doc.fields.s1;
		if (!("options" in s1)) throw new Error("expected a select field");
		expect(s1.options[0].uuid).toBe("s1-opt-0");
		expect(s1.options[1].uuid).toBe("s1-opt-1");
	});

	it("is idempotent — a second pass changes nothing", () => {
		const doc = hydrate();
		backfillOptionUuids(doc);
		const snapshot = JSON.stringify(doc);
		backfillOptionUuids(doc);
		expect(JSON.stringify(doc)).toBe(snapshot);
	});
});

describe("determinism across independent hydrations", () => {
	it("two hydrations of the same legacy doc produce identical keys + uuids", () => {
		const a = hydrate();
		const b = hydrate();
		for (const doc of [a, b]) {
			backfillOrderKeys(doc);
			backfillOptionUuids(doc);
		}
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});
