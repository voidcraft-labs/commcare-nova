/**
 * A query repeat's held placement is an identity no author chooses, so no
 * ordinary edit writes it: `updateField` and `addField` refuse it
 * (`HELD_FIELD_KEYS`), an unrelated edit keeps it, a mode change takes it
 * away with its variant, and a duplicate starts unheld. The plausible failure
 * is a hold written or copied by an ordinary edit.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { duplicateFieldMutations } from "@/lib/doc/duplicateFieldMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { literal, term } from "../expression/builders";
import { HELD_FIELD_KEYS } from "../fields";

const MODULE = testUuid("held-module");
const FORM = testUuid("held-form");
const REPEAT = testUuid("held-repeat");
const CHILD = testUuid("held-child");
const NEW = testUuid("held-new");

const query = term(literal("a b"));

function fixture(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				uuid: MODULE,
				name: "Visits",
				forms: [
					{
						uuid: FORM,
						name: "Review",
						type: "survey",
						fields: [
							{
								kind: "repeat",
								id: "visits",
								uuid: REPEAT,
								label: "Visits",
								repeat_mode: "query_bound",
								data_source: { ids_query: query },
								placement: "model-iteration",
								children: [{ kind: "text", id: "note", uuid: CHILD }],
							},
						],
					},
				],
			},
		],
	});
}

function apply(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok, JSON.stringify(verdict.ok ? [] : verdict.findings)).toBe(
		true,
	);
	const store = createBlueprintDocStore();
	store.getState().load(toPersistableDoc(doc));
	store.getState().applyMany(mutations);
	return store.getState();
}

function storedRepeat(doc: BlueprintDoc, uuid = REPEAT) {
	const field = doc.fields[uuid];
	if (field?.kind !== "repeat") throw new Error("The repeat is missing.");
	return field;
}

describe("the held placement", () => {
	it("is the one held key", () => {
		expect(HELD_FIELD_KEYS).toEqual(["placement"]);
	});

	it("is refused on an updateField patch, set or cleared", () => {
		for (const placement of ["count", null]) {
			const update = {
				kind: "updateField",
				uuid: REPEAT,
				targetKind: "repeat",
				patch: { placement },
			};
			expect(mutationSchema.safeParse(update).success).toBe(false);
			expect(
				mutationCommitVerdict(fixture(), [update], LOOKUP_CONTEXT_UNAVAILABLE)
					.ok,
			).toBe(false);
		}
	});

	it("is refused on a field addField carries", () => {
		const add = {
			kind: "addField",
			parentUuid: FORM,
			field: {
				kind: "repeat",
				uuid: NEW,
				id: "more_visits",
				repeat_mode: "query_bound",
				data_source: { ids_query: query },
				placement: "count",
			},
		};
		expect(mutationSchema.safeParse(add).success).toBe(false);
		expect(
			mutationCommitVerdict(fixture(), [add], LOOKUP_CONTEXT_UNAVAILABLE).ok,
		).toBe(false);
		const { placement: _held, ...unheld } = add.field;
		expect(mutationSchema.safeParse({ ...add, field: unheld }).success).toBe(
			true,
		);
	});

	it("stays through an unrelated edit", () => {
		const next = apply(fixture(), [
			{
				kind: "updateField",
				uuid: REPEAT,
				targetKind: "repeat",
				patch: { id: "household_visits" },
			},
		]);
		const repeat = storedRepeat(next);
		expect(repeat.id).toBe("household_visits");
		expect(repeat.repeat_mode === "query_bound" && repeat.placement).toBe(
			"model-iteration",
		);
	});

	it("leaves with its variant when the repeat stops following a query", () => {
		const next = apply(fixture(), [
			{
				kind: "updateField",
				uuid: REPEAT,
				targetKind: "repeat",
				patch: { repeat_mode: "user_controlled" },
			},
		]);
		const repeat = storedRepeat(next);
		expect(repeat.repeat_mode).toBe("user_controlled");
		expect(Object.hasOwn(repeat, "placement")).toBe(false);
	});

	it("is not copied to a duplicate, which starts unheld", () => {
		const doc = fixture();
		const plan = duplicateFieldMutations(doc, REPEAT);
		if (plan === undefined) throw new Error("The duplicate plan is missing.");
		const next = apply(doc, plan.mutations);
		const clone = storedRepeat(next, plan.cloneUuid);
		expect(clone.repeat_mode).toBe("query_bound");
		expect(Object.hasOwn(clone, "placement")).toBe(false);
		const source = storedRepeat(next);
		expect(source.repeat_mode === "query_bound" && source.placement).toBe(
			"model-iteration",
		);
	});
});
