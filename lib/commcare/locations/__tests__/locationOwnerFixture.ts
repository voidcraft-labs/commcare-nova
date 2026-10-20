import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, type OrganizationLevel } from "@/lib/domain";
import { term } from "@/lib/domain/expression";

export const LOCATION_FORM = testUuid("location-owner-form");
export const LOCATION_REPEAT = testUuid("location-owner-repeat");
export const LOCATION_REPEAT_COUNT = testUuid("location-owner-repeat-count");
export const LOCATION_LEVELS = ["region", "district", "clinic"].map(
	(code, index): OrganizationLevel => ({
		uuid: testUuid(`location-level-${code}`),
		code,
		name: code,
		...(index
			? {
					parentLevelUuid: testUuid(
						`location-level-${index === 1 ? "region" : "district"}`,
					),
				}
			: {}),
		caseFlow: { workers: "none", ownsCases: index !== 1 },
		addressBook: { reach: "own-branch" },
	}),
);
export const LOCATION_SCENARIOS = ["direct", "multirung", "plain"] as const;
export type LocationScenario = (typeof LOCATION_SCENARIOS)[number];
/** `placeRead` adds a question whose calculate reads the first place's name,
 * a form-logic read of places beside the owner's. `inRepeat` runs the owner's
 * operation once per row of a repeat: one the worker adds rows to, or one
 * with as many rows as the `how_many` question says. */
export function locationOwnerFixture(
	scenario: LocationScenario,
	options: {
		readonly placeRead?: true;
		readonly inRepeat?: "user_controlled" | "count_bound";
	} = {},
) {
	const doc = buildDoc({
		appName: "Location owner evidence",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: LOCATION_FORM,
						name: "Transfer",
						type: "followup",
						fields: [
							f({ kind: "text", id: "note" }),
							...(options.inRepeat === "count_bound"
								? [
										f({
											uuid: LOCATION_REPEAT_COUNT,
											kind: "int",
											id: "how_many",
										}),
										f({
											uuid: LOCATION_REPEAT,
											kind: "repeat",
											id: "moves",
											repeat_mode: "count_bound",
											repeat_count: term({
												kind: "field",
												uuid: LOCATION_REPEAT_COUNT,
											}),
											children: [f({ kind: "text", id: "reason" })],
										}),
									]
								: options.inRepeat === "user_controlled"
									? [
											f({
												uuid: LOCATION_REPEAT,
												kind: "repeat",
												id: "moves",
												repeat_mode: "user_controlled",
												children: [f({ kind: "text", id: "reason" })],
											}),
										]
									: []),
							...(options.placeRead
								? [
										f({
											kind: "hidden",
											id: "first_place",
											calculate: {
												kind: "project",
												of: { kind: "locations", where: [] },
												value: { kind: "location-field", field: "name" },
											},
										}),
									]
								: []),
						],
					},
				],
			},
		],
	});
	const levels = LOCATION_LEVELS.map((level) =>
		scenario === "direct" && level.code === "district"
			? { ...level, caseFlow: { workers: "none" as const, ownsCases: true } }
			: level,
	);
	doc.organizationLevels = Object.fromEntries(
		levels.map((level) => [level.uuid, level]),
	);
	doc.organizationLevelOrder = levels.map((level) => level.uuid);
	doc.forms[LOCATION_FORM].caseOperations = [
		{
			uuid: testUuid("location-owner-operation"),
			id: "transfer",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			...(options.inRepeat === undefined
				? {}
				: { forEach: { repeat: LOCATION_REPEAT } }),
			owner:
				scenario === "plain"
					? { kind: "acting-user" }
					: term({
							kind: "owner-location-at-level",
							levelUuid: LOCATION_LEVELS[2].uuid,
							ownerCaseType: "patient",
						}),
		},
	];
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings));
	return doc;
}
