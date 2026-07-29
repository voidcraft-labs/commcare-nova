import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { duplicateFieldMutations } from "@/lib/doc/duplicateFieldMutations";
import { applyMutations } from "@/lib/doc/mutations";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	fieldSchema,
	type LookupOptionsSource,
	lookupColumnIdSchema,
	lookupTableIdSchema,
	proseText,
	type SelectOptionsSource,
} from "@/lib/domain";

const MODULE = testUuid("10000000-0000-4000-8000-000000000000");
const FORM = testUuid("20000000-0000-4000-8000-000000000000");
const FIELD = testUuid("30000000-0000-4000-8000-000000000000");

const TABLE_A = lookupTableIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ab",
);
const TABLE_B = lookupTableIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ac",
);
const VALUE_COLUMN = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ad",
);
const LABEL_COLUMN = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ae",
);

const SOURCE_A: LookupOptionsSource = {
	kind: "lookup",
	tableId: TABLE_A,
	valueColumnId: VALUE_COLUMN,
	labelColumnId: LABEL_COLUMN,
};

const SOURCE_B: LookupOptionsSource = {
	...SOURCE_A,
	tableId: TABLE_B,
	filter: {
		kind: "eq",
		left: {
			kind: "term",
			term: { kind: "literal", value: "enabled" },
		},
		right: {
			kind: "term",
			term: { kind: "literal", value: "enabled" },
		},
	},
};

function inlineSource(): SelectOptionsSource {
	return {
		kind: "inline",
		options: [
			{
				uuid: testUuid("40000000-0000-4000-8000-000000000000"),
				value: "active",
				label: proseText("Active"),
			},
			{
				uuid: testUuid("50000000-0000-4000-8000-000000000000"),
				value: "closed",
				label: proseText("Closed"),
			},
		],
	};
}

function selectField(optionsSource: SelectOptionsSource = inlineSource()) {
	return {
		uuid: FIELD,
		id: "status",
		kind: "single_select" as const,
		label: proseText("Status"),
		optionsSource,
	};
}

function baseDoc(field = selectField()): BlueprintDoc {
	const doc: BlueprintDoc = {
		appId: "lookup-carrier-test",
		appName: "Lookup carrier test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE]: { uuid: MODULE, id: "visits", name: "Visits" },
		},
		forms: {
			[FORM]: {
				uuid: FORM,
				id: "visit",
				name: "Visit",
				type: "survey",
			},
		},
		fields: { [FIELD]: field },
		moduleOrder: [MODULE],
		formOrder: { [MODULE]: [FORM] },
		fieldOrder: { [FORM]: [FIELD] },
		fieldParent: { [FIELD]: FORM },
	};
	doc.refIndex = buildReferenceIndex(doc);
	return doc;
}

function emptyDoc(): BlueprintDoc {
	const doc = baseDoc();
	const empty: BlueprintDoc = {
		...doc,
		fields: {},
		fieldOrder: { [FORM]: [] },
		fieldParent: {},
	};
	empty.refIndex = buildReferenceIndex(empty);
	return empty;
}

function roundTrip<M extends Mutation>(mutation: M): M {
	return mutationSchema.parse(JSON.parse(JSON.stringify(mutation))) as M;
}

function replay(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations.map(roundTrip));
	});
}

describe("lookup options source mutations", () => {
	it("persists a lookup source without an inline fallback", () => {
		const parsed = fieldSchema.parse(selectField(SOURCE_A));
		expect(parsed.kind).toBe("single_select");
		if (parsed.kind !== "single_select") {
			throw new Error("fixture: expected a single-select field");
		}
		expect(parsed.optionsSource).toEqual(SOURCE_A);
		expect("options" in parsed).toBe(false);
	});

	it("round-trips and replays a lookup-backed addField directly", () => {
		const mutation = roundTrip({
			kind: "addField",
			parentUuid: FORM,
			field: selectField(SOURCE_A),
		});
		expect(replay(emptyDoc(), [mutation]).fields[FIELD]).toEqual(
			selectField(SOURCE_A),
		);
	});

	it.each([
		["set", inlineSource(), SOURCE_A],
		["replace", SOURCE_A, SOURCE_B],
		["return to inline", SOURCE_A, inlineSource()],
	] as const)(
		"round-trips and replays an updateField %s",
		(_label, previous, next) => {
			const mutation = roundTrip({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "single_select",
				patch: { optionsSource: next },
			});
			const result = replay(baseDoc(selectField(previous)), [mutation]);
			expect(result.fields[FIELD]).toEqual(selectField(next));
		},
	);

	it("rejects a lookup-source extension for a non-select target", () => {
		expect(
			mutationSchema.safeParse({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "text",
				patch: { optionsSource: SOURCE_A },
			}).success,
		).toBe(false);
	});

	it("rejects the removed external carrier payloads", () => {
		expect(
			mutationSchema.safeParse({
				kind: "addField",
				parentUuid: FORM,
				field: selectField(),
				optionsSource: SOURCE_A,
			}).success,
		).toBe(false);
		expect(
			mutationSchema.safeParse({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "single_select",
				patch: {},
				optionsSource: SOURCE_A,
			}).success,
		).toBe(false);
	});

	it("duplicates a lookup-backed select without changing its source", () => {
		const doc = baseDoc(selectField(SOURCE_A));
		const plan = duplicateFieldMutations(doc, FIELD);
		expect(plan).toBeDefined();
		if (plan === undefined) throw new Error("fixture: expected a plan");
		const result = replay(doc, plan.mutations);
		expect(result.fieldOrder[FORM]?.[1]).toBe(plan.cloneUuid);
		const duplicate = result.fields[plan.cloneUuid];
		expect(duplicate?.kind).toBe("single_select");
		expect(
			duplicate?.kind === "single_select" ? duplicate.optionsSource : undefined,
		).toEqual(SOURCE_A);
	});

	it.each([
		["add", emptyDoc(), baseDoc(selectField(SOURCE_A))],
		["set", baseDoc(), baseDoc(selectField(SOURCE_A))],
		["replace", baseDoc(selectField(SOURCE_A)), baseDoc(selectField(SOURCE_B))],
		["return to inline", baseDoc(selectField(SOURCE_A)), baseDoc()],
	] as const)("diffs and exactly replays %s", (_label, before, after) => {
		const mutations = diffDocsToMutations(before, after);
		const carrierMutation = mutations.find(
			(mutation) =>
				mutation.kind === "addField" || mutation.kind === "updateField",
		);
		expect(carrierMutation).toBeDefined();
		if (carrierMutation?.kind === "addField") {
			expect(carrierMutation.field).toEqual(selectField(SOURCE_A));
		} else if (
			carrierMutation?.kind === "updateField" &&
			(carrierMutation.targetKind === "single_select" ||
				carrierMutation.targetKind === "multi_select")
		) {
			expect(carrierMutation.patch.optionsSource).toEqual(
				"optionsSource" in after.fields[FIELD]
					? after.fields[FIELD].optionsSource
					: undefined,
			);
		}
		expect(replay(before, mutations)).toEqual(after);
	});
});
