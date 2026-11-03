import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FormSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type FormOtherwise,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const INTAKE = testUuid("mod-intake");
const CARE = testUuid("mod-care");
const REGISTER = testUuid("frm-reg");
const VISIT = testUuid("frm-visit");

type FixtureLinks = NonNullable<FormSpec["formLinks"]>;

const ALICE = "#user/username = 'alice'";
const toVisit = { type: "form" as const, moduleUuid: CARE, formUuid: VISIT };
const toCare = { type: "module" as const, moduleUuid: CARE };
const carried = (xpath: string) => [
	{ name: { kind: "selected-case" as const, module: CARE }, xpath },
];

/** Each scenario's destinations and otherwise on the registration form
 *  "Register frog" in menu Intake. */
const SCENARIOS = {
	/** A conditional destination to Visit; the otherwise link opens Frog
	 *  care. */
	else: {
		links: [{ uuid: "lnk-cond", condition: ALICE, target: toVisit }],
		otherwise: { kind: "link", uuid: testUuid("lnk-else"), target: toCare },
	},
	/** A conditional destination to Visit; the otherwise is this menu. */
	module: {
		links: [{ uuid: "lnk-cond", condition: ALICE, target: toVisit }],
		otherwise: { kind: "destination", destination: "module" },
	},
	/** A conditional destination to Visit and no otherwise: the app home
	 *  follows when it does not run. */
	home: {
		links: [{ uuid: "lnk-cond", condition: ALICE, target: toVisit }],
	},
	/** A conditional destination to Visit; the otherwise is the previous
	 *  screen. */
	previous: {
		links: [{ uuid: "lnk-cond", condition: ALICE, target: toVisit }],
		otherwise: { kind: "destination", destination: "previous" },
	},
	/** One every-time destination to Frog care. */
	unconditional: {
		links: [{ uuid: "lnk-else", target: toCare }],
	},
	/** Overlapping conditions, each written with the exclusivity of the
	 *  earlier one, and an otherwise link back to Intake. */
	overlap: {
		links: [
			{ uuid: "lnk-cond", condition: ALICE, target: toVisit },
			{
				uuid: "lnk-second",
				condition: `(${ALICE} or #user/username = 'bea') and not(${ALICE})`,
				target: toCare,
			},
		],
		otherwise: {
			kind: "link",
			uuid: testUuid("lnk-fallback"),
			target: { type: "module", moduleUuid: INTAKE },
		},
	},
	/** An every-time destination to Visit carrying a literal case id, which
	 *  the held-case guard turns into a destination that may not run. */
	manual: {
		links: [
			{ uuid: "lnk-cond", target: toVisit, datums: carried("'explicit-frog'") },
		],
	},
	/** A destination to Visit as alice, then an every-time destination to
	 *  Frog care; the otherwise is the first menu. As alice both run in
	 *  author order; as anyone else the otherwise opens first and the
	 *  every-time destination after it. */
	chain: {
		links: [
			{ uuid: "lnk-cond", condition: ALICE, target: toVisit },
			{ uuid: "lnk-every", target: toCare },
		],
		otherwise: { kind: "destination", destination: "firstMenu" },
	},
	/** Start this form again, every time: a new registration. */
	"this-form": {
		links: [{ uuid: "lnk-again", target: { type: "this-form" as const } }],
	},
	/** A destination to Visit carrying a case the device never holds, then a
	 *  destination to Visit carrying the new case as alice; the otherwise is
	 *  this menu. As alice the first pushes no frame and the second opens; as
	 *  anyone else neither runs and the otherwise opens. */
	"carried-held": {
		links: [
			{
				uuid: "lnk-missing",
				target: toVisit,
				datums: carried("'no-such-frog'"),
			},
			{
				uuid: "lnk-held",
				condition: ALICE,
				target: toVisit,
				datums: carried("#frog/case_id"),
			},
		],
		otherwise: { kind: "destination", destination: "module" },
	},
} satisfies Record<
	string,
	{ readonly links: FixtureLinks; readonly otherwise?: FormOtherwise }
>;

function buildFixture(scenario: FormLinkWireScenario): BlueprintDoc {
	const { links, ...rest } = SCENARIOS[scenario];
	const otherwise: FormOtherwise | undefined =
		"otherwise" in rest ? (rest.otherwise as FormOtherwise) : undefined;
	return buildDoc(
		{
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
							formLinks: links,
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: { caseType: "frog", property: "case_name" },
								}),
							],
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
		},
		(doc) => {
			if (otherwise === undefined) return;
			const form = doc.forms[REGISTER];
			if (form === undefined) throw new Error("The fixture lost its form.");
			doc.forms[REGISTER] = { ...form, otherwise };
		},
	);
}

/** The scenario ids are corpus document ids (`form-link-<scenario>`):
 *  keep every one. */
export const formLinkWireScenarios = [
	"else",
	"module",
	"home",
	"previous",
	"unconditional",
	"overlap",
	"manual",
	"chain",
	"this-form",
	"carried-held",
] as const satisfies readonly (keyof typeof SCENARIOS)[];
export type FormLinkWireScenario = (typeof formLinkWireScenarios)[number];

/** One scenario's document, through the schema and the commit gate. */
export function formLinkWireFixture(
	scenario: FormLinkWireScenario,
): BlueprintDoc {
	const doc = buildFixture(scenario);
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify({ scenario, findings }));
	return doc;
}
