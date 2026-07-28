/**
 * A form whose case changes already depend on one another.
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
import { buildUrl } from "@/lib/routing/location";

export const CASE_CHANGES_SEED = {
	appName: "Smoke — Case changes",
	moduleName: "Patients",
	formName: "Visit",
	moduleUuid: asUuid("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"),
	formUuid: asUuid("1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e"),
	fieldUuid: asUuid("2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"),
	linkTargetFieldUuid: asUuid("3c4d5e6f-7a8b-4d9e-8f0a-1b2c3d4e5f6a"),
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
		dormant: asUuid("6a7b8c9d-0e1f-402a-8c3d-4e5f6a7b8c9d"),
		retype: asUuid("7b8c9d0e-1f2a-413b-9d4e-5f6a7b8c9d0e"),
	},
	ids: {
		create: "create_referral",
		note: "note_visit",
		file: "file_referral",
		dormant: "lookup_patient",
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
						label: "Last note",
						data_type: "text",
					},
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
						label: "Source note",
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
								label: "Visit note",
							}),
							f({
								uuid: CASE_CHANGES_SEED.linkTargetFieldUuid,
								kind: "text",
								id: "related_case_id",
								label: "Related patient case id",
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
					],
					detailColumnOrder: [
						CASE_CHANGES_SEED.columns.archivedName,
						CASE_CHANGES_SEED.columns.archivedSource,
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
	 * shape — including the fractional order keys the list reads. */
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
		...(lookupCarrier === undefined
			? []
			: [
					{
						uuid: CASE_CHANGES_SEED.operations.dormant,
						id: CASE_CHANGES_SEED.ids.dormant,
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
