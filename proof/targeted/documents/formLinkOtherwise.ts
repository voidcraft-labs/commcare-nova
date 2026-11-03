/**
 * Defect 26: where a form goes when none of its destinations that may not
 * run runs, a form that starts itself again, a cycle of links, and a link to
 * a submenu HQ offers (`targeted-form-link-otherwise`).
 *
 * HQ builds one frame per link and, last, the fallback frame, guarded by the
 * negation of every link's non-blank `xpath`
 * (`suite_xml/post_process/workflow.py::EndOfFormNavigationWorkflow._get_fallback_frame`),
 * so an otherwise runs exactly when no destination with a condition or a
 * carried case runs. HQ's form settings page offers a form every form of the
 * app, the form itself among them, and a submenu only from a submenu whose
 * parent has the same case type as the target's parent
 * (`views/forms.py::_get_linkable_forms_context`, `is_child_match`).
 *
 * "Households" (`household`) holds "Add household", whose one destination
 * starts it again every time. Its submenu "Checks" (`member`, a child of
 * `household`, chosen after its household as
 * `./csqlComposition.ts` nests one) holds "Add member", "Review member", four
 * follow-ups each with one destination to Review member as alice and a
 * built-in otherwise (the app's first menu, this menu, the parent menu, the
 * previous screen, each offered: neither menu selects several cases, neither
 * searches, both are on the menu), and "Check link", whose destination is
 * the same and whose otherwise is a link to Review member carrying the
 * household and the member the form opened on. "Loop" holds "Ping" and
 * "Pong", which link to each other, Ping as alice and Pong as bea. "Rounds"
 * (`household`) holds "Add round household" and its submenu "Round checks"
 * (`member`), with "Round review"; Review member's every-time destination is
 * menu Round checks, offered because Checks and Round checks both have a
 * parent of case type `household`.
 *
 * As alice each follow-up of Checks opens Review member, and as anyone else
 * its otherwise; Ping and Pong alternate as their conditions say; Add
 * household starts again, and a walk ends at the restarted form's
 * submission. `proof/views/test_form_link_targets.py` holds HQ's page's
 * targets for each form here to the ones Nova's validator admits
 * (`proof/views/fixtures/form-link-targets.json`).
 *
 * Fixed values: Ping's note holds the text the worker enters (`./echo.ts`).
 */

import { buildDoc, type FormSpec, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type FormOtherwise,
	NEW_APP_SETTINGS,
	type OtherwiseDestination,
	plainColumn,
	proseText,
	type Uuid,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-form-link-otherwise";
const uuid = (name: string) => targetedUuid(ID, name);

const HOUSEHOLD = "household";
const MEMBER = "member";
const HOUSEHOLDS = uuid("module-households");
const CHECKS = uuid("module-checks");
const ROUNDS = uuid("module-rounds");
const ROUND_CHECKS = uuid("module-round-checks");
const REVIEW_MEMBER = uuid("form-review-member");
const CHECK_LINK = uuid("form-check-link");
const PING = uuid("form-ping");

const ALICE = "#user/username = 'alice'";

/** The four built-in otherwise destinations, one follow-up each. */
const BUILT_IN: readonly (readonly [OtherwiseDestination, string])[] = [
	["firstMenu", "Check first menu"],
	["module", "Check this menu"],
	["parentMenu", "Check parent menu"],
	["previous", "Check previous screen"],
];

function note(key: string) {
	return f({
		kind: "text",
		uuid: uuid(`note-${key}`),
		id: "note",
		label: proseText("Note"),
	});
}

function nameField(key: string, caseType: string) {
	return f({
		kind: "text",
		uuid: uuid(`name-${key}`),
		id: "case_name",
		label: proseText("Name"),
		caseWrite: { caseType, property: "case_name" },
	});
}

const toReview = {
	type: "form" as const,
	moduleUuid: CHECKS,
	formUuid: REVIEW_MEMBER,
};

function checkForm(key: string, name: string) {
	return {
		uuid: uuid(`form-${key}`),
		name,
		type: "followup" as const,
		formLinks: [
			{
				uuid: uuid(`link-${key}-review`),
				condition: ALICE,
				target: toReview,
			},
		],
		fields: [note(key)],
	};
}

function caseModule(
	moduleUuid: Uuid,
	name: string,
	caseType: string,
	forms: FormSpec[],
	parent?: Uuid,
) {
	return {
		uuid: moduleUuid,
		name,
		caseType,
		...(parent !== undefined && { parentCaseModuleUuid: parent }),
		caseListConfig: caseListOf([
			plainColumn(uuid(`column-${name}`), "case_name", "Name"),
		]),
		forms,
	};
}

function otherwiseApp(): BlueprintDoc {
	const builtInKey = (destination: OtherwiseDestination) =>
		`check-${destination}`;
	return buildDoc(
		{
			appId: ID,
			appName: "Household checks",
			// Declared for Web Apps and Android, as a new app is.
			appSettings: { ...NEW_APP_SETTINGS },
			caseTypes: [
				{
					name: HOUSEHOLD,
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: MEMBER,
					parent_type: HOUSEHOLD,
					relationship: "child",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				caseModule(HOUSEHOLDS, "Households", HOUSEHOLD, [
					{
						uuid: uuid("form-add-household"),
						name: "Add household",
						type: "registration",
						formLinks: [
							{
								uuid: uuid("link-add-household-again"),
								target: { type: "this-form" },
							},
						],
						fields: [nameField("add-household", HOUSEHOLD)],
					},
				]),
				caseModule(
					CHECKS,
					"Checks",
					MEMBER,
					[
						{
							uuid: uuid("form-add-member"),
							name: "Add member",
							type: "registration",
							fields: [nameField("add-member", MEMBER)],
						},
						{
							uuid: REVIEW_MEMBER,
							name: "Review member",
							type: "followup",
							formLinks: [
								{
									uuid: uuid("link-review-round-checks"),
									target: { type: "module", moduleUuid: ROUND_CHECKS },
								},
							],
							fields: [note("review-member")],
						},
						...BUILT_IN.map(([destination, name]) =>
							checkForm(builtInKey(destination), name),
						),
						checkForm("check-link", "Check link"),
					],
					HOUSEHOLDS,
				),
				{
					uuid: uuid("module-loop"),
					name: "Loop",
					forms: [
						{
							uuid: PING,
							name: "Ping",
							type: "survey",
							formLinks: [
								{
									uuid: uuid("link-ping-pong"),
									condition: ALICE,
									target: {
										type: "form",
										moduleUuid: uuid("module-loop"),
										formUuid: uuid("form-pong"),
									},
								},
							],
							fields: [note("ping")],
						},
						{
							uuid: uuid("form-pong"),
							name: "Pong",
							type: "survey",
							formLinks: [
								{
									uuid: uuid("link-pong-ping"),
									condition: "#user/username = 'bea'",
									target: {
										type: "form",
										moduleUuid: uuid("module-loop"),
										formUuid: PING,
									},
								},
							],
							fields: [note("pong")],
						},
					],
				},
				caseModule(ROUNDS, "Rounds", HOUSEHOLD, [
					{
						uuid: uuid("form-add-round-household"),
						name: "Add round household",
						type: "registration",
						fields: [nameField("add-round-household", HOUSEHOLD)],
					},
				]),
				caseModule(
					ROUND_CHECKS,
					"Round checks",
					MEMBER,
					[
						{
							uuid: uuid("form-round-review"),
							name: "Round review",
							type: "followup",
							fields: [note("round-review")],
						},
					],
					ROUNDS,
				),
			],
		},
		(built) => {
			built.modules[CHECKS].parentModuleUuid = HOUSEHOLDS;
			built.modules[ROUND_CHECKS].parentModuleUuid = ROUNDS;
			for (const [destination] of BUILT_IN) {
				const formUuid = uuid(`form-${builtInKey(destination)}`);
				const form = built.forms[formUuid];
				if (form === undefined) throw new Error(`No ${destination} form.`);
				built.forms[formUuid] = {
					...form,
					otherwise: { kind: "destination", destination },
				};
			}
			const checkLink = built.forms[CHECK_LINK];
			if (checkLink === undefined) throw new Error("No Check link form.");
			// The household and the member Check link opened on, carried to the
			// form that reviews the member; `buildDoc` parses the text.
			const otherwise = {
				kind: "link",
				uuid: uuid("link-check-link-otherwise"),
				target: toReview,
				datums: [
					{
						name: { kind: "selected-case", module: HOUSEHOLDS },
						xpath: "#household/case_id",
					},
					{
						name: { kind: "selected-case", module: CHECKS },
						xpath: "#member/case_id",
					},
				],
			} as unknown as FormOtherwise;
			built.forms[CHECK_LINK] = { ...checkLink, otherwise };
		},
	);
}

export function formLinkOtherwise() {
	return targetedDocument({
		id: ID,
		rows: ["26"],
		doc: otherwiseApp(),
		expected: {
			intent: [answerHeld("note-held", PING, "/data/note", "pinged")],
		},
	});
}
