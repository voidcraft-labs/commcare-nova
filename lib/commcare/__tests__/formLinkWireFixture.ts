import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type PostSubmitDestination,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const CARE = testUuid("mod-care");
const VISIT = testUuid("frm-visit");

function buildFixture(
	postSubmit: PostSubmitDestination | undefined,
	links:
		| "conditional-then-else"
		| "conditional-only"
		| "unconditional"
		| "overlap"
		| "manual",
): BlueprintDoc {
	const nameWriter = () =>
		f({
			kind: "text",
			id: "case_name",
			label: proseText("Name"),
			caseWrite: { caseType: "frog", property: "case_name" },
		});
	const conditional = {
		uuid: "lnk-cond",
		condition: "#user/username = 'alice'",
		target: { type: "form" as const, moduleUuid: CARE, formUuid: VISIT },
	};
	const unconditional = {
		uuid: "lnk-else",
		target: { type: "module" as const, moduleUuid: CARE },
	};
	return buildDoc({
		appName: "Parity",
		caseTypes: [
			{
				name: "frog",
				properties: [{ name: "mood", label: proseText("Mood") }],
			},
		],
		modules: [
			{
				uuid: "mod-intake",
				name: "Intake",
				caseType: "frog",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-reg",
						name: "Register frog",
						type: "registration",
						...(postSubmit !== undefined && { postSubmit }),
						formLinks:
							links === "overlap"
								? [
										conditional,
										{
											...unconditional,
											uuid: "lnk-second",
											condition:
												"#user/username = 'alice' or #user/username = 'bea'",
										},
										{
											uuid: "lnk-fallback",
											target: {
												type: "module",
												moduleUuid: testUuid("mod-intake"),
											},
										},
									]
								: links === "manual"
									? [
											{
												...conditional,
												condition: undefined,
												datums: [{ name: "case_id", xpath: "'explicit-frog'" }],
											},
										]
									: links === "conditional-then-else"
										? [conditional, unconditional]
										: links === "conditional-only"
											? [conditional]
											: [unconditional],
						fields: [nameWriter()],
					},
				],
			},
			{
				uuid: "mod-care",
				name: "Frog care",
				caseType: "frog",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-visit",
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "mood",
								label: proseText("Mood"),
								caseWrite: { caseType: "frog", property: "mood" },
							}),
						],
					},
				],
			},
		],
	});
}

export const formLinkWireScenarios = [
	"else",
	"module",
	"home",
	"previous",
	"unconditional",
	"overlap",
	"manual",
] as const;
export type FormLinkWireScenario = (typeof formLinkWireScenarios)[number];
export function formLinkWireFixture(
	scenario: FormLinkWireScenario,
): BlueprintDoc {
	const doc =
		scenario === "else"
			? buildFixture(undefined, "conditional-then-else")
			: scenario === "module"
				? buildFixture("module", "conditional-only")
				: scenario === "home"
					? buildFixture("app_home", "conditional-only")
					: scenario === "previous"
						? buildFixture("previous", "conditional-only")
						: buildFixture(undefined, scenario);
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify({ scenario, findings }));
	return doc;
}
