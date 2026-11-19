/**
 * The base `hq-plain` written by hand: a Nova document meaning what
 * `proof/matrix/bases/plain.py` authors in CommCare HQ's own pages and form
 * builder, written from that builder and the reader's rules, never from a
 * reading. `proof/corpus/__tests__/hqAuthored.test.ts` holds Nova's reading
 * of the base equal to it by external key, so a reader that misreads a shape
 * this base holds, consistently, fails there.
 *
 * Every Nova identity is written here as a literal. The ids of HQ's side are
 * read from the retained `proof/hq-apps/hq-plain/app.json` by position, never
 * typed, so a pin that re-mints them needs no edit here: the menu's
 * `unique_id`, and each form's `unique_id` and `xmlns`.
 *
 * What it states because the builder authors it so:
 *
 * - every label and every choice is plain text (`plainLabel`): the forms'
 *   sources are `XFormBuilder`'s, which writes no formatted copy, and HQ's
 *   form builder writes one on a save only for a text it read one for or a
 *   person formatted (`javaRosa/plugin.js`, `item.hasMarkdown`);
 * - the follow-up form's `members` starts on the case's `members`, typed as
 *   the question's Default Value in the form builder (`#case/members`), and
 *   no case operation loads it: the basic Case Management page offers no
 *   load;
 * - it runs on Web Apps and Android, and neither list shows on the worker's
 *   home: the builder saves no setting, and HQ's build writes `no` for each
 *   absent show setting (`models/applications.py::Application.create_profile`,
 *   `commcare-profile-settings.yml`), which the reader reads as Nova's new
 *   app holds them (`lib/domain/blueprint.ts::NEW_APP_SETTINGS`);
 * - the case type's catalog is what the app's source says of it: HQ's app
 *   holds no property label, so each property's label is its name; the case's
 *   name is a standard property, declared nowhere; the properties stand in
 *   name order; and the one declared type is `village`'s, the kind of the one
 *   select question that writes it, since the writers of every other property
 *   give its type (the reader's catalog rules,
 *   `lib/commcare/reader/caseManagement/catalog.ts::noteProperty`);
 * - each form's own case change is kept where the Case Management page saves
 *   it, the form's basic actions (`open_case`, `update_case`), the placement
 *   `{ kind: "basic", slot: "own" }`; and the follow-up form's writes are
 *   its two questions' answers, and nothing gives `remark` a starting value;
 * - after the follow-up form the worker goes home: `new_module` saves
 *   `post_form_workflow: "default"` on each form, where Nova's own default
 *   for a follow-up form is the menu's previous screen
 *   (`lib/domain/forms.ts::defaultPostSubmit`).
 *
 * The case list shows the name and the village, sorted by the village
 * ascending with blanks first, as the Case List tab saves the rule; the case
 * detail shows the name, the village, the members and the visit date as a
 * date, in HQ's default date format (`models/case_list.py::DetailColumn.date_format`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { WireIdentityOverride } from "@/lib/commcare/wireIdentity";
import {
	type BlueprintDoc,
	type CaseOperationWrite,
	columnSort,
	dateColumn,
	plainColumn,
	proseText,
	type Uuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { WORKTREE } from "@/proof/corpus/emissionProcess";
import { caseListOf } from "@/proof/targeted/build";

/** The base's id: its directory under `proof/hq-apps/`. */
export const BASE = "hq-plain";

/** Each Nova identity the document holds, written out. */
export const UUIDS = {
	module: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a01",
	registration: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a02",
	followUp: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a03",
	headName: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a11",
	members: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a12",
	village: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a13",
	villageNorth: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a14",
	villageSouth: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a15",
	visitDate: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a16",
	notes: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a17",
	remark: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a18",
	membersPlusOne: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a19",
	visitLabel: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a21",
	followUpMembers: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a22",
	followUpRemark: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a23",
	listName: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a31",
	listVillage: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a32",
	detailMembers: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a33",
	detailVisitDate: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a34",
} as const satisfies Readonly<Record<string, string>>;

const uuid = (name: keyof typeof UUIDS) => UUIDS[name] as Uuid;

const CASE_TYPE = "household";

/** A plain text label, as `XFormBuilder` writes one and the form builder keeps it. */
const label = (text: string) => ({
	label: proseText(text),
	plainLabel: true as const,
});

/** The menu and form ids and `xmlns` HQ holds for the base, read from its retained app by position. */
function hqIdentity(root: string): WireIdentityOverride[] {
	const path = join(root, BASE, "app.json");
	let app: {
		readonly modules?: readonly {
			readonly unique_id?: string;
			readonly forms?: readonly {
				readonly unique_id?: string;
				readonly xmlns?: string;
			}[];
		}[];
	};
	try {
		app = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(
			`The hand-written document for ${BASE} reads CommCare HQ's ids from ${path}, and it could not be read (${error instanceof Error ? error.message : String(error)}). A lane run writes proof/hq-apps/${BASE}/; adopt it with python3 -m proof.matrix.adopt.`,
		);
	}
	const module = app.modules?.[0];
	const [registration, followUp] = module?.forms ?? [];
	if (
		module?.unique_id === undefined ||
		registration?.unique_id === undefined ||
		registration.xmlns === undefined ||
		followUp?.unique_id === undefined ||
		followUp.xmlns === undefined
	) {
		throw new Error(
			`${path} holds no menu with two forms, each with its unique_id and xmlns, where proof/matrix/bases/plain.py authors one.`,
		);
	}
	return [
		{
			entityKind: "module",
			novaEntityUuid: uuid("module"),
			uniqueId: module.unique_id,
			xmlns: null,
		},
		{
			entityKind: "form",
			novaEntityUuid: uuid("registration"),
			uniqueId: registration.unique_id,
			xmlns: registration.xmlns,
		},
		{
			entityKind: "form",
			novaEntityUuid: uuid("followUp"),
			uniqueId: followUp.unique_id,
			xmlns: followUp.xmlns,
		},
	];
}

/** The document `hq-plain` means, and the identity rows that tie it to HQ's app retained under `root`. */
export function document(root: string = join(WORKTREE, "proof", "hq-apps")): {
	readonly doc: BlueprintDoc;
	readonly identity: WireIdentityOverride[];
} {
	return { doc: handDocument(), identity: hqIdentity(root) };
}

/** The document `hq-plain` means, which reads nothing of HQ's. */
export function handDocument(): BlueprintDoc {
	const doc = buildDoc({
		appId: BASE,
		appName: "Household visits",
		appSettings: { showSavedForms: false, showIncompleteForms: false },
		caseTypes: [
			{
				name: CASE_TYPE,
				properties: [
					{ name: "members", label: proseText("members") },
					{ name: "remark", label: proseText("remark") },
					{
						name: "village",
						label: proseText("village"),
						data_type: "single_select",
					},
					{ name: "visit_date", label: proseText("visit_date") },
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Households",
				caseType: CASE_TYPE,
				caseListConfig: caseListOf([
					plainColumn(uuid("listName"), "case_name", "Name"),
					plainColumn(uuid("listVillage"), "village", "Village", {
						sort: columnSort("asc", 0, "first"),
					}),
					plainColumn(uuid("detailMembers"), "members", "Members", {
						visibleInList: false,
						notOnList: true,
					}),
					dateColumn(
						uuid("detailVisitDate"),
						"visit_date",
						"Visit date",
						"%d/%m/%y",
						{ visibleInList: false, notOnList: true },
					),
				]),
				forms: [
					{
						uuid: uuid("registration"),
						name: "Registration Form",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("headName"),
								id: "head_name",
								...label("Head of household"),
								caseWrite: { caseType: CASE_TYPE, property: "case_name" },
							}),
							f({
								kind: "int",
								uuid: uuid("members"),
								id: "members",
								...label("Members"),
								caseWrite: { caseType: CASE_TYPE, property: "members" },
							}),
							f({
								kind: "single_select",
								uuid: uuid("village"),
								id: "village",
								...label("Village"),
								options: [
									{
										uuid: uuid("villageNorth"),
										value: "north",
										label: "North",
										plainLabel: true,
									},
									{
										uuid: uuid("villageSouth"),
										value: "south",
										label: "South",
										plainLabel: true,
									},
								],
								caseWrite: { caseType: CASE_TYPE, property: "village" },
							}),
							f({
								kind: "date",
								uuid: uuid("visitDate"),
								id: "visit_date",
								...label("Visit date"),
								caseWrite: { caseType: CASE_TYPE, property: "visit_date" },
							}),
							f({
								kind: "group",
								uuid: uuid("notes"),
								id: "notes",
								...label("Notes"),
								children: [
									f({
										kind: "text",
										uuid: uuid("remark"),
										id: "remark",
										...label("Remark"),
									}),
								],
							}),
							f({
								kind: "hidden",
								uuid: uuid("membersPlusOne"),
								id: "members_plus_one",
								calculate: "#form/members + 1",
							}),
						],
					},
					{
						uuid: uuid("followUp"),
						name: "Followup Form",
						type: "followup",
						postSubmit: "app_home",
						fields: [
							f({
								kind: "label",
								uuid: uuid("visitLabel"),
								id: "visit_label",
								...label("Ask how the household is doing."),
							}),
							f({
								kind: "int",
								uuid: uuid("followUpMembers"),
								id: "members",
								...label("Members"),
								default_value: `#${CASE_TYPE}/members`,
							}),
							f({
								kind: "text",
								uuid: uuid("followUpRemark"),
								id: "remark",
								...label("Remark"),
								required: "#form/members > 5",
							}),
						],
					},
				],
			},
		],
	});
	return heldOwnChanges(doc);
}

/** An answer of the question `field`, as a write's value. */
const answerOf = (field: keyof typeof UUIDS): Expression => ({
	kind: "term",
	term: { kind: "field", uuid: uuid(field) },
});

/**
 * `doc` with each form's own case change kept where the Case Management page
 * saves it, and the follow-up form's two writes stated as the page saves
 * them: each question's answer, with no starting value read from the case.
 */
function heldOwnChanges(doc: BlueprintDoc): BlueprintDoc {
	const writes: Readonly<Record<string, CaseOperationWrite[]>> = {
		[uuid("followUp")]: [
			{ property: "members", value: answerOf("followUpMembers") },
			{ property: "remark", value: answerOf("followUpRemark") },
		],
	};
	const forms = Object.fromEntries(
		Object.entries(doc.forms).map(([formUuid, form]) => [
			formUuid,
			{
				...form,
				caseOperations: (form.caseOperations ?? []).map((operation) =>
					operation.action === "own"
						? {
								...operation,
								...(writes[formUuid] !== undefined && {
									writes: writes[formUuid],
								}),
								placement: { kind: "basic", slot: "own" } as const,
							}
						: operation,
				),
			},
		]),
	);
	return { ...doc, forms };
}
