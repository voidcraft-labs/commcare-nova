import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { CaseRow } from "@/lib/case-store";
import {
	type CaseOptionsSource,
	effectiveCaseTypes,
	plainColumn,
} from "@/lib/domain";
import {
	and,
	eq,
	exists,
	formField,
	literal,
	prop,
	term,
} from "@/lib/domain/predicate";
import type { FormEngineInput } from "@/lib/preview/engine/formEngine";
import type { CaseDatabaseSnapshot } from "@/lib/preview/engine/xpathInstances";

export const choiceUuid = (name: string) => testUuid(`case-choices-${name}`);
export const CLINIC_A = choiceUuid("clinic-a");
export const CLINIC_B = choiceUuid("clinic-b");
export const memberId = (index: number) => choiceUuid(`member-${index}`);
export const openMembers = and(
	eq(prop("member", "status"), literal("open")),
	exists(
		{
			kind: "ancestor",
			via: [{ identifier: "parent", throughCaseType: "clinic" }],
		},
		eq(
			prop("clinic", "case_id"),
			term({ kind: "form-case", caseType: "clinic", property: "case_id" }),
		),
	),
);

export function caseChoiceDoc() {
	const clinic: CaseOptionsSource = {
		kind: "cases",
		caseType: "clinic",
		labelProperty: "case_name",
	};
	const doc = buildDoc({
		appId: "case-choices",
		appName: "Clinic attendance",
		caseTypes: [
			{
				name: "clinic",
				properties: [{ name: "region", label: "Region", data_type: "text" }],
			},
			{
				name: "member",
				parent_type: "clinic",
				relationship: "child",
				properties: [
					{ name: "attendance", label: "Attendance", data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: choiceUuid("directory-module"),
				name: "Directory",
				forms: [
					{
						uuid: choiceUuid("directory"),
						name: "Directory",
						type: "survey",
						fields: [
							f({
								uuid: choiceUuid("clinic"),
								id: "clinic",
								kind: "single_select",
								label: "Clinic",
								optionsSource: clinic,
							}),
							f({
								uuid: choiceUuid("members"),
								id: "members",
								kind: "multi_select",
								label: "Members",
								optionsSource: {
									kind: "cases",
									caseType: "member",
									labelProperty: "case_name",
									filter: and(
										eq(prop("member", "status"), literal("open")),
										exists(
											{
												kind: "ancestor",
												via: [
													{ identifier: "parent", throughCaseType: "clinic" },
												],
											},
											eq(
												prop("clinic", "case_id"),
												formField(choiceUuid("clinic")),
											),
										),
									),
								},
							}),
							f({
								uuid: choiceUuid("selected"),
								id: "selected",
								kind: "hidden",
								calculate: "#form/members",
							}),
						],
					},
				],
			},
			{
				uuid: choiceUuid("attendance-module"),
				name: "Clinics",
				caseType: "clinic",
				caseListConfig: {
					columns: [
						plainColumn(choiceUuid("clinic-name"), "case_name", "Name"),
					],
					searchInputs: [],
				},
				forms: [
					{
						uuid: choiceUuid("attendance"),
						name: "Attendance",
						type: "followup",
						fields: [
							f({
								uuid: choiceUuid("entry"),
								id: "entry",
								kind: "section",
								label: "Attendance",
								children: [
									f({
										uuid: choiceUuid("attendees"),
										id: "attendees",
										kind: "multi_select",
										label: "Who attended?",
										optionsSource: {
											kind: "cases",
											caseType: "member",
											labelProperty: "case_name",
											filter: openMembers,
										},
									}),
									f({
										uuid: choiceUuid("roster"),
										id: "roster",
										kind: "repeat",
										repeat_mode: "query_bound",
										data_source: {
											ids_query:
												"instance('casedb')/casedb/case[@case_type='member'][@status='open'][index/parent = #clinic/case_id]/@case_id",
										},
										children: [
											f({
												uuid: choiceUuid("member-id"),
												id: "member_id",
												kind: "hidden",
												calculate: "current()/../@id",
											}),
											f({
												uuid: choiceUuid("attended"),
												id: "attended",
												kind: "hidden",
												calculate:
													"if(selected(#form/entry/attendees, current()/../member_id), 'yes', 'no')",
											}),
										],
									}),
								],
							}),
							f({
								uuid: choiceUuid("review"),
								id: "review",
								kind: "section",
								label: "Review",
								children: [
									f({
										uuid: choiceUuid("ready"),
										id: "ready",
										kind: "label",
										label: "Your attendance is ready to save",
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	// The fixture builder supplies labels by default. This automatic roster
	// has no worker-facing content: only the checklist above is presented.
	const roster = doc.fields[choiceUuid("roster")];
	if (roster.kind !== "repeat") throw new Error("Expected the stable roster");
	delete roster.label;
	doc.forms[choiceUuid("attendance")].caseOperations = [
		{
			uuid: choiceUuid("operation"),
			id: "mark_attendance",
			action: "update",
			caseType: "member",
			forEach: { repeat: choiceUuid("roster") },
			target: {
				kind: "expression",
				expr: term(formField(choiceUuid("member-id"))),
			},
			condition: eq(formField(choiceUuid("attended")), literal("yes")),
			writes: [{ property: "attendance", value: term(literal("present")) }],
		},
	];
	return doc;
}

export function caseChoiceInput(
	doc = caseChoiceDoc(),
	form = choiceUuid("directory"),
): FormEngineInput {
	return {
		formUuid: form,
		form: doc.forms[form],
		fields: doc.fields,
		fieldOrder: doc.fieldOrder,
		caseTypes: effectiveCaseTypes(doc),
	};
}

export function choiceRow(
	id: string,
	type: string,
	name: string,
	parent: string | null = null,
): CaseRow {
	return {
		case_id: id,
		app_id: "case-choices",
		case_type: type,
		case_name: name,
		owner_id: "worker-a",
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		external_id: null,
		parent_case_id: parent,
		properties: {},
	};
}

export function caseChoiceSnapshot(): CaseDatabaseSnapshot {
	const rows: CaseRow[] = [
		choiceRow(CLINIC_A, "clinic", "East clinic"),
		choiceRow(CLINIC_B, "clinic", "West clinic"),
		...Array.from({ length: 30 }, (_, i) =>
			choiceRow(
				memberId(i),
				"member",
				i < 2 ? "Alex" : `Member ${i + 1}`,
				CLINIC_A,
			),
		),
		choiceRow(memberId(30), "member", "West member", CLINIC_B),
		{
			...choiceRow(memberId(31), "member", "Closed member", CLINIC_A),
			status: "closed",
		},
	];
	return {
		rows,
		indices: rows
			.filter(
				(row): row is CaseRow & { parent_case_id: string } =>
					row.parent_case_id !== null,
			)
			.map((row) => ({
				case_id: row.case_id,
				identifier: "parent",
				ancestor_id: row.parent_case_id,
				target_case_type: "clinic",
				depth: 1,
				relationship: "child",
			})),
	};
}
