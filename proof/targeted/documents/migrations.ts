/**
 * The migration witnesses: one small app per migration that changes the
 * wire or an identity, each a targeted document whose A is the retained
 * export of the app as Nova published it before the migration
 * (`proof/migrations/<id>/`) and whose B is Nova's republish of the migrated
 * document over it. Each spec here is the app before the migration, in the
 * shapes `main` stored, until the pull request that lands the witness's
 * migration rewrites it to what the migration gives the app.
 *
 * - `targeted-migration-search-workflow` (defects 21 and 29): a list-first
 *   search with a visible input; a search-first module with a visible
 *   input; a search whose filter is effective with no input visible, which
 *   Nova derives as skip to results; a search-first module with a
 *   no-matches registration form; and a case-list-only module. Declared Web
 *   Apps, where search first runs.
 * - `targeted-migration-case-writes` (defect 22), migrated: a registration
 *   whose own case saves its name and village, with a child created at the
 *   root and one in a repeat; a follow-up whose own case saves a note, with
 *   an update of the worker's record and operations at the root, in a
 *   repeat, keyed by an answer and under a condition; Discharge, once a
 *   follow-up closing its own case through an operation under a static
 *   select's answer with no writes, now a close form whose close condition
 *   is that answer; a close form whose close condition is a static select's
 *   choice, and one whose close condition reads a question in a repeat; and
 *   a menu selecting several cases whose form saves to them. Every case
 *   change, and each own close kept in a Save to Case block, holds the
 *   placement its retained A carries, as the cutover writes it for a
 *   published app. Declared Web Apps, where the menu selecting several cases
 *   opens.
 * - `targeted-migration-attachment` (defect 23): a follow-up whose image
 *   and file questions each save a link to their file on the case. Its
 *   retained A was published from the image question's attachment-mode
 *   write, under `MM_CASE_PROPERTIES`.
 * - `targeted-migration-extension-children` (defect 24), migrated: a
 *   registration creating an extension case, held in the Save to Case block
 *   its published A keeps it in, and then a child case, which moves up to
 *   the first basic subcase now that no inert extension subcase stands
 *   before it; a second registration creating an extension case, with a
 *   form link carrying the new extension case into a follow-up of its own
 *   menu, so the case is an advanced open action and its menu is advanced;
 *   and a case-list-only menu of the child cases, which every created case
 *   type has.
 * - `targeted-migration-query-repeats` (defect 25): a query repeat over the
 *   case list at the root, holding model iteration as the cutover writes it
 *   for the published app; one in a user repeat whose query reads the row's
 *   answer; and one under a group whose relevance reads an answer. The last
 *   two hold nothing in the spec and take the count placement, which the
 *   republish over A records (the capture's record).
 * - `targeted-migration-form-links` (defect 26): a survey with two
 *   conditional links and an unconditional last one; a survey with a
 *   conditional link and a stored after-submit; and a follow-up in a root
 *   menu linking to its child menu, which HQ does not offer from it.
 * - `targeted-migration-groups-preloads` (defects 27 and 28), migrated: two
 *   labelled groups, `vitals`, which keeps showing its questions on one
 *   screen through `fieldList`, and `household`, which holds a user repeat
 *   and so stays a plain group whose questions show one per screen (Q4,
 *   `lib/doc/groupFieldLists.ts::planGroupFieldLists`); a writer of the
 *   form's own case whose authored default gave way to the read of its
 *   case's value, with the own case held where A keeps it; a later Hidden
 *   Value whose default reads it.
 * - `targeted-migration-repeat-counts` (defect 30): a repeat counted by a
 *   Hidden Value calculating 2, which its count now names directly, and one
 *   counted by a decimal expression, which the migration wraps in `int(…)`.
 *
 * The holds a spec writes are the cutover's, A's placements as the
 * migration records them (class C8, and the query repeat's model
 * iteration), so they stay written here whether or not a publish of the
 * migrated document would derive the same place. Every other placement a
 * witness's D holds is the capture's record: Nova's first publish of the
 * migrated document over the retained A records what its emission derives
 * and nothing holds yet (`proof/corpus/editBatches.ts::firstPublishRecord`),
 * and the corpus stores D with that record applied.
 *
 * Fixed values: each witness's symptom is HQ's read of its A and proof 1
 * between A and B, which no value check reads, so each carries the check of
 * a question its symptom leaves alone (`./echo.ts`); the repeat witnesses
 * hold the rows their counts and queries give.
 */

import { Immer } from "immer";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { planExplicitPreloads } from "@/lib/doc/explicitPreloads";
import {
	type FieldWriteFact,
	operationsFromFieldWrites,
} from "@/lib/doc/fieldWriteOperations";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type CaseOperation,
	type CasePlacement,
	NEW_APP_SETTINGS,
	type OwnClosePlacement,
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

/** Applies the cutover's planned batches without freezing the document. */
const MIGRATION = new Immer({ autoFreeze: false });

/**
 * `doc` with its field writes migrated as the cutover migrates a stored
 * app's: each case form's own case, its child creates and its update of the
 * worker's record made from what its questions saved (`writes`, by form, in
 * data-tree order; classes C1 to C3,
 * `lib/doc/fieldWriteOperations.ts::operationsFromFieldWrites`), and each
 * question in `preloaded` opening with its case's value (class C7,
 * `lib/doc/explicitPreloads.ts::planExplicitPreloads`). `buildDoc` gives every
 * case form an empty own case of its own; the cutover's, with the identity
 * the cutover derives, stands in its place.
 */
function migrateFieldWrites(
	doc: BlueprintDoc,
	writes: ReadonlyMap<Uuid, readonly FieldWriteFact[]>,
	preloaded: ReadonlyMap<Uuid, readonly Uuid[]>,
): BlueprintDoc {
	let migrated = MIGRATION.produce(doc, (draft) => {
		for (const form of Object.values(draft.forms)) {
			const operations = (form.caseOperations ?? []).filter(
				(operation) => operation.action !== "own",
			);
			if (operations.length > 0) form.caseOperations = operations;
			else delete form.caseOperations;
		}
	});
	for (const formUuids of Object.values(doc.formOrder)) {
		for (const formUuid of formUuids) {
			const planned = operationsFromFieldWrites(
				migrated,
				formUuid,
				writes.get(formUuid) ?? [],
			);
			migrated = MIGRATION.produce(migrated, (draft) => {
				applyMutations(draft, planned);
			});
			const preloads = planExplicitPreloads(
				migrated,
				formUuid,
				preloaded.get(formUuid) ?? [],
			);
			migrated = MIGRATION.produce(migrated, (draft) => {
				applyMutations(draft, preloads);
			});
		}
	}
	return migrated;
}

/** A Save to Case block at the form root, at `path`. */
function saveToCase(path: [string, ...string[]]): OwnClosePlacement {
	return { kind: "save-to-case", path };
}

/**
 * `doc` with each case operation `holds` picks holding its placement, as the
 * cutover writes the placements a published app's A carries (class C8). Each
 * pick must find exactly one operation of its form.
 */
function heldAt(
	doc: BlueprintDoc,
	holds: readonly (readonly [
		Uuid,
		(operation: CaseOperation) => boolean,
		CasePlacement,
	])[],
): BlueprintDoc {
	return MIGRATION.produce(doc, (draft) => {
		for (const [formUuid, pick, placement] of holds) {
			const picked = (draft.forms[formUuid]?.caseOperations ?? []).filter(
				(operation) => pick(operation),
			);
			const [one] = picked;
			if (one === undefined || picked.length !== 1)
				throw new Error(
					`The witness ${doc.appId} holds a placement for ${picked.length} case changes of form ${formUuid}; each hold names exactly one.`,
				);
			one.placement = placement;
		}
	});
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
	const register = uuid("register");
	const visit = uuid("visit");
	const discharge = uuid("discharge");
	const closeInRepeat = uuid("close-in-repeat");
	const batchUpdate = uuid("batch-update");
	const arrivals = uuid("arrivals");
	const arrivalName = uuid("arrival-name");
	const referralKey = uuid("referral-key");
	const referralName = uuid("referral-name");
	const flag = uuid("flag");
	const discharged = uuid("discharged");
	const workerVisits = uuid("worker-visits");
	const nameColumn = (key: string) =>
		plainColumn(uuid(`${key}-name-column`), "case_name", "Name");
	const text = (key: string, label: string) =>
		f({
			kind: "text",
			uuid: uuid(key),
			id: key.replaceAll("-", "_"),
			label: proseText(label),
		});
	const select = (key: string, label: string, values: readonly string[]) =>
		f({
			kind: "single_select",
			uuid: uuid(key),
			id: key.replaceAll("-", "_"),
			label: proseText(label),
			options: values.map((value) => ({ value, label: value })),
		});
	/** What the question `key` saved before the migration. */
	const wrote = (
		key: string,
		caseType: string,
		property: string,
	): FieldWriteFact => ({
		fieldUuid: uuid(key),
		caseType,
		property,
		capture: false,
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
	const built = buildDoc(
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
							uuid: register,
							name: "Register",
							type: "registration",
							fields: [
								text("household-name", "Household name"),
								text("village", "Village"),
								text("head-name", "Head of household"),
								f({
									kind: "repeat",
									uuid: uuid("members"),
									id: "members",
									label: proseText("Members"),
									children: [text("member-name", "Member name")],
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
								text("visit-note", "Visit note"),
								text("visits-done", "Visits so far"),
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
							// A follow-up whose only operation closed its own case
							// under an answer and wrote nothing: a close form whose
							// close condition is that operation's (class C9).
							uuid: discharge,
							name: "Discharge",
							type: "close",
							closeCondition: eq(formField(discharged), literal("yes")),
							fields: [select("discharged", "Discharged?", ["yes", "no"])],
						},
						{
							uuid: uuid("close"),
							name: "Close",
							type: "close",
							closeCondition: "#form/outcome = 'moved'",
							fields: [select("outcome", "Outcome", ["stayed", "moved"])],
						},
						{
							uuid: closeInRepeat,
							name: "Close in repeat",
							type: "close",
							closeCondition: "count(#form/rounds/departed[. = 'yes']) > 0",
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
							uuid: batchUpdate,
							name: "Batch update",
							type: "followup",
							fields: [text("batch-village", "Village")],
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
	const migrated = migrateFieldWrites(
		built,
		new Map([
			[
				register,
				[
					wrote("household-name", "household", "case_name"),
					wrote("village", "household", "village"),
					wrote("head-name", "head", "case_name"),
					wrote("member-name", "member", "case_name"),
				],
			],
			[
				visit,
				[
					wrote("visit-note", "household", "last_note"),
					wrote("visits-done", USERCASE_CASE_TYPE, "visits_done"),
				],
			],
			[batchUpdate, [wrote("batch-village", "household", "village")]],
		]),
		new Map([[visit, [uuid("visit-note")]]]),
	);
	// Every case change held where the published A keeps it (class C8),
	// read from A's forms (`proof/hq-reads/targeted-migration-case-writes/`).
	const own = (operation: CaseOperation) => operation.action === "own";
	const creates = (caseType: string) => (operation: CaseOperation) =>
		operation.action === "create" && operation.caseType === caseType;
	const named = (uuid: Uuid) => (operation: CaseOperation) =>
		operation.uuid === uuid;
	const doc = heldAt(migrated, [
		[register, own, { kind: "basic", slot: "own" }],
		[register, creates("head"), { kind: "basic", slot: "subcase", index: 0 }],
		[register, creates("member"), { kind: "basic", slot: "subcase-row" }],
		[visit, own, { kind: "basic", slot: "own" }],
		[
			visit,
			(operation) =>
				operation.action === "update" &&
				operation.target?.kind === "worker-record",
			{ kind: "basic", slot: "usercase" },
		],
		[
			visit,
			named(uuid("add-referral")),
			saveToCase([
				"nova_operations",
				"nova_keyed_add_referral",
				"add_referral",
			]),
		],
		[
			visit,
			named(uuid("mark-visited")),
			saveToCase(["nova_operations", "mark_visited"]),
		],
		[
			visit,
			named(uuid("flag-household")),
			saveToCase([
				"nova_operations",
				"nova_condition_flag_household",
				"flag_household",
			]),
		],
		[
			visit,
			named(uuid("add-arrival")),
			{
				kind: "save-to-case",
				repeat: arrivals,
				path: ["nova_operations", "add_arrival"],
			},
		],
		[discharge, own, { kind: "basic", slot: "own" }],
		[uuid("close"), own, { kind: "basic", slot: "own" }],
		[closeInRepeat, own, { kind: "basic", slot: "own" }],
		[
			batchUpdate,
			own,
			saveToCase([
				"nova_selected_cases",
				"item",
				"nova_operations",
				"nova_condition_update_selected_cases",
				"nova_update_selected_cases",
			]),
		],
	]);
	// The own close each keeps in a Save to Case block of its own: Discharge's
	// at the path its removed close operation had.
	doc.forms[discharge] = {
		...doc.forms[discharge],
		ownClosePlacement: saveToCase([
			"nova_operations",
			"nova_condition_discharge_household",
			"discharge_household",
		]),
	};
	doc.forms[closeInRepeat] = {
		...doc.forms[closeInRepeat],
		ownClosePlacement: saveToCase([
			"nova_operations",
			"nova_condition_close",
			"nova_close",
		]),
	};
	return witness({
		id,
		rows: ["22"],
		doc,
		expected: {
			intent: [
				// Visit writes the worker's record, so its session holds the
				// worker's case beside the household.
				answerHeld("note-held", visit, "/data/visit_note", "seen", "B", {
					command: "m1-f0",
					caseId: "targeted-household",
					data: { usercase_id: "targeted-worker" },
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
	const register = uuid("register");
	const enroll = uuid("enroll");
	const episodes = uuid("episodes");
	const review = uuid("review");
	const name = (key: string, label: string) =>
		f({
			kind: "text",
			uuid: uuid(key),
			id: key.replaceAll("-", "_"),
			label: proseText(label),
		});
	/** The case `key`'s answer named before the migration. */
	const named = (key: string, caseTypeName: string): FieldWriteFact => ({
		fieldUuid: uuid(key),
		caseType: caseTypeName,
		property: "case_name",
		capture: false,
	});
	const nameColumn = (key: string) =>
		plainColumn(uuid(`${key}-name-column`), "case_name", "Name");
	const built = buildDoc({
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
						uuid: register,
						name: "Register",
						type: "registration",
						fields: [
							name("patient-name", "Patient name"),
							name("episode-name", "Episode name"),
							name("contact-name", "Contact name"),
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
						uuid: enroll,
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
							name("enrolled-name", "Patient name"),
							name("enrolled-episode", "Episode name"),
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
	// Each case a question named, as an operation (classes C1 and C2): the
	// episode a create with an extension link to the form's own case, the
	// contact a create with a child link.
	const migrated = migrateFieldWrites(
		built,
		new Map([
			[
				register,
				[
					named("patient-name", "patient"),
					named("episode-name", "episode"),
					named("contact-name", "contact"),
				],
			],
			[
				enroll,
				[
					named("enrolled-name", "patient"),
					named("enrolled-episode", "episode"),
				],
			],
		]),
		new Map(),
	);
	const own = (operation: CaseOperation) => operation.action === "own";
	const creates = (caseType: string) => (operation: CaseOperation) =>
		operation.action === "create" && operation.caseType === caseType;
	// Register's episode, published in its Save to Case block and carried by
	// no link, is held at that block's path (M1), and its contact, which A
	// kept as `subcase_1` behind the inert extension subcase, at the index it
	// moves up to (M2). Enroll's episode is carried by its link, so it opens
	// as an advanced open action and its menu turns advanced (M1, M3): the
	// cutover holds nothing of that menu, and the next publish records it.
	// Every other case change is held where A keeps it (class C8).
	const doc = heldAt(migrated, [
		[register, own, { kind: "basic", slot: "own" }],
		[
			register,
			creates("episode"),
			saveToCase(["nova_subcases", "nova_subcase_0"]),
		],
		[
			register,
			creates("contact"),
			{ kind: "basic", slot: "subcase", index: 0 },
		],
		[review, own, { kind: "basic", slot: "own" }],
	]);
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
								// The hold the cutover writes for a published app
								// whose repeat ran as model iteration.
								placement: "model-iteration",
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
								fieldList: true,
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
	const weight = uuid("weight");
	const built = buildDoc({
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
								fieldList: true,
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
								uuid: weight,
								id: "weight",
								label: proseText("Weight"),
								default_value: "60",
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
	// The weight's authored default gives way to the read of the patient's
	// weight, which the form opened it with (class C7), and the form's own
	// case, which saves it, is held where A keeps it (class C8).
	const migrated = migrateFieldWrites(
		built,
		new Map([
			[
				check,
				[
					{
						fieldUuid: weight,
						caseType: "patient",
						property: "weight",
						capture: false,
					},
				],
			],
		]),
		new Map([[check, [weight]]]),
	);
	const doc = heldAt(migrated, [
		[
			check,
			(operation) => operation.action === "own",
			{ kind: "basic", slot: "own" },
		],
	]);
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
								repeat_count: "int(#form/weight div 2)",
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
