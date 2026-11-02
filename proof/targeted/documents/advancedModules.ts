/**
 * Advanced modules and extension child cases: the documents that hold what
 * CommCare HQ receives as an advanced module, and the names HQ's build
 * appends beside a form's own questions.
 *
 * Nova never offers an advanced menu as a choice. A menu is emitted advanced
 * where a create one of its forms makes is carried by an after-submit link
 * into a form of the new case's type and a basic form would give that case
 * no session value (`lib/commcare/moduleKind.ts::emittedModuleKind`), or
 * where a publish recorded that HQ holds it as advanced (`Module.heldKind`).
 * So each document here is made advanced by its own content:
 *
 * - `targeted-advanced-module`: households, and patients chosen under their
 *   household. "Register patient" creates the patient (its own open action,
 *   created only when consent is `yes` and closed at once when the outcome is
 *   `moved`) and an `episode` extension case carried by its link into
 *   "Review episode", which makes the Patients menu advanced. "Visit patient"
 *   loads the household and the patient (a load indexed to the one before
 *   it), saves three answers to the patient, closes the household on its
 *   load when the household has moved, saves the visit's place to the
 *   worker's own record (the worker's load, chosen automatically), and in
 *   each row of `visits` creates a visit of the patient and a follow-up
 *   visit indexed to it (two indexed open actions in one repeat).
 *   "Discharge patient" closes the patient on its own load.
 * - `targeted-extension-carried`: "Enroll client" creates a client and a
 *   referral extending it, carried by its link into "Review referral", so
 *   the Enrollment menu is advanced and the referral is an open action whose
 *   session value the link matches. In the Clients menu, a basic menu of the
 *   same type, "Refer client" creates a referral no link carries, kept in a
 *   Save to Case block with a `uuid()` id.
 * - `targeted-advanced-child-module`: a basic Households menu choosing a
 *   household, with an advanced child menu of the same type, whose forms'
 *   loads HQ aligns to the root's selection (`add_parent_datums`). Its
 *   "Plan visit" creates a visit its link carries into "Review visit", which
 *   makes the child menu advanced, and a note of the household it loaded,
 *   whose index would name the load the alignment renames, so the note is
 *   kept in a Save to Case block.
 * - `targeted-advanced-held-kind`: a menu advanced by a carried create. Its
 *   first publish records the kind (the capture's record); the written edit
 *   removes the link, and the held kind keeps the menu advanced, so nothing
 *   the publish wrote moves.
 * - `targeted-root-case-block-names`: a question `subcase_0` at the root of a
 *   form that creates a child case at the root, and a question
 *   `commcare_usercase` at the root of a form that saves to the worker's
 *   record, beside the elements HQ's build appends for that basic subcase
 *   and for the worker's update. Each change takes its Case Management slot,
 *   so HQ's build, Core and Formplayer show what the collision does (part
 *   02's G3).
 *
 * Fixed values: each symptom is HQ's build, its editors' saves and Core's
 * case blocks, which no value check reads, so each document carries the
 * check of a question its symptom leaves alone (`./echo.ts`), on a form whose
 * session holds no case.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	type CaseOperationLink,
	type Expression,
	plainColumn,
	proseText,
	USERCASE_CASE_TYPE,
	type Uuid,
} from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

/** A condition written as form text, which `buildDoc` parses in its slot. */
function condition(text: string): Expression {
	return text as unknown as Expression;
}

/** A case type with a name and the text properties `names`. */
function caseType(
	name: string,
	names: readonly string[] = [],
	parent?: { readonly type: string; readonly relationship?: "extension" },
) {
	return {
		name,
		...(parent !== undefined && { parent_type: parent.type }),
		...(parent?.relationship !== undefined && {
			relationship: parent.relationship,
		}),
		properties: [
			{ name: "case_name", label: proseText("Name") },
			...names.map((property) => ({
				name: property,
				label: proseText(property),
				data_type: "text" as const,
			})),
		],
	};
}

/** The makers one document's identities and questions are named by. */
function namer(documentId: string) {
	const uuid = (name: string) => targetedUuid(documentId, name);
	return {
		uuid,
		read: (key: string) => term(formField(uuid(key))),
		text: (key: string, label: string) =>
			f({
				kind: "text",
				uuid: uuid(key),
				id: key.replaceAll("-", "_"),
				label: proseText(label),
			}),
		select: (key: string, label: string, values: readonly string[]) =>
			f({
				kind: "single_select",
				uuid: uuid(key),
				id: key.replaceAll("-", "_"),
				label: proseText(label),
				options: values.map((value) => ({
					uuid: uuid(`${key}-${value}`),
					value,
					label: proseText(value),
				})),
			}),
		nameColumn: (key: string) =>
			plainColumn(uuid(`${key}-name-column`), "case_name", "Name"),
	};
}

/** A link of a new case to another case, under `identifier`. */
function linkTo(
	identifier: string,
	targetType: string,
	target: CaseOperationLink["target"],
	relationship: CaseOperationLink["relationship"],
): CaseOperationLink[] {
	return [{ identifier, targetType, target, relationship }];
}

/** A worker property the forms save to. */
function workerProperty(
	doc: BlueprintDoc,
	uuid: Uuid,
	slug: string,
	label: string,
): void {
	doc.userProperties = { [uuid]: { uuid, slug, label } };
	doc.userPropertyOrder = [uuid];
}

const ADVANCED_MODULE = "targeted-advanced-module";

export function advancedModule() {
	const { uuid, read, text, select, nameColumn } = namer(ADVANCED_MODULE);
	const households = uuid("households");
	const patients = uuid("patients");
	const episodes = uuid("episodes");
	const addHousehold = uuid("add-household");
	const addPatient = uuid("add-patient");
	const register = uuid("register");
	const visit = uuid("visit");
	const review = uuid("review");
	const registerOwn = uuid("register-own");
	const firstVisit = uuid("add-visit");
	const workerPlace = uuid("worker-last-place");
	const addPatientOperations: CaseOperation[] = [
		{
			uuid: uuid("add-patient-own"),
			id: "household",
			action: "own",
		},
		{
			// A patient of the household chosen, so the Patients list
			// under it holds the cases the app makes.
			uuid: uuid("add-household-patient"),
			id: "patient",
			action: "create",
			caseType: "patient",
			target: { kind: "new" },
			name: read("household-patient-name"),
			links: linkTo("parent", "household", { kind: "session" }, "child"),
		},
	];
	const registerOperations: CaseOperation[] = [
		{
			uuid: registerOwn,
			id: "patient",
			action: "own",
			name: read("patient-name"),
			writes: [{ property: "village", value: read("village") }],
		},
		{
			// The episode extending the new patient, which the link carries
			// into "Review episode".
			uuid: uuid("open-episode"),
			id: "episode",
			action: "create",
			caseType: "episode",
			target: { kind: "new" },
			name: read("episode-name"),
			links: linkTo(
				"parent",
				"patient",
				{ kind: "op", opUuid: registerOwn },
				"extension",
			),
		},
	];
	const visitOperations: CaseOperation[] = [
		{
			uuid: uuid("visit-own"),
			id: "patient",
			action: "own",
			writes: [
				{ property: "weight", value: read("weight") },
				{ property: "note", value: read("note") },
				{ property: "village", value: read("visit-village") },
			],
		},
		{
			// The household chosen first, closed on its own load.
			uuid: uuid("close-household"),
			id: "close_household",
			action: "close",
			caseType: "household",
			target: {
				kind: "expression",
				expr: term({
					kind: "session-datum",
					datum: { kind: "selected-case", module: households },
				}),
			},
			condition: condition("#form/household_moved = 'yes'"),
		},
		{
			uuid: uuid("worker-record"),
			id: "commcare_user",
			action: "update",
			caseType: USERCASE_CASE_TYPE,
			target: { kind: "worker-record" },
			writes: [{ property: "last_place", value: read("place") }],
		},
		{
			// A visit of the patient in each row.
			uuid: firstVisit,
			id: "visit",
			action: "create",
			caseType: "visit",
			target: { kind: "new" },
			forEach: { repeat: uuid("visits") },
			name: read("visit-name"),
			links: linkTo("parent", "patient", { kind: "session" }, "child"),
		},
		{
			// The follow-up visit of the row's visit, indexed to it.
			uuid: uuid("add-follow-up"),
			id: "follow_up",
			action: "create",
			caseType: "visit",
			target: { kind: "new" },
			forEach: { repeat: uuid("visits") },
			name: read("follow-up-name"),
			links: linkTo(
				"previous_visit",
				"visit",
				{ kind: "op", opUuid: firstVisit },
				"child",
			),
		},
	];
	const doc = buildDoc(
		{
			appId: ADVANCED_MODULE,
			appName: "Household care",
			caseTypes: [
				caseType("household"),
				caseType("patient", ["village", "weight", "note"], {
					type: "household",
				}),
				caseType("episode", [], { type: "patient", relationship: "extension" }),
				caseType("visit", [], { type: "patient" }),
			],
			modules: [
				{
					uuid: households,
					name: "Households",
					caseType: "household",
					caseListConfig: caseListOf([nameColumn("households")]),
					forms: [
						{
							uuid: addHousehold,
							name: "Add household",
							type: "registration",
							fields: [text("household-name", "Household name")],
						},
						{
							uuid: addPatient,
							name: "Add patient",
							type: "followup",
							fields: [text("household-patient-name", "Patient name")],
						},
					],
				},
				{
					uuid: patients,
					name: "Patients",
					caseType: "patient",
					parentCaseModuleUuid: households,
					caseListConfig: caseListOf([nameColumn("patients")]),
					forms: [
						{
							uuid: register,
							name: "Register patient",
							type: "registration",
							openCondition: "#form/consent = 'yes'",
							closeCondition: "#form/outcome = 'moved'",
							formLinks: [
								{
									uuid: uuid("open-review"),
									target: {
										type: "form",
										moduleUuid: episodes,
										formUuid: review,
									},
								},
							],
							fields: [
								select("consent", "Consent given?", ["yes", "no"]),
								text("patient-name", "Patient name"),
								text("village", "Village"),
								text("episode-name", "Episode name"),
								select("outcome", "Outcome", ["staying", "moved"]),
							],
						},
						{
							uuid: visit,
							name: "Visit patient",
							type: "followup",
							fields: [
								text("weight", "Weight"),
								text("note", "Note"),
								text("visit-village", "Village"),
								select("household-moved", "Has the household moved?", [
									"yes",
									"no",
								]),
								text("place", "Where was the visit?"),
								f({
									kind: "repeat",
									uuid: uuid("visits"),
									id: "visits",
									label: proseText("Visits"),
									children: [
										text("visit-name", "Visit"),
										text("follow-up-name", "Follow-up visit"),
									],
								}),
							],
						},
						{
							uuid: uuid("discharge"),
							name: "Discharge patient",
							type: "close",
							closeCondition: "#form/reason = 'recovered'",
							fields: [select("reason", "Reason", ["recovered", "referred"])],
						},
					],
				},
				{
					uuid: episodes,
					name: "Episodes",
					caseType: "episode",
					caseListConfig: caseListOf([nameColumn("episodes")]),
					forms: [
						{
							uuid: review,
							name: "Review episode",
							type: "followup",
							fields: [text("review-note", "Note")],
						},
					],
				},
				{
					// The visits "Visit patient" creates are listed in a menu of their own.
					uuid: uuid("visits-list"),
					name: "Visits",
					caseType: "visit",
					caseListOnly: true,
					caseListConfig: caseListOf([nameColumn("visits-list")]),
					forms: [],
				},
			],
		},
		(built) => {
			built.forms[addHousehold].caseOperations = [
				{
					uuid: uuid("add-household-own"),
					id: "household",
					action: "own",
					name: read("household-name"),
				},
			];
			built.forms[addPatient].caseOperations = addPatientOperations;
			built.forms[register].caseOperations = registerOperations;
			built.forms[visit].caseOperations = visitOperations;
			workerProperty(built, workerPlace, "last_place", "Last visit place");
		},
	);
	return targetedDocument({
		id: ADVANCED_MODULE,
		rows: ["advanced modules", "24, extension child cases"],
		doc,
		expected: {
			intent: [
				answerHeld(
					"household-name-held",
					addHousehold,
					"/data/household_name",
					"Hill farm",
				),
			],
		},
	});
}

const EXTENSION_CARRIED = "targeted-extension-carried";

export function extensionCarried() {
	const { uuid, read, text, nameColumn } = namer(EXTENSION_CARRIED);
	const enroll = uuid("enroll");
	const refer = uuid("refer");
	const referrals = uuid("referrals");
	const review = uuid("review");
	const enrollOwn = uuid("enroll-own");
	const enrollOperations: CaseOperation[] = [
		{
			uuid: enrollOwn,
			id: "client",
			action: "own",
			name: read("client-name"),
		},
		{
			// Carried by the link into "Review referral".
			uuid: uuid("open-referral"),
			id: "referral",
			action: "create",
			caseType: "referral",
			target: { kind: "new" },
			name: read("referral-name"),
			links: linkTo(
				"parent",
				"client",
				{ kind: "op", opUuid: enrollOwn },
				"extension",
			),
		},
	];
	const referOperations: CaseOperation[] = [
		{ uuid: uuid("refer-own"), id: "client", action: "own" },
		{
			// No link carries it.
			uuid: uuid("add-referral"),
			id: "referral",
			action: "create",
			caseType: "referral",
			target: { kind: "new" },
			name: read("refer-name"),
			links: linkTo("parent", "client", { kind: "session" }, "extension"),
		},
	];
	const doc = buildDoc(
		{
			appId: EXTENSION_CARRIED,
			appName: "Client referrals",
			caseTypes: [
				caseType("client"),
				caseType("referral", [], { type: "client", relationship: "extension" }),
			],
			modules: [
				{
					uuid: uuid("enrollment"),
					name: "Enrollment",
					caseType: "client",
					caseListConfig: caseListOf([nameColumn("enrollment")]),
					forms: [
						{
							uuid: enroll,
							name: "Enroll client",
							type: "registration",
							formLinks: [
								{
									uuid: uuid("open-review"),
									target: {
										type: "form",
										moduleUuid: referrals,
										formUuid: review,
									},
								},
							],
							fields: [
								text("client-name", "Client name"),
								text("referral-name", "Referral"),
							],
						},
					],
				},
				{
					// A basic menu of the same type: its create is carried by no link.
					uuid: uuid("clients"),
					name: "Clients",
					caseType: "client",
					caseListConfig: caseListOf([nameColumn("clients")]),
					forms: [
						{
							uuid: refer,
							name: "Refer client",
							type: "followup",
							fields: [text("refer-name", "Referral")],
						},
					],
				},
				{
					uuid: referrals,
					name: "Referrals",
					caseType: "referral",
					caseListConfig: caseListOf([nameColumn("referrals")]),
					forms: [
						{
							uuid: review,
							name: "Review referral",
							type: "followup",
							fields: [text("review-note", "Note")],
						},
					],
				},
			],
		},
		(built) => {
			built.forms[enroll].caseOperations = enrollOperations;
			built.forms[refer].caseOperations = referOperations;
		},
	);
	return targetedDocument({
		id: EXTENSION_CARRIED,
		rows: ["advanced modules", "24, extension child cases"],
		doc,
		expected: {
			intent: [
				answerHeld("client-name-held", enroll, "/data/client_name", "Wanjiru"),
			],
		},
	});
}

const ADVANCED_CHILD_MODULE = "targeted-advanced-child-module";

export function advancedChildModule() {
	const { uuid, read, text, nameColumn } = namer(ADVANCED_CHILD_MODULE);
	const households = uuid("households");
	const visitsMenu = uuid("visits");
	const plans = uuid("plans");
	const addHousehold = uuid("add-household");
	const plan = uuid("plan");
	const review = uuid("review");
	const planOperations: CaseOperation[] = [
		{
			uuid: uuid("plan-own"),
			id: "household",
			action: "own",
			writes: [{ property: "plan", value: read("plan-note") }],
		},
		{
			// Carried by the link into "Review visit".
			uuid: uuid("open-visit"),
			id: "visit",
			action: "create",
			caseType: "visit",
			target: { kind: "new" },
			name: read("visit-name"),
		},
		{
			// Its index names the household's load, whose session value the
			// child menu's alignment renames to the root's.
			uuid: uuid("add-note"),
			id: "note",
			action: "create",
			caseType: "note",
			target: { kind: "new" },
			name: read("note-name"),
			links: linkTo("parent", "household", { kind: "session" }, "child"),
		},
	];
	const doc = buildDoc(
		{
			appId: ADVANCED_CHILD_MODULE,
			appName: "Household plans",
			caseTypes: [
				caseType("household", ["plan"]),
				caseType("visit"),
				caseType("note", [], { type: "household" }),
			],
			modules: [
				{
					uuid: households,
					name: "Households",
					caseType: "household",
					caseListConfig: caseListOf([nameColumn("households")]),
					forms: [
						{
							// HQ aligns a child menu's entries to the root's first form.
							uuid: uuid("check"),
							name: "Check household",
							type: "followup",
							fields: [text("check-note", "Note")],
						},
						{
							uuid: addHousehold,
							name: "Add household",
							type: "registration",
							fields: [text("household-name", "Household name")],
						},
					],
				},
				{
					uuid: plans,
					name: "Plans",
					caseType: "household",
					caseListConfig: caseListOf([nameColumn("plans")]),
					forms: [
						{
							uuid: plan,
							name: "Plan visit",
							type: "followup",
							formLinks: [
								{
									uuid: uuid("open-review"),
									target: {
										type: "form",
										moduleUuid: visitsMenu,
										formUuid: review,
									},
								},
							],
							fields: [
								text("plan-note", "Plan"),
								text("visit-name", "Visit"),
								text("note-name", "Note"),
							],
						},
					],
				},
				{
					uuid: visitsMenu,
					name: "Visits",
					caseType: "visit",
					caseListConfig: caseListOf([nameColumn("visits")]),
					forms: [
						{
							uuid: review,
							name: "Review visit",
							type: "followup",
							fields: [text("review-note", "Note")],
						},
					],
				},
				{
					uuid: uuid("notes"),
					name: "Notes",
					caseType: "note",
					caseListOnly: true,
					caseListConfig: caseListOf([nameColumn("notes")]),
					forms: [],
				},
			],
		},
		(built) => {
			built.forms[addHousehold].caseOperations = [
				{
					uuid: uuid("add-household-own"),
					id: "household",
					action: "own",
					name: read("household-name"),
				},
			];
			built.forms[plan].caseOperations = planOperations;
			// A menu inside Households.
			built.modules[plans] = {
				...built.modules[plans],
				parentModuleUuid: households,
			};
		},
	);
	return targetedDocument({
		id: ADVANCED_CHILD_MODULE,
		rows: ["advanced modules"],
		doc,
		expected: {
			intent: [
				answerHeld(
					"household-name-held",
					addHousehold,
					"/data/household_name",
					"Hill farm",
				),
			],
		},
	});
}

const ADVANCED_HELD_KIND = "targeted-advanced-held-kind";

/** The app before the edit (`linked: true`) and after it, as its source writes it. */
function heldKindApp(linked: boolean): BlueprintDoc {
	const { uuid, read, text, nameColumn } = namer(ADVANCED_HELD_KIND);
	const enroll = uuid("enroll");
	const episodes = uuid("episodes");
	const review = uuid("review");
	const enrollOwn = uuid("enroll-own");
	const enrollOperations: CaseOperation[] = [
		{
			uuid: enrollOwn,
			id: "patient",
			action: "own",
			name: read("patient-name"),
		},
		{
			uuid: uuid("open-episode"),
			id: "episode",
			action: "create",
			caseType: "episode",
			target: { kind: "new" },
			name: read("episode-name"),
			links: linkTo(
				"parent",
				"patient",
				{ kind: "op", opUuid: enrollOwn },
				"extension",
			),
		},
	];
	return buildDoc(
		{
			appId: ADVANCED_HELD_KIND,
			appName: "Episodes",
			caseTypes: [
				caseType("patient"),
				caseType("episode", [], { type: "patient", relationship: "extension" }),
			],
			modules: [
				{
					uuid: uuid("patients"),
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListOf([nameColumn("patients")]),
					forms: [
						{
							uuid: enroll,
							name: "Enroll patient",
							type: "registration",
							...(linked && {
								formLinks: [
									{
										uuid: uuid("open-review"),
										target: {
											type: "form" as const,
											moduleUuid: episodes,
											formUuid: review,
										},
									},
								],
							}),
							fields: [
								text("patient-name", "Patient name"),
								text("episode-name", "Episode name"),
							],
						},
					],
				},
				{
					uuid: episodes,
					name: "Episodes",
					caseType: "episode",
					caseListConfig: caseListOf([nameColumn("episodes")]),
					forms: [
						{
							uuid: review,
							name: "Review episode",
							type: "followup",
							fields: [text("review-note", "Note")],
						},
					],
				},
			],
		},
		(built) => {
			built.forms[enroll].caseOperations = enrollOperations;
		},
	);
}

export function advancedHeldKind() {
	const enroll = targetedUuid(ADVANCED_HELD_KIND, "enroll");
	return targetedDocument({
		id: ADVANCED_HELD_KIND,
		rows: ["advanced modules: a held kind"],
		doc: heldKindApp(true),
		edit: heldKindApp(false),
		expected: {
			intent: [
				answerHeld("patient-name-held", enroll, "/data/patient_name", "Amina"),
			],
		},
	});
}

const ROOT_CASE_BLOCK_NAMES = "targeted-root-case-block-names";

export function rootCaseBlockNames() {
	const { uuid, read, text, nameColumn } = namer(ROOT_CASE_BLOCK_NAMES);
	const register = uuid("register");
	const check = uuid("check");
	const registerOwn = uuid("register-own");
	const workerPlace = uuid("worker-last-place");
	const registerOperations: CaseOperation[] = [
		{
			uuid: registerOwn,
			id: "household",
			action: "own",
			name: read("household-name"),
		},
		{
			// A child at the root, which HQ's build would write at `subcase_0`.
			uuid: uuid("add-member"),
			id: "member",
			action: "create",
			caseType: "member",
			target: { kind: "new" },
			name: read("member-name"),
			links: linkTo(
				"parent",
				"household",
				{ kind: "op", opUuid: registerOwn },
				"child",
			),
		},
	];
	const checkOperations: CaseOperation[] = [
		{ uuid: uuid("check-own"), id: "household", action: "own" },
		{
			// The worker's update, which HQ's build would write at
			// `commcare_usercase`.
			uuid: uuid("worker-record"),
			id: "commcare_user",
			action: "update",
			caseType: USERCASE_CASE_TYPE,
			target: { kind: "worker-record" },
			writes: [{ property: "last_place", value: read("place") }],
		},
	];
	const doc = buildDoc(
		{
			appId: ROOT_CASE_BLOCK_NAMES,
			appName: "Households",
			caseTypes: [
				caseType("household"),
				caseType("member", [], { type: "household" }),
			],
			modules: [
				{
					uuid: uuid("households"),
					name: "Households",
					caseType: "household",
					caseListConfig: caseListOf([nameColumn("households")]),
					forms: [
						{
							uuid: register,
							name: "Register household",
							type: "registration",
							fields: [
								text("household-name", "Household name"),
								text("member-name", "Member name"),
								// The name HQ's build gives the child's block.
								text("subcase-0", "Notes"),
							],
						},
						{
							uuid: check,
							name: "Check household",
							type: "followup",
							fields: [
								text("place", "Where was the visit?"),
								// The name HQ's build gives the worker's block.
								text("commcare-usercase", "Notes"),
							],
						},
					],
				},
				{
					uuid: uuid("members"),
					name: "Members",
					caseType: "member",
					caseListOnly: true,
					caseListConfig: caseListOf([nameColumn("members")]),
					forms: [],
				},
			],
		},
		(built) => {
			built.forms[register].caseOperations = registerOperations;
			built.forms[check].caseOperations = checkOperations;
			workerProperty(built, workerPlace, "last_place", "Last visit place");
		},
	);
	return targetedDocument({
		id: ROOT_CASE_BLOCK_NAMES,
		rows: ["names HQ's build appends at a form's root"],
		doc,
		expected: {
			intent: [answerHeld("notes-held", register, "/data/subcase_0", "seen")],
		},
	});
}
