// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Native constraint markers must remain literal test data.
/** Admitted documents for structural and unchanged native consumer checks. */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	type ProseTemplate,
	proseText,
} from "@/lib/domain";
import { runValidation } from "../validator/runner";
import { mediaIds, mediaManifest, mediaRecords } from "./mediaWireFixtures";

export const constraintMessageScenarios = [
	"plain",
	"empty",
	"literal",
	"references",
	"all-kinds",
	"single",
	"blank",
	"irrelevant",
	"multiple",
] as const;
export type ConstraintMessageScenario =
	(typeof constraintMessageScenarios)[number];
export const CONSTRAINT_VALUE = testUuid("constraint-value");
export const CONSTRAINT_CHECKED = testUuid("constraint-checked");
export const CONSTRAINT_WORKER_PROPERTY = testUuid(
	"constraint-worker-property",
);

export function constraintMessageFixture(scenario: ConstraintMessageScenario) {
	const value = f({
		kind: "text",
		uuid: CONSTRAINT_VALUE,
		id: "value",
		label: "Value",
		...(scenario === "blank" ? {} : { default_value: "'Data ${0} / ${00}'" }),
		...(scenario === "irrelevant" ? { relevant: "false()" } : {}),
	});
	let message: ProseTemplate;
	switch (scenario) {
		case "plain":
			message = proseText("Use a value below ten");
			break;
		case "empty":
			message = proseText("");
			break;
		case "literal":
			message = proseText(
				'Literal ${0} / ${00}; It\'s "early"\u00a0today <output/> & #form/value',
			);
			break;
		case "references":
			message = {
				parts: [
					{ kind: "text", text: "Literal ${0}; " },
					{ kind: "field-ref", uuid: CONSTRAINT_VALUE },
					{ kind: "text", text: " / " },
					{ kind: "field-ref", uuid: CONSTRAINT_CHECKED },
				],
			};
			break;
		case "all-kinds":
			message = {
				parts: [
					{ kind: "text", text: "Literal ${00}; " },
					{ kind: "field-ref", uuid: CONSTRAINT_VALUE },
					{ kind: "text", text: " | Case: " },
					{ kind: "case-ref", caseType: "patient", property: "memo" },
					{ kind: "text", text: " | Worker: " },
					{
						kind: "user-property-ref",
						userPropertyUuid: CONSTRAINT_WORKER_PROPERTY,
					},
					{ kind: "text", text: " | External: " },
					{ kind: "user-ref", property: "external_extra" },
					{ kind: "text", text: " | Answer: " },
					{ kind: "field-ref", uuid: CONSTRAINT_CHECKED },
				],
			};
			break;
		default:
			message = { parts: [{ kind: "field-ref", uuid: CONSTRAINT_VALUE }] };
	}
	const assets = new Map(
		[...mediaManifest()].filter(
			([id]) =>
				id === mediaIds.icon || id === mediaIds.audio || id === mediaIds.video,
		),
	);
	const doc = buildDoc({
		appName: `Constraint ${scenario}`,
		...(scenario === "all-kinds"
			? {
					caseTypes: [
						{
							name: "patient",
							properties: [
								{ name: "memo", label: "Memo" },
								{ name: "score", data_type: "int", label: "Score" },
							],
						},
					],
				}
			: {}),
		modules: [
			{
				name: "Work",
				...(scenario === "all-kinds"
					? {
							caseType: "patient",
							caseListConfig: caseListConfig([
								{ field: "case_name", header: "Name" },
							]),
						}
					: {}),
				forms: [
					{
						uuid: testUuid("constraint-form"),
						name: "Check",
						type: scenario === "all-kinds" ? "followup" : "survey",
						fields: [
							...(scenario === "multiple"
								? [
										f({
											kind: "repeat",
											id: "rows",
											repeat_mode: "count_bound",
											repeat_count: "2",
											children: [value],
										}),
									]
								: [value]),
							f({ kind: "label", id: "ordinary_output", label: message }),
							f({
								kind: "int",
								uuid: CONSTRAINT_CHECKED,
								id: "checked",
								label: "Checked",
								default_value: "4",
								validate: ". < 10",
								validate_msg: message,
								...(scenario === "all-kinds"
									? {
											caseWrite: { caseType: "patient", property: "score" },
											validate_msg_media: {
												image: mediaIds.icon,
												audio: mediaIds.audio,
												video: mediaIds.video,
											},
										}
									: {}),
							}),
						],
					},
				],
			},
		],
	});
	if (scenario === "all-kinds") {
		doc.userProperties = {
			[CONSTRAINT_WORKER_PROPERTY]: {
				uuid: CONSTRAINT_WORKER_PROPERTY,
				slug: "worker_status",
				label: "Worker status",
			},
		};
		doc.userPropertyOrder = [CONSTRAINT_WORKER_PROPERTY];
	}
	admitConstraintMessageFixture(doc, assets);
	return { doc, assets, formUuid: testUuid("constraint-form") };
}

export function admitConstraintMessageFixture(
	doc: ReturnType<typeof buildDoc>,
	assets = mediaManifest(),
): void {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
		mediaAssets: mediaRecords(assets),
	});
	if (findings.length > 0) throw new Error(JSON.stringify(findings));
}
