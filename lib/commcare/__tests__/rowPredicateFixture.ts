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
