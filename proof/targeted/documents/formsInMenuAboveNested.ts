import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { eq, literal, or, prop, sessionUser } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

/**
 * Forms in the menu above under parents that keep their screens
 * (`targeted-forms-in-menu-above-nested`).
 *
 * - "Households" is case first, for a visitor. Its submenu "Household
 *   checks", for a checker or a visitor, shows its two follow-up forms there
 *   (the screen stays case first): "Check household", whose display condition
 *   reads the household, and "Review household", which has none, so with no
 *   household chosen the two menus' conditions alone decide whether it shows,
 *   and a checker, whom the parent's condition refuses, does not see it. Its
 *   submenu "Household list" shows only its case list entry there (the screen
 *   still stays case first); "Household extras" keeps its screen and returns
 *   to its parent after submit.
 * - "Members" has a submenu "Member registration" that shows a registration
 *   form there (the screen turns forms first), and a submenu "Member
 *   referrals" that shows a follow-up of a referral, a case under the
 *   member, there.
 * - "Outreach" is a top-level menu above with one submenu that keeps its
 *   screen and one that shows its forms above too.
 * - The follow-up and the registration form of the two submenus above
 *   return to the previous screen, and each is a link's target.
 *
 * It declares both platforms. Fixed value: the outreach task's question
 * holds the text the worker enters (`./echo.ts`).
 */
export function formsInMenuAboveNested() {
	const id = "targeted-forms-in-menu-above-nested";
	const key = (name: string) => targetedUuid(id, name);
	const note = (name: string) =>
		f({
			uuid: key(`${name}-note`),
			kind: "text",
			id: "note",
			label: proseText("Note"),
		});
	const nameField = (name: string, caseType: string) =>
		f({
			uuid: key(`${name}-name`),
			kind: "text",
			id: "case_name",
			label: proseText("Name"),
			caseWrite: { caseType, property: "case_name" },
		});
	const list = (name: string) =>
		caseListOf([plainColumn(key(`${name}-name`), "case_name", "Name")]);
	const surveyOf = (name: string, title: string) => ({
		uuid: key(name),
		name: title,
		type: "survey" as const,
		fields: [
			f({
				uuid: key(`${name}-question`),
				kind: "text",
				id: "question",
				label: proseText("Question"),
			}),
		],
	});
	const doc = buildDoc({
		appId: id,
		appName: "Forms above in a parent",
		caseTypes: [
			{
				name: "household",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
				],
			},
			{
				name: "member",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "referral",
				parent_type: "member",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: key("households"),
				name: "Households",
				caseType: "household",
				displayCondition: eq(sessionUser("role"), literal("visitor")),
				caseListConfig: list("households"),
				forms: [
					{
						uuid: key("visit-household"),
						name: "Visit household",
						type: "followup",
						formLinks: [
							{
								uuid: key("visit-household-link"),
								target: {
									type: "form",
									moduleUuid: key("household-checks"),
									formUuid: key("check-household"),
								},
							},
						],
						fields: [note("visit-household")],
					},
				],
			},
			{
				uuid: key("household-checks"),
				name: "Household checks",
				caseType: "household",
				displayCondition: or(
					eq(sessionUser("role"), literal("checker")),
					eq(sessionUser("role"), literal("visitor")),
				),
				caseListConfig: list("household-checks"),
				forms: [
					{
						uuid: key("check-household"),
						name: "Check household",
						type: "followup",
						postSubmit: "previous",
						displayCondition: eq(
							prop("household", "village"),
							literal("north"),
						),
						fields: [note("check-household")],
					},
					{
						uuid: key("review-household"),
						name: "Review household",
						type: "followup",
						fields: [note("review-household")],
					},
				],
			},
			{
				uuid: key("household-list"),
				name: "Household list",
				caseType: "household",
				caseListMenuItem: {},
				caseListConfig: list("household-list"),
				forms: [],
			},
			{
				uuid: key("household-extras"),
				name: "Household extras",
				caseType: "household",
				caseListConfig: list("household-extras"),
				forms: [
					{
						uuid: key("extra-household"),
						name: "Household extra",
						type: "followup",
						postSubmit: "parentMenu",
						fields: [note("extra-household")],
					},
				],
			},
			{
				uuid: key("members"),
				name: "Members",
				caseType: "member",
				caseListConfig: list("members"),
				forms: [
					{
						uuid: key("visit-member"),
						name: "Visit member",
						type: "followup",
						formLinks: [
							{
								uuid: key("visit-member-link"),
								target: {
									type: "form",
									moduleUuid: key("member-registration"),
									formUuid: key("register-member"),
								},
							},
						],
						fields: [note("visit-member")],
					},
				],
			},
			{
				uuid: key("member-registration"),
				name: "Member registration",
				caseType: "member",
				caseListConfig: list("member-registration"),
				forms: [
					{
						uuid: key("register-member"),
						name: "Register member",
						type: "registration",
						postSubmit: "previous",
						fields: [nameField("register-member", "member")],
					},
				],
			},
			{
				uuid: key("member-referrals"),
				name: "Member referrals",
				caseType: "referral",
				caseListConfig: list("member-referrals"),
				forms: [
					{
						uuid: key("follow-referral"),
						name: "Follow referral",
						type: "followup",
						fields: [note("follow-referral")],
					},
				],
			},
			{
				uuid: key("outreach"),
				name: "Outreach",
				forms: [surveyOf("outreach-survey", "Outreach survey")],
			},
			{
				uuid: key("outreach-tasks"),
				name: "Outreach tasks",
				forms: [surveyOf("outreach-task", "Outreach task")],
			},
			{
				uuid: key("outreach-extras"),
				name: "Outreach extras",
				forms: [surveyOf("outreach-extra", "Outreach extra")],
			},
		],
	});
	for (const [child, parent] of [
		["household-checks", "households"],
		["household-list", "households"],
		["household-extras", "households"],
		["member-registration", "members"],
		["member-referrals", "members"],
		["outreach-tasks", "outreach"],
		["outreach-extras", "outreach"],
	] as const)
		doc.modules[key(child)].parentModuleUuid = key(parent);
	for (const above of [
		"household-checks",
		"household-list",
		"member-registration",
		"member-referrals",
		"outreach",
		"outreach-extras",
	])
		doc.modules[key(above)].formsInMenuAbove = true;
	doc.modules[key("member-referrals")].parentCaseModuleUuid = key("members");
	return targetedDocument({
		id,
		rows: [
			"forms in the menu above: submenus that show their forms in a parent that keeps its screen, case first and forms first, with their conditions, the previous screen and links into them",
		],
		doc,
		expected: {
			intent: [
				answerHeld(
					"outreach-task-held",
					key("outreach-task"),
					"/data/question",
					"seen",
				),
			],
		},
	});
}
