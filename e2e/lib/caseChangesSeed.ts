/**
 * A form whose case changes already depend on one another.
 *
 * The reorder refusal is the part of case-change authoring that most needs
 * a real browser: it is a keyboard interaction whose whole value is what a
 * person is TOLD when nothing moves. Seeding the dependency rather than
 * building it through five clicks keeps the journey short enough to be
 * deterministic — the spec drives one keypress and reads one sentence.
 *
 * `file_referral` targets the case `create_referral` makes, so moving it
 * ahead of that create is refused by the move planner, and the refusal has
 * a name to say. `note_visit` depends on nothing, so it proves the same
 * keyboard path still moves what it may.
 */

import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type BlueprintDoc,
	type CaseOperation,
	type LookupColumnId,
	type LookupTableId,
} from "@/lib/domain";
import {
	eq,
	literal,
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
	caseType: "patient",
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
		retype: "retype_patient",
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
					{
						name: "source_note",
						label: "Source note",
						data_type: "text",
					},
				],
			},
			{
				name: "visit",
				properties: [
					{
						name: "last_note",
						label: "Last note",
						data_type: "text",
					},
					{
						name: "source_note",
						label: "Source note",
						data_type: "text",
					},
				],
			},
			{
				name: "referral",
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
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: CASE_CHANGES_SEED.formUuid,
						name: CASE_CHANGES_SEED.formName,
						// Case-loading, so the module selects a case before opening its
						// forms and "the case this form opened" is a legal target.
						type: "followup",
						fields: [
							f({
								uuid: CASE_CHANGES_SEED.fieldUuid,
								kind: "text",
								id: "visit_note",
								label: "Visit note",
							}),
						],
					},
				],
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
 * `file_referral` targets the case `create_referral` makes, so moving it
 * ahead of that create is refused — and the refusal has a name to say.
 * `note_visit` depends on nothing, so the same keyboard path still moves
 * what it may.
 */
function caseOperations(
	lookupCarrier: CaseChangesLookupCarrier | undefined,
): CaseOperation[] {
	return [
		{
			uuid: CASE_CHANGES_SEED.operations.create,
			id: CASE_CHANGES_SEED.ids.create,
			order: "a0",
			action: "create",
			caseType: "referral",
			target: { kind: "new" },
			name: term(literal("Referral")),
		},
		{
			uuid: CASE_CHANGES_SEED.operations.note,
			id: CASE_CHANGES_SEED.ids.note,
			order: "a1",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: [{ property: "last_note", value: term(literal("Visited")) }],
		},
		{
			uuid: CASE_CHANGES_SEED.operations.file,
			id: CASE_CHANGES_SEED.ids.file,
			order: "a2",
			action: "update",
			caseType: "referral",
			target: { kind: "op", opUuid: CASE_CHANGES_SEED.operations.create },
			writes: [{ property: "source_note", value: term(literal("Filed")) }],
		},
		...(lookupCarrier === undefined
			? []
			: [
					{
						uuid: CASE_CHANGES_SEED.operations.dormant,
						id: CASE_CHANGES_SEED.ids.dormant,
						order: "a3",
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
		{
			uuid: CASE_CHANGES_SEED.operations.retype,
			id: CASE_CHANGES_SEED.ids.retype,
			order: "a4",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			retype: "visit",
		},
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
