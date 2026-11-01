/**
 * The migration witnesses: one small app per migration that changes the
 * wire or an identity, each a targeted document whose A is the retained
 * export of the app as Nova published it before the migration
 * (`proof/migrations/<id>/`) and whose B is Nova's republish of the migrated
 * document over it. Each spec here is the app before the migration, in the
 * shapes `main` stores; the pull request that lands a witness's migration
 * rewrites its spec to what the migration gives the app.
 *
 * - `targeted-migration-search-workflow` (defects 21 and 29): a list-first
 *   search with a visible input; a search-first module with a visible
 *   input; a search whose filter is effective with no input visible, which
 *   Nova derives as skip to results; a search-first module with a
 *   no-matches registration form; and a case-list-only module. Declared Web
 *   Apps, where search first runs.
 * - `targeted-migration-case-writes` (defect 22): a registration writing its
 *   own case's name and village through field writes, a child at the root
 *   and a child in a repeat; a follow-up with field writes, a write of the
 *   worker's record and operations at the root, in a repeat, keyed by an
 *   answer and under a condition; a follow-up closing its own case through
 *   an operation under a static select's answer, with no writes; a close
 *   form whose close condition is a static select's choice, and one whose
 *   close condition reads a question in a repeat; and a menu selecting
 *   several cases whose form writes to them. Declared Web Apps, where the
 *   menu selecting several cases opens.
 * - `targeted-migration-attachment` (defect 23): a follow-up whose image
 *   question writes the case in attachment mode, so its project space holds
 *   `MM_CASE_PROPERTIES`, beside a file question writing as a link.
 * - `targeted-migration-extension-children` (defect 24): a registration
 *   writing an extension case and then a child case through field writes;
 *   a second registration writing an extension case, with a form link
 *   carrying the new extension case into a follow-up of its own menu; and
 *   a case-list-only menu of the child cases, which every created case type
 *   has.
 * - `targeted-migration-query-repeats` (defect 25): a query repeat over the
 *   case list at the root, one in a user repeat whose query reads the row's
 *   answer, and one under a group whose relevance reads an answer.
 * - `targeted-migration-form-links` (defect 26): a survey with two
 *   conditional links and an unconditional last one; a survey with a
 *   conditional link and a stored after-submit; and a follow-up in a root
 *   menu linking to its child menu, which HQ does not offer from it.
 * - `targeted-migration-groups-preloads` (defects 27 and 28): two labelled
 *   groups, one holding a user repeat; a writer of the form's own case with
 *   an authored default; a later Hidden Value whose default reads it.
 * - `targeted-migration-repeat-counts` (defect 30): a repeat counted by a
 *   Hidden Value calculating 2, and one counted by a decimal expression.
 *
 * Fixed values: each witness's symptom is HQ's read of its A and proof 1
 * between A and B, which no value check reads, so each carries the check of
 * a question its symptom leaves alone (`./echo.ts`); the repeat witnesses
 * hold the rows their counts and queries give.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	type CaseWrite,
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
	simpleSearchInputDef,
	USERCASE_CASE_TYPE,
	type Uuid,
} from "@/lib/domain";
import { eq, formField, literal, prop, term } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";
import { answerHeld } from "./echo";

/** A text question the witness's expectation answers. */
function note(uuid: Uuid, id = "note") {
	return f({ kind: "text", uuid, id, label: proseText("Note") });
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

/** The witness `spec` describes, marked a migration witness. */
function witness(spec: Parameters<typeof targetedDocument>[0]) {
	return targetedDocument({ ...spec, migrationWitness: true });
}

export function migrationSearchWorkflow() {
	const id = "targeted-migration-search-workflow";
	const uuid = (name: string) => targetedUuid(id, name);
	const visit = uuid("visit");
	const nameColumn = (name: string) =>
		plainColumn(uuid(`${name}-name-column`), "case_name", "Name");
	const nameInput = (name: string) =>
		simpleSearchInputDef(
			uuid(`${name}-name-input`),
			`${name}_name`,
			"Name",
			"text",
			"case_name",
		);
	const doc = buildDoc({
		appId: id,
		appName: "Search workflows",
		// Search first runs in Web Apps alone.
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		caseTypes: [
			caseType("visit"),
			caseType("clinic"),
			caseType("site", ["standing"]),
			caseType("person"),
			caseType("report"),
		],
		modules: [
			{
				uuid: uuid("visits"),
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListOf([nameColumn("visit")], {
					searchInputs: [nameInput("visit")],
				}),
				forms: [
					{
						uuid: visit,
						name: "Visit",
						type: "followup",
						fields: [note(uuid("visit-note"))],
					},
				],
			},
			{
				uuid: uuid("clinics"),
				name: "Clinics",
				caseType: "clinic",
				caseSearchConfig: { searchFirst: true },
				caseListConfig: caseListOf([nameColumn("clinic")], {
					searchInputs: [nameInput("clinic")],
				}),
				forms: [
					{
						uuid: uuid("check-clinic"),
						name: "Check clinic",
						type: "followup",
						fields: [note(uuid("clinic-note"))],
					},
				],
			},
			{
				uuid: uuid("sites"),
				name: "Sites",
				caseType: "site",
				caseSearchConfig: {},
				caseListConfig: caseListOf([nameColumn("site")], {
					filter: eq(prop("site", "standing"), literal("active")),
				}),
				forms: [
					{
						uuid: uuid("inspect-site"),
						name: "Inspect site",
						type: "followup",
						fields: [note(uuid("site-note"))],
					},
				],
			},
			{
				uuid: uuid("registry"),
				name: "Registry",
				caseType: "person",
				caseSearchConfig: { searchFirst: true },
				caseListConfig: caseListOf([nameColumn("person")], {
					searchInputs: [nameInput("person")],
				}),
				forms: [
					{
						uuid: uuid("review-person"),
						name: "Review person",
						type: "followup",
						fields: [note(uuid("person-note"))],
					},
					{
						uuid: uuid("register-person"),
						name: "Register person",
						type: "registration",
						entry: { kind: "search-no-matches" },
						fields: [
							f({
								kind: "text",
								uuid: uuid("person-name"),
								id: "person_name",
								label: proseText("Name"),
								caseWrite: { caseType: "person", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				uuid: uuid("reports"),
				name: "Reports",
				caseType: "report",
				caseListOnly: true,
				caseListConfig: caseListOf([nameColumn("report")]),
				forms: [],
			},
		],
	});
	return witness({
		id,
		rows: ["21", "29"],
		doc,
		expected: {
			intent: [
				answerHeld("note-held", visit, "/data/note", "seen", "B", {
					command: "m0-f0",
					caseId: "targeted-visit",
				}),
			],
		},
	});
}

export function migrationCaseWrites() {
	const id = "targeted-migration-case-writes";
	const uuid = (name: string) => targetedUuid(id, name);
	const visit = uuid("visit");
	const discharge = uuid("discharge");
	const arrivals = uuid("arrivals");
	const arrivalName = uuid("arrival-name");
	const referralKey = uuid("referral-key");
	const referralName = uuid("referral-name");
	const flag = uuid("flag");
	const discharged = uuid("discharged");
	const workerVisits = uuid("worker-visits");
	const nameColumn = (key: string) =>
		plainColumn(uuid(`${key}-name-column`), "case_name", "Name");
	const text = (key: string, label: string, caseWrite?: CaseWrite) =>
		f({
			kind: "text",
			uuid: uuid(key),
			id: key.replaceAll("-", "_"),
			label: proseText(label),
			...(caseWrite !== undefined && { caseWrite }),
		});
	const select = (key: string, label: string, values: readonly string[]) =>
		f({
			kind: "single_select",
			uuid: uuid(key),
			id: key.replaceAll("-", "_"),
			label: proseText(label),
			options: values.map((value) => ({ value, label: value })),
		});
	const household = (property: string): CaseWrite => ({
		caseType: "household",
		property,
	});
	const session = { kind: "session" } as const;
	const toHousehold = [
		{
			identifier: "parent",
			targetType: "household",
			target: session,
			relationship: "child" as const,
		},
	];
	// A create keyed by an answer comes before every other effect, and the
	// operations in a repeat after those at the root, in the order CommCare
	// runs them.
	const visitOperations: CaseOperation[] = [
		{
			// An operation keyed by an answer.
			uuid: uuid("add-referral"),
			id: "add_referral",
			action: "create",
			caseType: "household",
			target: { kind: "new", idFrom: referralKey },
			name: term(formField(referralName)),
		},
		{
			// An operation at the root.
			uuid: uuid("mark-visited"),
			id: "mark_visited",
			action: "update",
			caseType: "household",
			target: session,
			writes: [{ property: "visited", value: term(literal("yes")) }],
		},
		{
			// A conditional operation.
			uuid: uuid("flag-household"),
			id: "flag_household",
			action: "update",
			caseType: "household",
			target: session,
			condition: eq(formField(flag), literal("yes")),
			writes: [{ property: "flagged", value: term(literal("yes")) }],
		},
		{
			// An operation in a repeat.
			uuid: uuid("add-arrival"),
			id: "add_arrival",
			action: "create",
			caseType: "member",
			target: { kind: "new" },
			forEach: { repeat: arrivals },
			name: term(formField(arrivalName)),
			links: toHousehold,
		},
	];
	const dischargeOperations: CaseOperation[] = [
		{
			// A close of the form's own case, under a static select's answer and with no writes.
			uuid: uuid("discharge-household"),
			id: "discharge_household",
			action: "close",
			caseType: "household",
			target: session,
			condition: eq(formField(discharged), literal("yes")),
		},
	];
	const doc = buildDoc(
		{
			appId: id,
			appName: "Household visits",
			// The several-case menu runs in Web Apps alone.
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
			caseTypes: [
				caseType("household", ["village", "last_note", "visited", "flagged"]),
				caseType("member", [], { type: "household" }),
				caseType("head", [], { type: "household" }),
			],
			modules: [
				{
					uuid: uuid("households"),
					name: "Households",
					caseType: "household",
					caseListConfig: caseListOf([nameColumn("households")]),
					forms: [
						{
							uuid: uuid("register"),
							name: "Register",
							type: "registration",
							fields: [
								text(
									"household-name",
									"Household name",
									household("case_name"),
								),
								text("village", "Village", household("village")),
								text("head-name", "Head of household", {
									caseType: "head",
									property: "case_name",
								}),
								f({
									kind: "repeat",
									uuid: uuid("members"),
									id: "members",
									label: proseText("Members"),
									children: [
										text("member-name", "Member name", {
											caseType: "member",
											property: "case_name",
										}),
									],
								}),
							],
						},
					],
				},
				{
					uuid: uuid("visits"),
					name: "Visits",
					caseType: "household",
					caseListConfig: caseListOf([nameColumn("visits")]),
					forms: [
						{
							uuid: visit,
							name: "Visit",
							type: "followup",
							fields: [
								text("visit-note", "Visit note", household("last_note")),
								text("visits-done", "Visits so far", {
									caseType: USERCASE_CASE_TYPE,
									property: "visits_done",
								}),
								f({
									kind: "repeat",
									uuid: arrivals,
									id: "arrivals",
									label: proseText("Arrivals"),
									children: [text("arrival-name", "Arrival name")],
								}),
								text("referral-key", "Referred household number"),
								text("referral-name", "Referred household"),
								select("flag", "Flag the household?", ["yes", "no"]),
							],
						},
						{
							uuid: discharge,
							name: "Discharge",
							type: "followup",
							fields: [select("discharged", "Discharged?", ["yes", "no"])],
						},
						{
							uuid: uuid("close"),
							name: "Close",
							type: "close",
							closeCondition: { field: "outcome", answer: "moved" },
							fields: [select("outcome", "Outcome", ["stayed", "moved"])],
						},
						{
							uuid: uuid("close-in-repeat"),
							name: "Close in repeat",
							type: "close",
							closeCondition: { field: "departed", answer: "yes" },
							fields: [
								f({
									kind: "repeat",
									uuid: uuid("rounds"),
									id: "rounds",
									label: proseText("Rounds"),
									children: [select("departed", "Departed?", ["yes", "no"])],
								}),
							],
						},
					],
				},
				{
					uuid: uuid("batch"),
					name: "Batch",
					caseType: "household",
					caseListConfig: caseListOf([nameColumn("batch")], {
						selection: { kind: "multiple", maximum: 5 },
					}),
					forms: [
						{
							uuid: uuid("batch-update"),
							name: "Batch update",
							type: "followup",
							fields: [text("batch-village", "Village", household("village"))],
						},
					],
				},
				{
					// The members and heads Register creates are listed in menus of their own.
					uuid: uuid("members-list"),
					name: "Members",
					caseType: "member",
					caseListOnly: true,
					caseListConfig: caseListOf([nameColumn("members-list")]),
					forms: [],
				},
				{
					uuid: uuid("heads-list"),
					name: "Heads",
					caseType: "head",
					caseListOnly: true,
					caseListConfig: caseListOf([nameColumn("heads-list")]),
					forms: [],
				},
			],
		},
		(built) => {
			built.forms[visit].caseOperations = visitOperations;
			built.forms[discharge].caseOperations = dischargeOperations;
			built.userProperties = {
				[workerVisits]: {
					uuid: workerVisits,
					slug: "visits_done",
					label: "Visits so far",
				},
			};
			built.userPropertyOrder = [workerVisits];
		},
	);
	return witness({
		id,
		rows: ["22"],
		doc,
		expected: {
			intent: [
				answerHeld("note-held", visit, "/data/visit_note", "seen", "B", {
					command: "m1-f0",
					caseId: "targeted-household",
				}),
			],
		},
	});
}

export function migrationAttachment() {
	const id = "targeted-migration-attachment";
	const uuid = (name: string) => targetedUuid(id, name);
	const photo = uuid("photo-form");
	const doc = buildDoc({
		appId: id,
		appName: "Patient photos",
		// Declared for Web Apps and Android, as a new app is.
		appSettings: { ...NEW_APP_SETTINGS },
		caseTypes: [caseType("patient", ["photo", "scan"])],
		modules: [
			{
				uuid: uuid("patients"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListOf([
					plainColumn(uuid("name-column"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: photo,
						name: "Photo",
						type: "followup",
						fields: [
							f({
								kind: "image",
								uuid: uuid("photo"),
								id: "photo",
								label: proseText("Photo"),
								caseWrite: {
									caseType: "patient",
									property: "photo",
									mode: "attachment",
								},
							}),
							f({
								kind: "file",
								uuid: uuid("scan"),
								id: "scan",
								label: proseText("Scan"),
								caseWrite: {
									caseType: "patient",
									property: "scan",
									mode: "url",
								},
							}),
							note(uuid("note")),
						],
					},
				],
			},
		],
	});
	return witness({
		id,
		rows: ["23"],
		doc,
		expected: {
			intent: [
				answerHeld("note-held", photo, "/data/note", "seen", "local", {
					command: "m0-f0",
					caseId: "targeted-patient",
				}),
			],
		},
	});
}

export function migrationExtensionChildren() {
	const id = "targeted-migration-extension-children";
	const uuid = (name: string) => targetedUuid(id, name);
	const episodes = uuid("episodes");
	const review = uuid("review");
	const name = (key: string, caseTypeName: string, label: string) =>
		f({
			kind: "text",
			uuid: uuid(key),
			id: key.replaceAll("-", "_"),
			label: proseText(label),
			caseWrite: { caseType: caseTypeName, property: "case_name" },
		});
	const nameColumn = (key: string) =>
		plainColumn(uuid(`${key}-name-column`), "case_name", "Name");
	const doc = buildDoc({
		appId: id,
		appName: "Episodes and contacts",
		// Declared for Web Apps and Android, as a new app is.
		appSettings: { ...NEW_APP_SETTINGS },
		caseTypes: [
			caseType("patient"),
			caseType("episode", [], { type: "patient", relationship: "extension" }),
			caseType("contact", [], { type: "patient" }),
		],
		modules: [
			{
				uuid: uuid("patients"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListOf([nameColumn("patients")]),
				forms: [
					{
						uuid: uuid("register"),
						name: "Register",
						type: "registration",
						fields: [
							name("patient-name", "patient", "Patient name"),
							name("episode-name", "episode", "Episode name"),
							name("contact-name", "contact", "Contact name"),
						],
					},
				],
			},
			{
				uuid: uuid("enrollment"),
				name: "Enrollment",
				caseType: "patient",
				caseListConfig: caseListOf([nameColumn("enrollment")]),
				forms: [
					{
						uuid: uuid("enroll"),
						name: "Enroll",
						type: "registration",
						formLinks: [
							{
								uuid: uuid("open-episode"),
								target: {
									type: "form",
									moduleUuid: episodes,
									formUuid: review,
								},
								datums: [
									{
										name: { kind: "selected-case", module: episodes },
										xpath: term({
											kind: "session-datum",
											datum: { kind: "new-child-case", caseType: "episode" },
										}),
									},
								],
							},
						],
						fields: [
							name("enrolled-name", "patient", "Patient name"),
							name("enrolled-episode", "episode", "Episode name"),
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
						name: "Review",
						type: "followup",
						fields: [note(uuid("note"))],
					},
				],
			},
			{
				// The contacts Register creates are listed in a menu of their own.
				uuid: uuid("contacts"),
				name: "Contacts",
				caseType: "contact",
				caseListOnly: true,
				caseListConfig: caseListOf([nameColumn("contacts")]),
				forms: [],
			},
		],
	});
	return witness({
		id,
		rows: ["24"],
		doc,
		expected: {
			intent: [
				answerHeld("note-held", review, "/data/note", "seen", "local", {
					command: "m2-f0",
					caseId: "targeted-episode",
				}),
			],
		},
	});
}

export function migrationQueryRepeats() {
	const id = "targeted-migration-query-repeats";
	const uuid = (name: string) => targetedUuid(id, name);
	const census = uuid("census");
	const doc = buildDoc({
		appId: id,
		appName: "Census",
		// Declared for Web Apps and Android, as a new app is.
		appSettings: { ...NEW_APP_SETTINGS },
		modules: [
			{
				uuid: uuid("module"),
				name: "Census",
				forms: [
					{
						uuid: census,
						name: "Census",
						type: "survey",
						fields: [
							f({
								kind: "repeat",
								uuid: uuid("visits"),
								id: "visits",
								label: proseText("Visits"),
								repeat_mode: "query_bound",
								data_source: {
									ids_query: "instance('casedb')/casedb/case/@case_id",
								},
								children: [
									f({
										kind: "text",
										uuid: uuid("visit-note"),
										id: "visit_note",
										label: proseText("Visit note"),
									}),
								],
							}),
							f({
								kind: "repeat",
								uuid: uuid("households"),
								id: "households",
								label: proseText("Households"),
								children: [
									f({
										kind: "text",
										uuid: uuid("member-ids"),
										id: "member_ids",
										label: proseText("Member ids"),
									}),
									f({
										kind: "repeat",
										uuid: uuid("members"),
										id: "members",
										label: proseText("Members"),
										repeat_mode: "query_bound",
										data_source: {
											ids_query: "#form/households/member_ids",
										},
										children: [
											f({
												kind: "text",
												uuid: uuid("member-note"),
												id: "member_note",
												label: proseText("Member note"),
											}),
										],
									}),
								],
							}),
							f({
								kind: "single_select",
								uuid: uuid("ready"),
								id: "ready",
								label: proseText("Ready for later checks?"),
								options: [
									{ value: "yes", label: "Yes" },
									{ value: "no", label: "No" },
								],
							}),
							f({
								kind: "group",
								uuid: uuid("checks"),
								id: "checks",
								label: proseText("Later checks"),
								relevant: "#form/ready = 'yes'",
								children: [
									f({
										kind: "repeat",
										uuid: uuid("later"),
										id: "later",
										label: proseText("Later"),
										repeat_mode: "query_bound",
										data_source: { ids_query: "'a b'" },
										children: [
											f({
												kind: "text",
												uuid: uuid("later-note"),
												id: "later_note",
												label: proseText("Later note"),
											}),
										],
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	const expectation = (exportName: "local" | "B"): Expectation => ({
		id: `later-rows-${exportName === "local" ? "local" : "b"}`,
		export: exportName,
		form: census,
		request: {
			// A select is answered by its option's position (Yes is the first).
			answers: [{ path: "/data/ready", value: "1" }],
			expressions: ["count(/data/checks/later/item)"],
		},
		expect: [
			{ pointer: "/answers/0/result", value: "ok" },
			{ pointer: "/values/0/value", value: "2" },
		],
	});
	return witness({
		id,
		rows: ["25"],
		doc,
		expected: { intent: [expectation("local"), expectation("B")] },
	});
}

export function migrationFormLinks() {
	const id = "targeted-migration-form-links";
	const uuid = (name: string) => targetedUuid(id, name);
	const desk = uuid("desk");
	const triage = uuid("triage");
	const patients = uuid("patients");
	const patientVisits = uuid("patient-visits");
	const visits = uuid("visits");
	const alice = "#user/username = 'alice'";
	const bob = "#user/username = 'bob'";
	const nameColumn = (key: string) =>
		plainColumn(uuid(`${key}-name-column`), "case_name", "Name");
	const doc: BlueprintDoc = buildDoc(
		{
			appId: id,
			appName: "Referrals",
			caseTypes: [
				caseType("patient"),
				caseType("visit", [], { type: "patient" }),
			],
			modules: [
				{
					uuid: desk,
					name: "Front desk",
					forms: [
						{
							uuid: uuid("intake"),
							name: "Intake",
							type: "survey",
							formLinks: [
								{
									uuid: uuid("intake-alice"),
									condition: alice,
									target: { type: "form", moduleUuid: desk, formUuid: triage },
								},
								{
									uuid: uuid("intake-bob"),
									condition: bob,
									target: { type: "module", moduleUuid: patients },
								},
								{
									uuid: uuid("intake-else"),
									target: { type: "module", moduleUuid: visits },
								},
							],
							fields: [note(uuid("intake-note"))],
						},
						{
							uuid: triage,
							name: "Triage",
							type: "survey",
							postSubmit: "module",
							formLinks: [
								{
									uuid: uuid("triage-alice"),
									condition: alice,
									target: { type: "module", moduleUuid: patients },
								},
							],
							fields: [note(uuid("triage-note"))],
						},
					],
				},
				{
					uuid: patients,
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListOf([nameColumn("patients")]),
					forms: [
						{
							uuid: uuid("refer"),
							name: "Refer",
							type: "followup",
							formLinks: [
								{
									uuid: uuid("refer-visits"),
									target: { type: "module", moduleUuid: patientVisits },
								},
							],
							fields: [note(uuid("refer-note"))],
						},
					],
				},
				{
					uuid: patientVisits,
					name: "Patient visits",
					caseType: "visit",
					caseListConfig: caseListOf([nameColumn("patient-visits")]),
					forms: [
						{
							uuid: uuid("record-visit"),
							name: "Record visit",
							type: "followup",
							fields: [note(uuid("record-note"))],
						},
					],
				},
				{
					uuid: visits,
					name: "Visits",
					caseType: "visit",
					caseListConfig: caseListOf([nameColumn("visits")]),
					forms: [
						{
							uuid: uuid("review-visit"),
							name: "Review visit",
							type: "followup",
							fields: [note(uuid("review-note"))],
						},
					],
				},
			],
		},
		(built) => {
			built.modules[patientVisits].parentModuleUuid = patients;
			built.modules[patientVisits].parentCaseModuleUuid = patients;
		},
	);
	return witness({
		id,
		rows: ["26"],
		doc,
		expected: {
			intent: [
				answerHeld("note-held", uuid("intake"), "/data/note", "seen", "B"),
			],
		},
	});
}

export function migrationGroupsPreloads() {
	const id = "targeted-migration-groups-preloads";
	const uuid = (name: string) => targetedUuid(id, name);
	const check = uuid("check");
	const doc = buildDoc({
		appId: id,
		appName: "Household checks",
		// Declared for Web Apps and Android, as a new app is.
		appSettings: { ...NEW_APP_SETTINGS },
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{
						name: "weight",
						label: proseText("Weight"),
						data_type: "decimal",
					},
				],
			},
		],
		modules: [
			{
				uuid: uuid("patients"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListOf([
					plainColumn(uuid("name-column"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: check,
						name: "Check",
						type: "followup",
						fields: [
							f({
								kind: "group",
								uuid: uuid("vitals"),
								id: "vitals",
								label: proseText("Vitals"),
								children: [
									f({
										kind: "decimal",
										uuid: uuid("temperature"),
										id: "temperature",
										label: proseText("Temperature"),
									}),
								],
							}),
							f({
								kind: "group",
								uuid: uuid("household"),
								id: "household",
								label: proseText("Household"),
								children: [
									f({
										kind: "repeat",
										uuid: uuid("members"),
										id: "members",
										label: proseText("Members"),
										children: [
											f({
												kind: "text",
												uuid: uuid("member-name"),
												id: "member_name",
												label: proseText("Member name"),
											}),
										],
									}),
								],
							}),
							f({
								kind: "decimal",
								uuid: uuid("weight"),
								id: "weight",
								label: proseText("Weight"),
								default_value: "60",
								caseWrite: { caseType: "patient", property: "weight" },
							}),
							f({
								kind: "hidden",
								uuid: uuid("weight-seen"),
								id: "weight_seen",
								default_value: "#form/weight",
							}),
						],
					},
				],
			},
		],
	});
	return witness({
		id,
		rows: ["27", "28"],
		doc,
		expected: {
			intent: [
				answerHeld(
					"temperature-held",
					check,
					"/data/vitals/temperature",
					"37.5",
					"local",
					{ command: "m0-f0", caseId: "targeted-patient" },
				),
			],
		},
	});
}

export function migrationRepeatCounts() {
	const id = "targeted-migration-repeat-counts";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const row = (key: string, label: string) =>
		f({ kind: "text", uuid: uuid(key), id: key, label: proseText(label) });
	const doc = buildDoc({
		appId: id,
		appName: "Counted rows",
		// Declared for Web Apps and Android, as a new app is.
		appSettings: { ...NEW_APP_SETTINGS },
		modules: [
			{
				uuid: uuid("module"),
				name: "Rows",
				forms: [
					{
						uuid: form,
						name: "Counted rows",
						type: "survey",
						fields: [
							f({
								kind: "hidden",
								uuid: uuid("planned"),
								id: "planned",
								calculate: "2",
							}),
							f({
								kind: "repeat",
								uuid: uuid("visits"),
								id: "visits",
								label: proseText("Visits"),
								repeat_mode: "count_bound",
								repeat_count: "#form/planned",
								children: [row("visit", "Visit")],
							}),
							f({
								kind: "decimal",
								uuid: uuid("weight"),
								id: "weight",
								label: proseText("Weight"),
							}),
							f({
								kind: "repeat",
								uuid: uuid("portions"),
								id: "portions",
								label: proseText("Portions"),
								repeat_mode: "count_bound",
								repeat_count: "#form/weight div 2",
								children: [row("portion", "Portion")],
							}),
						],
					},
				],
			},
		],
	});
	const expectation = (exportName: "local" | "B"): Expectation => ({
		id: `counted-rows-${exportName === "local" ? "local" : "b"}`,
		export: exportName,
		form,
		request: {
			answers: [{ path: "/data/weight", value: "4" }],
			expressions: ["count(/data/visits)", "count(/data/portions)"],
		},
		expect: [
			{ pointer: "/answers/0/result", value: "ok" },
			{ pointer: "/values/0/value", value: "2" },
			{ pointer: "/values/1/value", value: "2" },
		],
	});
	return witness({
		id,
		rows: ["30"],
		doc,
		expected: { intent: [expectation("local"), expectation("B")] },
	});
}
