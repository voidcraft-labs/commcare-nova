/** Identity-bound reads survive field, choice, structure and property edits.
 * Property renames are an exclusive semantic command, so their saved-row
 * meaning is held by a companion document rather than a mixed mutation batch.
 */
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";
import { restoreXml } from "../restore";

function renameWitness(properties: boolean) {
	const id = properties
		? "targeted-expression-property-renames"
		: "targeted-expression-renames";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const doc = buildDoc({
		appId: id,
		appName: "Identity reads",
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "score", label: proseText("Score"), data_type: "text" },
					{ name: "unique_tag", label: proseText("Tag"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListOf([
					plainColumn(uuid("column"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: form,
						name: "Read visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("root-name"),
								id: "root_name",
								label: proseText("Name"),
								default_value: "'Amina'",
							}),
							f({
								kind: "hidden",
								uuid: uuid("absolute"),
								id: "absolute",
								calculate: "/data/root_name",
							}),
							f({
								kind: "single_select",
								uuid: uuid("status"),
								id: "status",
								label: proseText("Status"),
								default_value: "'ready'",
								options: [
									{ uuid: uuid("ready"), value: "ready", label: "Ready" },
									{ uuid: uuid("waiting"), value: "waiting", label: "Waiting" },
								],
							}),
							f({
								kind: "hidden",
								uuid: uuid("choice"),
								id: "choice",
								calculate: "if(#form/status = 'ready', 'ready', 'waiting')",
							}),
							f({
								kind: "repeat",
								uuid: uuid("visits"),
								id: "visits",
								label: proseText("Readings"),
								repeat_mode: "count_bound",
								repeat_count: "2",
								children: [
									f({
										kind: "text",
										uuid: uuid("question"),
										id: "q",
										label: proseText("Reading"),
										default_value: "'Amina'",
										validate: ". != 'blocked'",
									}),
									f({
										kind: "hidden",
										uuid: uuid("relative"),
										id: "relative",
										calculate: "../q",
									}),
									f({
										kind: "hidden",
										uuid: uuid("hashtag"),
										id: "hashtag",
										calculate: "#form/visits/q",
									}),
									f({
										kind: "group",
										uuid: uuid("details"),
										id: "details",
										label: proseText("Details"),
										children: [
											f({
												kind: "text",
												uuid: uuid("marker"),
												id: "marker",
												label: proseText("Note"),
												default_value: "'marker'",
											}),
										],
									}),
								],
							}),
							f({
								kind: "repeat",
								uuid: uuid("query"),
								id: "query",
								label: proseText("Visit rows"),
								repeat_mode: "query_bound",
								data_source: {
									ids_query: "'visit-a visit-b'",
								},
								children: [
									f({
										kind: "text",
										uuid: uuid("row-label"),
										id: "row_label",
										label: proseText("Label"),
										default_value: "'row'",
									}),
									f({
										kind: "hidden",
										uuid: uuid("current"),
										id: "current",
										calculate: "current()/../row_label",
									}),
									f({
										kind: "hidden",
										uuid: uuid("row-id"),
										id: "row_id",
										calculate: "../@id",
									}),
								],
							}),
							f({
								kind: "hidden",
								uuid: uuid("typed-count"),
								id: "typed_count",
								calculate:
									"count(instance('casedb')/casedb/case[@case_type = 'visit'][score = 'eligible'])",
							}),
							f({
								kind: "hidden",
								uuid: uuid("projection"),
								id: "projection",
								calculate:
									"instance('casedb')/casedb/case[@case_type = 'visit'][@case_id = #visit/case_id]/score",
							}),
							f({
								kind: "hidden",
								uuid: uuid("bound-count"),
								id: "bound_count",
								calculate:
									"count(instance('casedb')/casedb/case[unique_tag = 'bound'])",
							}),
							f({
								kind: "hidden",
								uuid: uuid("scalar"),
								id: "scalar",
								calculate:
									"instance('casedb')/casedb/case[@case_id = #visit/case_id]/unique_tag",
							}),
						],
					},
				],
			},
		],
	});
	const edits: Mutation[] = properties
		? [
				{
					kind: "renameCaseProperties",
					renames: [
						{ caseType: "visit", from: "score", to: "assessment" },
						{ caseType: "visit", from: "unique_tag", to: "reference_tag" },
					],
				},
			]
		: [
				{
					kind: "updateField",
					uuid: uuid("question"),
					targetKind: "text",
					patch: { id: "answer" },
				},
				{
					kind: "moveField",
					uuid: uuid("question"),
					toParentUuid: uuid("details"),
					after: uuid("marker"),
				},
				{
					kind: "updateField",
					uuid: uuid("root-name"),
					targetKind: "text",
					patch: { id: "person_name" },
				},
				{
					kind: "updateOption",
					fieldUuid: uuid("status"),
					uuid: uuid("ready"),
					option: {
						uuid: uuid("ready"),
						value: "available",
						label: proseText("Ready"),
					},
				},
			];
	const changed = mutationCommitVerdict(doc, edits, LOOKUP_CONTEXT_UNAVAILABLE);
	if (!changed.ok)
		throw new Error(
			`The identity witness edit was refused: ${JSON.stringify(changed.findings)}`,
		);
	const intent: Expectation[] = (["local", "A"] as const).map((exportName) => ({
		id: `identity-values-${exportName}`,
		export: exportName,
		form,
		restore: "restore.xml",
		request: {
			session: { command: "m0-f0", data: { case_id: "visit-a" } },
			answers: [{ path: "/data/visits[1]/q", value: "Baraka" }],
			constraintChecks: [{ path: "/data/visits[1]/q", value: "blocked" }],
			expressions: [
				"/data/absolute",
				"/data/status",
				"/data/choice",
				"/data/visits[1]/relative",
				"/data/visits[1]/hashtag",
				"/data/visits[2]/relative",
				"/data/query/item[1]/current",
				"/data/query/item[1]/row_id",
				"/data/typed_count",
				"/data/projection",
				"/data/bound_count",
				"/data/scalar",
			],
		},
		expect: [
			{ pointer: "/answers/0/result", value: "ok" },
			{ pointer: "/constraints/0/result", value: "constraint" },
			...[
				"Amina",
				"ready",
				"ready",
				"Baraka",
				"Baraka",
				"Amina",
				"row",
				"visit-a",
				"1",
				"eligible",
				"1",
				"bound",
			].map((value, index) => ({ pointer: `/values/${index}/value`, value })),
		],
	}));
	return targetedDocument({
		id,
		rows: [
			"17",
			properties
				? "case-property-reference-renames"
				: "field-choice-and-repeat-reference-renames",
		],
		doc,
		edit: changed.nextDoc,
		editMutations: changed.mutations,
		expected: { intent },
		files: {
			"restore.xml": restoreXml({
				cases: [
					{
						id: "visit-a",
						type: "visit",
						name: "Amina",
						properties: { score: "eligible", unique_tag: "bound" },
					},
					{
						id: "visit-b",
						type: "visit",
						name: "Baraka",
						properties: { score: "waiting", unique_tag: "other" },
					},
				],
			}),
		},
	});
}

export function expressionRenames() {
	return renameWitness(false);
}
export function expressionPropertyRenames() {
	return renameWitness(true);
}
