import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { type CaseOperation, proseText } from "@/lib/domain";
import {
	actingUser,
	eq,
	exists,
	formField,
	idOf,
	literal,
	prop,
	subcasePath,
	term,
	unowned,
} from "@/lib/domain/predicate";

const FORM = testUuid("66666666-6666-4666-8666-666666666666");
const CREATE = testUuid("44444444-4444-4444-8444-444444444444");
const REPEAT = testUuid("22222222-2222-4222-8222-222222222222");
const TEXT = testUuid("11111111-1111-4111-8111-111111111111");
const KEY = testUuid("33333333-3333-4333-8333-333333333333");
const ENABLED = testUuid("operation-enabled");
const DESTINATION = testUuid("operation-destination");
export const operationScenarios = [
	"sequence",
	"conditional",
	"retype",
	"expression-retype",
	"repeat",
	"query",
	"key-query",
	"key",
	"link",
	"scalar",
	"relation",
	"nested",
] as const;
export type OperationScenario = (typeof operationScenarios)[number];
export function caseOperationFixture(scenario: OperationScenario) {
	const repeat =
		scenario === "repeat" || scenario === "query" || scenario === "key-query";
	const query = scenario === "query" || scenario === "key-query";
	const keyed = scenario === "key" || scenario === "key-query";
	const field = f({
		uuid: TEXT,
		kind: "text",
		id: "answer",
		label: proseText("Answer"),
	});
	const key = f({
		uuid: KEY,
		kind: "text",
		id: "key",
		label: proseText("Key"),
	});
	const create: CaseOperation = {
		uuid: CREATE,
		id: "create_visit",
		action: "create",
		caseType: "visit",
		target: keyed ? { kind: "new", idFrom: KEY } : { kind: "new" },
		name: term(formField(TEXT)),
		owner: actingUser(),
		writes: [
			{
				property: "source_id",
				value: term(
					prop("patient", scenario === "sequence" ? "nickname" : "case_name"),
				),
			},
		],
		links: [
			{
				identifier: "parent",
				targetType: "patient",
				target: { kind: "session" },
				relationship: "child",
			},
		],
		...(repeat ? { forEach: { repeat: REPEAT } } : {}),
		...(scenario === "conditional"
			? { condition: eq(formField(ENABLED), literal("yes")) }
			: {}),
	};
	const op = (
		id: string,
		patch: Omit<CaseOperation, "uuid" | "id">,
	): CaseOperation => ({
		uuid: testUuid(id),
		id,
		...patch,
	});
	const session = { kind: "session" } as const;
	const made = { kind: "op", opUuid: CREATE } as const;
	let operations: CaseOperation[];
	if (scenario === "retype" || scenario === "expression-retype") {
		const target =
			scenario === "retype"
				? session
				: { kind: "expression" as const, expr: term(formField(DESTINATION)) };
		operations = [
			op("promote", {
				action: "update",
				caseType: "patient",
				target,
				retype: "visit",
				condition: eq(formField(ENABLED), literal("yes")),
			}),
			op("rename_promoted", {
				action: "update",
				caseType: "visit",
				target,
				rename: term(formField(TEXT)),
			}),
			op("finish_promoted", { action: "close", caseType: "visit", target }),
		];
	} else if (scenario === "nested") {
		operations = [
			op("update_child", {
				action: "update",
				caseType: "patient",
				target: session,
				writes: [
					{ property: "nickname", value: term(prop("patient", "case_name")) },
				],
			}),
		];
	} else if (scenario === "relation") {
		operations = [
			op("mark_related", {
				action: "update",
				caseType: "patient",
				target: session,
				condition: exists(
					subcasePath("parent", "visit"),
					eq(prop("visit", "nickname"), formField(TEXT)),
				),
				writes: [
					{ property: "nickname", value: term(literal("Matched child")) },
				],
			}),
		];
	} else if (scenario === "link") {
		operations = [
			op("link_patient", {
				action: "update",
				caseType: "patient",
				target: session,
				links: [
					{
						identifier: "related",
						targetType: "patient",
						relationship: "child",
						target: { kind: "expression", expr: term(formField(DESTINATION)) },
					},
				],
			}),
		];
	} else if (scenario === "scalar") {
		operations = [
			op("rename_patient", {
				action: "update",
				caseType: "patient",
				target: session,
				rename: term(formField(TEXT)),
				owner: term(formField(DESTINATION)),
				writes: [{ property: "external_id", value: term(formField(KEY)) }],
			}),
		];
	} else if (keyed) {
		operations = [create];
	} else {
		operations = [
			create,
			op("tag_visit", {
				action: "update",
				caseType: "visit",
				target: made,
				owner: unowned(),
				...(repeat
					? {
							condition: exists(
								subcasePath("parent", "visit"),
								eq(prop("visit", "nickname"), formField(TEXT)),
							),
						}
					: {}),
				writes: [
					{
						property: "nickname",
						value: idOf(CREATE),
						condition: eq(formField(KEY), literal("write")),
					},
				],
				...(repeat ? { forEach: { repeat: REPEAT } } : {}),
			}),
			op("unlink_visit", {
				action: "update",
				caseType: "visit",
				target: made,
				links: [
					{
						identifier: "parent",
						targetType: "patient",
						target: null,
						relationship: "child",
					},
				],
				...(repeat ? { forEach: { repeat: REPEAT } } : {}),
			}),
			op("finish_visit", {
				action: "close",
				caseType: "visit",
				target: made,
				writes: [{ property: "final_note", value: term(literal("Finished")) }],
				...(repeat ? { forEach: { repeat: REPEAT } } : {}),
			}),
		];
	}
	if (scenario === "sequence")
		operations.unshift(
			op("before_ordinary", {
				action: "update",
				caseType: "patient",
				target: session,
				writes: [
					{ property: "nickname", value: term(literal("Advanced first")) },
				],
			}),
		);
	const doc = buildDoc({
		appName: "Case operation evidence",
		caseTypes: [
			...["patient", "visit"].map((name) => ({
				name,
				...(name === "patient" && scenario === "nested"
					? { parent_type: "household" }
					: {}),
				...(name === "visit" && (scenario === "relation" || repeat)
					? { parent_type: "patient" }
					: {}),
				properties: ["nickname", "source_id", "final_note"].map((name) => ({
					name,
					label: proseText(name),
					data_type: "text" as const,
				})),
			})),
			...(scenario === "nested" ? [{ name: "household", properties: [] }] : []),
		],
		modules: [
			...(scenario === "nested"
				? [
						{
							name: "Households",
							caseType: "household",
							caseListConfig: caseListConfig([
								{ field: "case_name", header: "Name" },
							]),
							forms: [
								{
									name: "Household overview",
									type: "followup" as const,
									fields: [f({ kind: "text", id: "household_note" })],
								},
							],
						},
					]
				: []),
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FORM,
						name: "Edit",
						type: "followup",
						fields: [
							f({ uuid: ENABLED, kind: "text", id: "enabled" }),
							f({ uuid: DESTINATION, kind: "text", id: "destination" }),
							...(repeat
								? [
										f({
											uuid: REPEAT,
											kind: "repeat",
											id: "items",
											...(query
												? {
														repeat_mode: "query_bound",
														data_source: { ids_query: "'first second'" },
													}
												: { repeat_mode: "user_controlled" }),
											children: [field, key],
										}),
									]
								: [field, key]),
							...(scenario === "sequence"
								? [
										f({
											kind: "text",
											id: "ordinary_note",
											caseWrite: { caseType: "patient", property: "nickname" },
										}),
									]
								: []),
						],
					},
				],
			},
			{
				name: "Visits",
				caseType: "visit",
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [],
			},
		],
	});
	if (scenario === "nested") {
		doc.modules[doc.moduleOrder[1]].parentModuleUuid = doc.moduleOrder[0];
	}
	doc.forms[FORM].caseOperations = operations;
	return doc;
}
