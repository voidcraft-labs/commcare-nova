/**
 * The session and search reads a form and a menu make, in one document: a
 * search-first module whose follow-up form holds a hidden value, a case-choice
 * question, a form link, a case operation and a Connect delivery; an ordinary
 * module that searches; a child of it that chooses a parent first (so its form
 * opens after two case lists); and a survey (after none). Shared by the
 * checker's tests (`typeChecker.test.ts`), the form-logic findings
 * (`lib/commcare/validator/__tests__/formLogicFindings.test.ts`) and the
 * builder's sentences (`lib/doc/__tests__/userFacingErrors.test.ts`).
 */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, NEW_APP_SETTINGS } from "@/lib/domain";
import { advancedSearchInputDef } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { matchAll } from "../builders";
import type { ExpressionSlotRef } from "../types";

export const READS_MODULE = testUuid("reads-search-first-module");
export const READS_VISIT = testUuid("reads-visit");
export const READS_HIDDEN = testUuid("reads-hidden");
export const READS_CHOICE = testUuid("reads-choice");
export const READS_LINK = testUuid("reads-link");
export const READS_OPERATION = testUuid("reads-operation");
export const READS_INPUT = testUuid("reads-input");
export const OTHER_MODULE = testUuid("reads-ordinary-module");
export const OTHER_FORM = testUuid("reads-ordinary-form");
export const OTHER_HIDDEN = testUuid("reads-ordinary-hidden");
export const OTHER_INPUT = testUuid("reads-ordinary-input");
export const CHILD_MODULE = testUuid("reads-child-module");
export const CHILD_FORM = testUuid("reads-child-form");
export const CHILD_HIDDEN = testUuid("reads-child-hidden");
export const SURVEY_MODULE = testUuid("reads-survey-module");
export const SURVEY_FORM = testUuid("reads-survey-form");
export const SURVEY_HIDDEN = testUuid("reads-survey-hidden");

const searchInput = (uuid: string, name: string) =>
	advancedSearchInputDef(uuid, name, name, "text", matchAll());

/** A search-first module whose follow-up form holds a hidden value, a
 * case-choice question, a form link, a case operation and a Connect
 * delivery; an ordinary module that searches; a child of it that chooses
 * a parent first (two case lists); and a survey (none). The declaration
 * is set by hand: the reads, not the platforms, are under test. */
export const readsDoc = (
	runsOnlyOn: "web-apps" | "android" = "web-apps",
): BlueprintDoc =>
	buildDoc(
		{
			appName: "Reads",
			connectType: "deliver",
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn },
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "visit",
					parent: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: READS_MODULE,
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						searchInputs: [searchInput(READS_INPUT, "patient_name")],
					},
					caseSearchConfig: { searchFirst: true },
					forms: [
						{
							uuid: READS_VISIT,
							name: "Visit",
							type: "followup",
							connect: { deliver_unit: { id: "visit", name: "Visit" } },
							formLinks: [
								{
									uuid: READS_LINK,
									condition: "true()",
									target: { type: "module", moduleUuid: OTHER_MODULE },
								},
							],
							fields: [
								f({ kind: "text", id: "note", label: proseText("Note") }),
								f({
									kind: "hidden",
									id: "value",
									uuid: READS_HIDDEN,
									calculate: "1",
								}),
								f({
									kind: "single_select",
									id: "choice",
									uuid: READS_CHOICE,
									label: proseText("Choice"),
									optionsSource: {
										kind: "cases",
										caseType: "patient",
										labelProperty: "case_name",
									},
								}),
							],
						},
					],
				},
				{
					uuid: OTHER_MODULE,
					name: "Ordinary",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						searchInputs: [searchInput(OTHER_INPUT, "other_name")],
					},
					forms: [
						{
							uuid: OTHER_FORM,
							name: "Check",
							type: "followup",
							fields: [
								f({
									kind: "hidden",
									id: "value",
									uuid: OTHER_HIDDEN,
									calculate: "1",
								}),
							],
						},
					],
				},
				{
					uuid: CHILD_MODULE,
					name: "Visits",
					caseType: "visit",
					parentCaseModuleUuid: OTHER_MODULE,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: CHILD_FORM,
							name: "Visit check",
							type: "followup",
							fields: [
								f({
									kind: "hidden",
									id: "value",
									uuid: CHILD_HIDDEN,
									calculate: "1",
								}),
							],
						},
					],
				},
				{
					uuid: SURVEY_MODULE,
					name: "Survey",
					forms: [
						{
							uuid: SURVEY_FORM,
							name: "Survey",
							type: "survey",
							fields: [
								f({
									kind: "hidden",
									id: "value",
									uuid: SURVEY_HIDDEN,
									calculate: "1",
								}),
							],
						},
					],
				},
			],
		},
		(doc) => {
			const form = doc.forms[READS_VISIT];
			if (form === undefined) throw new Error("The visit form is missing.");
			form.caseOperations = [
				{
					uuid: READS_OPERATION,
					id: "reads_update",
					action: "update",
					caseType: "patient",
					target: { kind: "session" },
				},
			];
		},
	);

export const calculateOf = (uuid: string): ExpressionSlotRef => ({
	entity: "field",
	uuid: uuid as never,
	slot: "calculate",
});
export const connectSlot: ExpressionSlotRef = {
	entity: "form",
	uuid: READS_VISIT,
	slot: "deliver_entity_id",
};
export const linkSlot: ExpressionSlotRef = {
	entity: "form",
	uuid: READS_VISIT,
	slot: "form_link_condition",
	member: { linkUuid: READS_LINK },
};
export const operationSlot: ExpressionSlotRef = {
	entity: "form",
	uuid: READS_VISIT,
	slot: "case_operation_condition",
	member: { operationUuid: READS_OPERATION },
};
export const choiceSlot: ExpressionSlotRef = {
	entity: "field",
	uuid: READS_CHOICE,
	slot: "lookup_options_source",
};
