/**
 * A form read inside a row predicate, in the forms the native `expression`
 * family runs in Core (`proof/native/core/RowPredicateCurrentRuntimeTest.java`,
 * written by `proof/native/producers/emit-expression-evidence.ts` under
 * `row-predicates/`).
 *
 * The survey "Rounds" holds a repeat `visits` whose question `kind` each
 * entry answers, and three hidden values in each entry counting rows whose
 * value matches the entry's own `kind`, each through a predicate Core
 * evaluates its own way: `indexed`, an equality on the case's type and its
 * owner, both indexed paths of the casedb, which Core answers through its
 * predicate index in the bind's context (`StorageBackedTreeRoot.tryBatchChildFetch`);
 * `scanned`, a `contains()` test of an unindexed property, which Core
 * evaluates row by row (`EvaluationContext.expandReferenceAccumulator`); and
 * `placed`, an attribute equality over the in-memory locations fixture
 * (`TreeUtilities.tryBatchChildFetch`). Nova prints each read
 * `current()/../kind`, since the read crosses the repeat the slot is in
 * (`xpath/wire/formReads.ts`). A repeat's own relevant reading an answer
 * inside it is a loop Nova's gate refuses (`CYCLE`), so no form Core installs
 * holds one.
 */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	NEW_APP_SETTINGS,
	type OrganizationLevel,
	proseText,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";

export const ROW_PREDICATE_FORM = testUuid("row-predicate-rounds");
export const ROW_PREDICATE_VISITS = testUuid("row-predicate-visits");
export const ROW_PREDICATE_KIND = testUuid("row-predicate-kind");
const CLINIC_LEVEL = testUuid("row-predicate-clinic-level");
export const ROW_DEFAULT_FORM = testUuid("row-default-starts");
const ROW_DEFAULT_SEED = testUuid("row-default-seed");
const ROW_DEFAULT_ROUNDS = testUuid("row-default-rounds");
const ROW_DEFAULT_ENTRY = testUuid("row-default-entry");
const seed: Expression = {
	kind: "term",
	term: { kind: "field", uuid: ROW_DEFAULT_SEED },
};

const kind: Expression = {
	kind: "term",
	term: { kind: "field", uuid: ROW_PREDICATE_KIND },
};
const visitRows = (where: Expression): Expression => ({
	kind: "cases",
	source: "casedb",
	where: [
		{
			kind: "eq",
			left: { kind: "term", term: { kind: "case-row-type" } },
			right: { kind: "term", term: { kind: "literal", value: "visit" } },
		},
		where,
	],
});
const containsKind: Expression = {
	kind: "call",
	fn: "contains",
	args: [
		{
			kind: "term",
			term: { kind: "prop", caseType: "visit", property: "kind_text" },
		},
		kind,
	],
};
const count = (via: Expression): Expression => ({ kind: "count", via });

/** The rows the Core class gives the form: three visit cases, each owned by
 * a kind and naming it in `kind_text`, and one place whose id is a kind. */
export const ROW_PREDICATE_ROWS = {
	cases: [
		{ id: "visit-1", owner: "home", kindText: "home visit" },
		{ id: "visit-2", owner: "home", kindText: "home check" },
		{ id: "visit-3", owner: "clinic", kindText: "clinic day" },
	],
	places: [{ id: "home", type: "clinic", name: "Home" }],
	/** Two entries and what each counts under every predicate. */
	entries: [
		{ kind: "home", indexed: "2", scanned: "2", placed: "1" },
		{ kind: "clinic", indexed: "1", scanned: "1", placed: "0" },
	],
} as const;

export function rowPredicateDoc(): BlueprintDoc {
	const level: OrganizationLevel = {
		uuid: CLINIC_LEVEL,
		code: "clinic",
		name: "Clinic",
		caseFlow: { workers: "none", ownsCases: false },
		addressBook: { reach: "own-branch" },
	};
	const doc = buildDoc({
		appName: "Rounds",
		appSettings: { ...NEW_APP_SETTINGS },
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "kind_text", label: proseText("Kind") },
				],
			},
		],
		modules: [
			{
				name: "Rounds",
				forms: [
					{
						uuid: ROW_PREDICATE_FORM,
						name: "Rounds",
						type: "survey",
						fields: [
							f({
								kind: "repeat",
								uuid: ROW_PREDICATE_VISITS,
								id: "visits",
								label: proseText("Visits"),
								children: [
									f({
										kind: "text",
										uuid: ROW_PREDICATE_KIND,
										id: "kind",
										label: proseText("Kind"),
									}),
									f({
										kind: "hidden",
										id: "indexed",
										calculate: count(
											visitRows({
												kind: "eq",
												left: {
													kind: "term",
													term: {
														kind: "prop",
														caseType: "visit",
														property: "owner_id",
													},
												},
												right: kind,
											}),
										),
									}),
									f({
										kind: "hidden",
										id: "scanned",
										calculate: count(visitRows(containsKind)),
									}),
									f({
										kind: "hidden",
										id: "placed",
										calculate: count({
											kind: "locations",
											where: [
												{
													kind: "eq",
													left: {
														kind: "term",
														term: { kind: "location-field", field: "id" },
													},
													right: kind,
												},
											],
										}),
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	doc.organizationLevels = { [CLINIC_LEVEL]: level };
	doc.organizationLevelOrder = [CLINIC_LEVEL];
	return doc;
}

/** The rows the Core class gives the starting values' form: no case, and one
 *  place, named for the second entry. */
export const ROW_DEFAULT_ROWS = {
	cases: [],
	places: [{ id: "second", type: "clinic", name: "2" }],
	/** What each entry's starting values hold, by how many entries the form
	 *  makes: `copy` the seed, `entry` its own place in the repeat, and
	 *  `named` the places named for that place. */
	entries: [
		{ copy: "s", entry: "1", named: "0" },
		{ copy: "s", entry: "2", named: "1" },
		{ copy: "s", entry: "3", named: "0" },
	],
} as const;

/**
 * The survey "Starts": `seed` starts as `s` and `early` starts as `seed`'s
 * answer, both when the form opens; in the repeat `rounds`, each new entry's
 * `copy` starts as `seed`, its `entry` as a count of the repeat (one, since
 * Core counts the entry it is made in; the Core class writes the entry's
 * position there), and `named` as the number of places named that number, a read
 * of the places filtered by another question of the entry. Nova prints every
 * starting value's read of a question through `current()` (`xpath/wire/formReads.ts`),
 * and the Core class makes the absolute spelling from the same bytes.
 */
export function rowDefaultDoc(): BlueprintDoc {
	const level: OrganizationLevel = {
		uuid: CLINIC_LEVEL,
		code: "clinic",
		name: "Clinic",
		caseFlow: { workers: "none", ownsCases: false },
		addressBook: { reach: "own-branch" },
	};
	const doc = buildDoc({
		appName: "Starts",
		appSettings: { ...NEW_APP_SETTINGS },
		modules: [
			{
				name: "Starts",
				forms: [
					{
						uuid: ROW_DEFAULT_FORM,
						name: "Starts",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: ROW_DEFAULT_SEED,
								id: "seed",
								label: proseText("Seed"),
								default_value: {
									kind: "term",
									term: { kind: "literal", value: "s" },
								},
							}),
							f({
								kind: "text",
								id: "early",
								label: proseText("Early"),
								default_value: seed,
							}),
							f({
								kind: "repeat",
								uuid: ROW_DEFAULT_ROUNDS,
								id: "rounds",
								label: proseText("Rounds"),
								children: [
									f({
										kind: "text",
										id: "copy",
										label: proseText("Copy"),
										default_value: seed,
									}),
									f({
										kind: "hidden",
										uuid: ROW_DEFAULT_ENTRY,
										id: "entry",
										default_value: {
											kind: "count",
											via: {
												kind: "term",
												term: { kind: "field", uuid: ROW_DEFAULT_ROUNDS },
											},
										},
									}),
									f({
										kind: "hidden",
										id: "named",
										default_value: {
											kind: "count",
											via: {
												kind: "locations",
												where: [
													{
														kind: "eq",
														left: {
															kind: "term",
															term: { kind: "location-field", field: "name" },
														},
														right: {
															kind: "term",
															term: { kind: "field", uuid: ROW_DEFAULT_ENTRY },
														},
													},
												],
											},
										},
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	doc.organizationLevels = { [CLINIC_LEVEL]: level };
	doc.organizationLevelOrder = [CLINIC_LEVEL];
	return doc;
}
