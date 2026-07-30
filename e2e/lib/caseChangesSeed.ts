/**
 * A form whose case changes already depend on one another, at the scale the
 * screen was designed against.
 *
 * The reorder refusal is the part of case-change authoring that most needs
 * a real browser: it is a keyboard interaction whose whole value is what a
 * person is TOLD when nothing moves. Seeding the dependency rather than
 * building it through five clicks keeps the journey short enough to be
 * deterministic — the spec drives one keypress and reads one sentence.
 *
 * `archive_referral` retypes the case `create_referral` makes and
 * `file_referral` acts on that same identity afterward. Moving the file ahead
 * of the create is therefore refused by the move planner, and the refusal has
 * a name to say. `note_visit` depends on nothing, so it proves the same
 * keyboard path still moves what it may.
 *
 * The four dependent changes sit at the HEAD of a twenty-change sequence, and
 * that length is the point rather than padding. Twenty on one form is the case
 * the screen was designed against, and the list and one change's detail are
 * mutually exclusive screens at every width — so at this length, finding a
 * change and getting back to it rests entirely on the handles' "Runs N of M",
 * the detail's position, and Previous / Next. Four changes exercise none of
 * that: every row fits on one screen and traversal never has to carry anyone.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type BlueprintDoc,
	type CaseOperation,
	calculatedColumn,
	type LookupColumnId,
	type LookupTableId,
	plainColumn,
} from "@/lib/domain";
import {
	ancestorPath,
	eq,
	formField,
	literal,
	prop,
	relationStep,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { buildUrl } from "@/lib/routing/location";

/**
 * The independent changes that carry the sequence to twenty. Each writes its
 * own property of the session case, so none of them depends on another and
 * none is a candidate for the refusal the journey drives — they are the
 * SEQUENCE, not the subject. Distinct properties (rather than fifteen writes
 * of one) keep every row's sentence distinct, which is what makes "did I get
 * back to the change I was on?" answerable at all.
 */
const ROUTINE_WRITES = [
	{ id: "record_weight", property: "weight", label: "Weight" },
	{ id: "record_height", property: "height", label: "Height" },
	{ id: "record_temperature", property: "temperature", label: "Temperature" },
	{ id: "record_pulse", property: "pulse", label: "Pulse" },
	{
		id: "record_blood_pressure",
		property: "blood_pressure",
		label: "Blood pressure",
	},
	{
		id: "record_respiratory_rate",
		property: "respiratory_rate",
		label: "Respiratory rate",
	},
	{
		id: "record_oxygen_saturation",
		property: "oxygen_saturation",
		label: "Oxygen saturation",
	},
	{ id: "record_symptoms", property: "symptom_summary", label: "Symptoms" },
	{ id: "record_triage", property: "triage_level", label: "Triage level" },
	{
		id: "record_medication",
		property: "medication_given",
		label: "Medication given",
	},
	{ id: "record_allergy", property: "allergy_note", label: "Allergy note" },
	{
		id: "record_counselling",
		property: "counselling_note",
		label: "Counselling note",
	},
	{
		id: "record_referral_reason",
		property: "referral_reason",
		label: "Referral reason",
	},
	{
		id: "record_next_visit",
		property: "next_visit_note",
		label: "Next visit note",
	},
	{
		id: "record_discharge",
		property: "discharge_note",
		label: "Discharge note",
	},
] as const;

/**
 * Minted from the position rather than hand-scrambled: fifteen hand-written
 * uuids in one file is fifteen chances to typo a duplicate, and a duplicate
 * surfaces as `CASE_OPERATION_DUPLICATE_UUID` rather than as itself.
 */
export const CASE_CHANGES_ROUTINE = ROUTINE_WRITES.map((write, index) => ({
	...write,
	uuid: asUuid(
		`7a51e001-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
	),
}));

/**
 * What the journey reads off every handle and the detail's position: the four
 * dependent changes, the fifteen routine ones, and the table-lookup change
 * the smoke seed always installs last.
 */
export const CASE_CHANGES_SEQUENCE_LENGTH = CASE_CHANGES_ROUTINE.length + 5;

export const CASE_CHANGES_SEED = {
	appName: "Smoke — Case changes",
	moduleName: "Patients",
	formName: "Visit",
	moduleUuid: asUuid("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"),
	formUuid: asUuid("1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e"),
	fieldUuid: asUuid("2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"),
	linkTargetFieldUuid: asUuid("3c4d5e6f-7a8b-4d9e-8f0a-1b2c3d4e5f6a"),
	identityProjection: {
		formUuid: asUuid("4c5d6e7f-8a9b-4e0f-901a-2b3c4d5e6f7a"),
		firstNameUuid: asUuid("5d6e7f8a-9b0c-4f1a-812b-3c4d5e6f7a8b"),
		noteUuid: asUuid("6e7f8a9b-0c1d-402b-923c-4d5e6f7a8b9c"),
		formName: "Identity-safe close",
	},
	caseType: "patient",
	archivedCaseType: "archived_referral",
	archivedModuleName: "Archived referrals",
	archivedModuleUuid: asUuid("8c9d0e1f-2a3b-424c-8e5f-6a7b8c9d0e1f"),
	columns: {
		patientName: asUuid("8d9e0f1a-2b3c-434d-8f6a-7b8c9d0e1f2a"),
		patientNote: asUuid("9e0f1a2b-3c4d-445e-806b-8c9d0e1f2a3b"),
		archivedName: asUuid("0f1a2b3c-4d5e-456f-817c-9d0e1f2a3b4c"),
		archivedSource: asUuid("1a2b3c4d-5e6f-467a-828d-0e1f2a3b4c5d"),
		archivedPatient: asUuid("2b3c4d5e-6f7a-478b-839e-1f2a3b4c5d6e"),
	},
	operations: {
		create: asUuid("3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a"),
		note: asUuid("4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b"),
		file: asUuid("5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c"),
		tableLookup: asUuid("6a7b8c9d-0e1f-402a-8c3d-4e5f6a7b8c9d"),
		retype: asUuid("7b8c9d0e-1f2a-413b-9d4e-5f6a7b8c9d0e"),
	},
	ids: {
		create: "create_referral",
		note: "note_visit",
		file: "file_referral",
		tableLookup: "lookup_patient",
		retype: "archive_referral",
	},
} as const;

export interface CaseChangesLookupCarrier {
	readonly tableId: LookupTableId;
	readonly columnId: LookupColumnId;
}

/** The blueprint installed into the case-changes fixture app. */
export function buildCaseChangesBlueprint(
	appId = "test-app",
	lookupCarrier?: CaseChangesLookupCarrier,
): BlueprintDoc {
	const doc = buildDoc({
		appId,
		appName: CASE_CHANGES_SEED.appName,
		caseTypes: [
			{
				name: "patient",
				properties: [
					{
						name: "last_note",
						label: proseText("Last note"),
						data_type: "text",
					},
					// A write names a declared property or the app is invalid
					// (CASE_OPERATION_UNKNOWN_PROPERTY), so the routine changes
					// bring their own.
					...CASE_CHANGES_ROUTINE.map((routine) => ({
						name: routine.property,
						label: routine.label,
						data_type: "text" as const,
					})),
				],
			},
			{
				name: "referral",
				properties: [],
			},
			{
				name: CASE_CHANGES_SEED.archivedCaseType,
				parent_type: "patient",
				properties: [
					{
						name: "source_note",
						label: proseText("Source note"),
						data_type: "text",
					},
				],
			},
		],
		modules: [
			{
				uuid: CASE_CHANGES_SEED.moduleUuid,
				name: CASE_CHANGES_SEED.moduleName,
				caseType: CASE_CHANGES_SEED.caseType,
				// A case-bearing module needs one visible Results field, or rows
				// are indistinguishable and the app is invalid.
				caseListConfig: {
					columns: [
						plainColumn(
							CASE_CHANGES_SEED.columns.patientName,
							"case_name",
							"Patient",
						),
						plainColumn(
							CASE_CHANGES_SEED.columns.patientNote,
							"last_note",
							"Last note",
						),
					],
					listColumnOrder: [
						CASE_CHANGES_SEED.columns.patientName,
						CASE_CHANGES_SEED.columns.patientNote,
					],
					detailColumnOrder: [
						CASE_CHANGES_SEED.columns.patientName,
						CASE_CHANGES_SEED.columns.patientNote,
					],
					searchInputs: [],
				},
				forms: [
					{
						uuid: CASE_CHANGES_SEED.formUuid,
						name: CASE_CHANGES_SEED.formName,
						// Case-loading, so the module selects a case before opening its
						// forms and "the case this form opened" is a legal target.
						type: "followup",
						postSubmit: "app_home",
						fields: [
							f({
								uuid: CASE_CHANGES_SEED.fieldUuid,
								kind: "text",
								id: "visit_note",
								label: proseText("Visit note"),
							}),
							f({
								uuid: CASE_CHANGES_SEED.linkTargetFieldUuid,
								kind: "text",
								id: "related_case_id",
								label: proseText("Related patient case id"),
							}),
						],
					},
					{
						uuid: CASE_CHANGES_SEED.identityProjection.formUuid,
						name: CASE_CHANGES_SEED.identityProjection.formName,
						type: "close",
						fields: [
							f({
								uuid: CASE_CHANGES_SEED.identityProjection.firstNameUuid,
								kind: "text",
								id: "first_name",
								label: proseText("First name"),
							}),
							f({
								uuid: CASE_CHANGES_SEED.identityProjection.noteUuid,
								kind: "text",
								id: "note",
								label: proseText("Note"),
							}),
						],
					},
				],
			},
			{
				uuid: CASE_CHANGES_SEED.archivedModuleUuid,
				id: "archived_referrals",
				name: CASE_CHANGES_SEED.archivedModuleName,
				caseType: CASE_CHANGES_SEED.archivedCaseType,
				caseListOnly: true,
				caseListConfig: {
					columns: [
						plainColumn(
							CASE_CHANGES_SEED.columns.archivedName,
							"case_name",
							"Referral",
						),
						plainColumn(
							CASE_CHANGES_SEED.columns.archivedSource,
							"source_note",
							"Source note",
						),
						calculatedColumn(
							CASE_CHANGES_SEED.columns.archivedPatient,
							"Patient",
							term(
								prop(
									CASE_CHANGES_SEED.archivedCaseType,
									"case_name",
									ancestorPath(relationStep("parent")),
								),
							),
						),
					],
					listColumnOrder: [
						CASE_CHANGES_SEED.columns.archivedName,
						CASE_CHANGES_SEED.columns.archivedSource,
						CASE_CHANGES_SEED.columns.archivedPatient,
					],
					detailColumnOrder: [
						CASE_CHANGES_SEED.columns.archivedName,
						CASE_CHANGES_SEED.columns.archivedSource,
						CASE_CHANGES_SEED.columns.archivedPatient,
					],
					searchInputs: [],
				},
			},
		],
	});
	const form = doc.forms[CASE_CHANGES_SEED.formUuid];
	if (form === undefined) {
		throw new Error("caseChangesSeed: the fixture form did not build");
	}
	/* Attached here rather than through `buildDoc`: that shared helper takes
	 * authoring shorthand, while these operations are already in their stored
	 * shape. Array position IS the sequence, so the order written below is the
	 * order the list and the runtime both read. */
	return {
		...doc,
		forms: {
			...doc.forms,
			[CASE_CHANGES_SEED.formUuid]: {
				...form,
				caseOperations: caseOperations(lookupCarrier),
			},
		},
	};
}

/**
 * `file_referral` targets the case `create_referral` makes after an earlier
 * retype, so moving it ahead of that create is refused — and the refusal has a
 * name to say. `note_visit` depends on nothing, so the same keyboard path
 * still moves what it may.
 */
function caseOperations(
	lookupCarrier: CaseChangesLookupCarrier | undefined,
): CaseOperation[] {
	return [
		{
			uuid: CASE_CHANGES_SEED.operations.create,
			id: CASE_CHANGES_SEED.ids.create,
			action: "create",
			caseType: "referral",
			target: { kind: "new" },
			name: term(literal("Referral")),
		},
		{
			uuid: CASE_CHANGES_SEED.operations.retype,
			id: CASE_CHANGES_SEED.ids.retype,
			action: "update",
			caseType: "referral",
			target: { kind: "op", opUuid: CASE_CHANGES_SEED.operations.create },
			retype: CASE_CHANGES_SEED.archivedCaseType,
		},
		{
			uuid: CASE_CHANGES_SEED.operations.note,
			id: CASE_CHANGES_SEED.ids.note,
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: [{ property: "last_note", value: term(literal("Visited")) }],
		},
		{
			uuid: CASE_CHANGES_SEED.operations.file,
			id: CASE_CHANGES_SEED.ids.file,
			action: "update",
			caseType: CASE_CHANGES_SEED.archivedCaseType,
			target: { kind: "op", opUuid: CASE_CHANGES_SEED.operations.create },
			writes: [{ property: "source_note", value: term(literal("Filed")) }],
			links: [
				{
					identifier: "parent",
					targetType: "patient",
					target: {
						kind: "expression",
						expr: term(formField(CASE_CHANGES_SEED.linkTargetFieldUuid)),
					},
					relationship: "child",
				},
			],
		},
		// The sequence between the dependent head and the table-lookup tail. They
		// carry the list to twenty without adding a second thing that can
		// refuse a move, so the refusal the journey drives stays the only one.
		...CASE_CHANGES_ROUTINE.map((routine) => ({
			uuid: routine.uuid,
			id: routine.id,
			action: "update" as const,
			caseType: CASE_CHANGES_SEED.caseType,
			target: { kind: "session" as const },
			writes: [
				{ property: routine.property, value: term(literal(routine.label)) },
			],
		})),
		...(lookupCarrier === undefined
			? []
			: [
					{
						uuid: CASE_CHANGES_SEED.operations.tableLookup,
						id: CASE_CHANGES_SEED.ids.tableLookup,
						action: "update" as const,
						caseType: "patient",
						target: { kind: "session" as const },
						condition: eq(
							tableLookup(
								lookupCarrier.tableId,
								lookupCarrier.columnId,
								eq(
									tableColumn(lookupCarrier.tableId, lookupCarrier.columnId),
									literal("enabled"),
								),
							),
							literal("enabled"),
						),
					},
				]),
	];
}

/** The canonical relative path to the form's case-changes screen. */
export function caseChangesRoute(appId: string): string {
	return buildUrl(`/build/${appId}`, {
		kind: "form-operations",
		moduleUuid: CASE_CHANGES_SEED.moduleUuid,
		formUuid: CASE_CHANGES_SEED.formUuid,
	});
}

/** Form screen used to prove that friendly projections survive identity edits. */
export function identityProjectionRoute(
	appId: string,
	selectedUuid?: (typeof CASE_CHANGES_SEED.identityProjection)["firstNameUuid"],
): string {
	return buildUrl(`/build/${appId}`, {
		kind: "form",
		moduleUuid: CASE_CHANGES_SEED.moduleUuid,
		formUuid: CASE_CHANGES_SEED.identityProjection.formUuid,
		...(selectedUuid !== undefined && { selectedUuid }),
	});
}
