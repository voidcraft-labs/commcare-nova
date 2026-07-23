import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { applyMutations } from "@/lib/doc/mutations";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	fieldSchema,
	type LookupOptionsSource,
} from "@/lib/domain";

const MODULE = asUuid("10000000-0000-4000-8000-000000000000");
const FORM = asUuid("20000000-0000-4000-8000-000000000000");
const FIELD = asUuid("30000000-0000-4000-8000-000000000000");

const TABLE_A = "018f3e8a-7b2c-7def-8abc-1234567890ab";
const TABLE_B = "018f3e8a-7b2c-7def-8abc-1234567890ac";
const VALUE_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ad";
const LABEL_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ae";

const SOURCE_A = {
	kind: "lookup-table",
	tableId: TABLE_A,
	valueColumnId: VALUE_COLUMN,
	labelColumnId: LABEL_COLUMN,
} as LookupOptionsSource;

const SOURCE_B = {
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
} as LookupOptionsSource;

function selectField(optionsSource?: LookupOptionsSource) {
	return {
		uuid: FIELD,
		id: "status",
		kind: "single_select" as const,
		label: "Status",
		order: "a0",
		options: [
			{
				uuid: asUuid("40000000-0000-4000-8000-000000000000"),
				order: "a0",
				value: "active",
				label: "Active",
			},
			{
				uuid: asUuid("50000000-0000-4000-8000-000000000000"),
				order: "a1",
				value: "closed",
				label: "Closed",
			},
		],
		...(optionsSource !== undefined && { optionsSource }),
	};
}

function baseDoc(field = selectField()): BlueprintDoc {
	const doc: BlueprintDoc = {
		appId: "lookup-carrier-test",
		appName: "Lookup carrier test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE]: { uuid: MODULE, id: "visits", name: "Visits", order: "a0" },
		},
		forms: {
			[FORM]: {
				uuid: FORM,
				id: "visit",
				name: "Visit",
				type: "survey",
				order: "a0",
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

const legacySelectFieldSchema = z
	.object({
		uuid: z.string(),
		id: z.string(),
		kind: z.literal("single_select"),
		label: z.string(),
		order: z.string().optional(),
		options: z.array(
			z
				.object({
					uuid: z.string().optional(),
					order: z.string().optional(),
					value: z.string(),
					label: z.string(),
				})
				.strict(),
		),
	})
	.strict();

const legacyMutationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("addField"),
		parentUuid: z.string(),
		field: legacySelectFieldSchema,
	}),
	z.object({
		kind: z.literal("updateField"),
		uuid: z.string(),
		targetKind: z.literal("single_select"),
		patch: z
			.object({
				label: z.string().nullable().optional(),
				options: z.array(z.unknown()).nullable().optional(),
			})
			.default({}),
	}),
]);

describe("dormant lookup options carriers", () => {
	it("persists a source while retaining required inline fallback options", () => {
		const parsed = fieldSchema.parse(selectField(SOURCE_A));
		expect(parsed.kind).toBe("single_select");
		if (parsed.kind !== "single_select") {
			throw new Error("fixture: expected a single-select field");
		}
		expect(parsed.options).toHaveLength(2);
		expect(parsed.optionsSource).toEqual(SOURCE_A);
	});

	it("carries addField source intent outside the strict nested fallback", () => {
		const mutation = roundTrip({
			kind: "addField",
			parentUuid: FORM,
			field: selectField(),
			optionsSource: SOURCE_A,
		});
		expect("optionsSource" in mutation.field).toBe(false);
		expect(replay(emptyDoc(), [mutation]).fields[FIELD]).toEqual(
			selectField(SOURCE_A),
		);

		const legacy = legacyMutationSchema.parse(
			JSON.parse(JSON.stringify(mutation)),
		);
		expect(legacy.kind).toBe("addField");
		if (legacy.kind === "addField") {
			expect("optionsSource" in legacy.field).toBe(false);
			expect(legacy.field.options).toEqual(selectField().options);
		}
	});

	it.each([
		["set", undefined, SOURCE_A],
		["replace", SOURCE_A, SOURCE_B],
		["clear", SOURCE_A, undefined],
	] as const)(
		"round-trips and replays an updateField %s without changing inline options",
		(_label, previous, next) => {
			const mutation = roundTrip({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "single_select",
				patch: {},
				optionsSource: next ?? null,
			});
			const result = replay(baseDoc(selectField(previous)), [mutation]);
			expect(result.fields[FIELD]).toEqual(selectField(next));
			expect(
				(result.fields[FIELD] as ReturnType<typeof selectField>).options,
			).toEqual(selectField().options);

			const legacy = legacyMutationSchema.parse(
				JSON.parse(JSON.stringify(mutation)),
			);
			expect(legacy).toEqual({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "single_select",
				patch: {},
			});
		},
	);

	it("rejects a lookup-source extension for a non-select target", () => {
		expect(
			mutationSchema.safeParse({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "text",
				patch: {},
				optionsSource: SOURCE_A,
			}).success,
		).toBe(false);
	});

	it("rejects carrier intent nested inside the legacy fallback shapes", () => {
		expect(
			mutationSchema.safeParse({
				kind: "addField",
				parentUuid: FORM,
				field: selectField(SOURCE_A),
			}).success,
		).toBe(false);
		expect(
			mutationSchema.safeParse({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "single_select",
				patch: { optionsSource: SOURCE_A },
			}).success,
		).toBe(false);
	});

	it.each([
		["add", emptyDoc(), baseDoc(selectField(SOURCE_A))],
		["set", baseDoc(), baseDoc(selectField(SOURCE_A))],
		["replace", baseDoc(selectField(SOURCE_A)), baseDoc(selectField(SOURCE_B))],
		["clear", baseDoc(selectField(SOURCE_A)), baseDoc()],
	] as const)("diffs and exactly replays %s", (_label, before, after) => {
		const mutations = diffDocsToMutations(before, after);
		const carrierMutation = mutations.find(
			(mutation) =>
				mutation.kind === "addField" || mutation.kind === "updateField",
		);
		expect(carrierMutation).toBeDefined();
		if (carrierMutation?.kind === "addField") {
			expect("optionsSource" in carrierMutation.field).toBe(false);
			expect(carrierMutation.optionsSource).toEqual(SOURCE_A);
		} else if (carrierMutation?.kind === "updateField") {
			expect("optionsSource" in carrierMutation.patch).toBe(false);
			expect(carrierMutation.optionsSource).toEqual(
				"optionsSource" in after.fields[FIELD]
					? after.fields[FIELD].optionsSource
					: null,
			);
		}
		expect(replay(before, mutations)).toEqual(after);
	});
});
