// components/builder/form-links/__tests__/fixture.ts
//
// One app, three modules, every carry answer: from Intake's registration
// form, a link to Care's follow-up carries the new patient automatically,
// a link to Care's survey needs nothing, and a link to Households'
// follow-up needs a household id this form cannot supply — so every seed
// path the surface has is reachable from one source form.

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, FormLink } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

export const INTAKE = testUuid("mod-intake");
export const CARE = testUuid("mod-care");
export const HOUSEHOLDS = testUuid("mod-households");
export const SOURCE = testUuid("frm-source");
export const VISIT = testUuid("frm-visit");
export const NOTE = testUuid("frm-note");
export const INSPECT = testUuid("frm-inspect");

export interface LinkSpec {
	uuid: string;
	condition?: string;
	target: FormLink["target"];
	datums?: Array<{ name: string; xpath: string }>;
}

export const toVisit = {
	type: "form",
	moduleUuid: CARE,
	formUuid: VISIT,
} as const;
export const toNote = {
	type: "form",
	moduleUuid: CARE,
	formUuid: NOTE,
} as const;
export const toInspect = {
	type: "form",
	moduleUuid: HOUSEHOLDS,
	formUuid: INSPECT,
} as const;
export const toCare = { type: "module", moduleUuid: CARE } as const;

export function fixture(
	links: LinkSpec[] = [],
	opts: {
		postSubmit?: "app_home" | "module" | "previous";
		/** Links on Visit, to build chains for the cycle rule. */
		visitLinks?: LinkSpec[];
	} = {},
): BlueprintDoc {
	return buildDoc({
		appName: "Links",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "mood", label: proseText("Mood") }],
			},
			{
				name: "household",
				properties: [{ name: "size", label: proseText("Size") }],
			},
		],
		modules: [
			{
				uuid: "mod-intake",
				name: "Intake",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-source",
						name: "Source",
						type: "registration",
						...(opts.postSubmit !== undefined && {
							postSubmit: opts.postSubmit,
						}),
						...(links.length > 0 && { formLinks: links }),
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				uuid: "mod-care",
				name: "Care",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-visit",
						name: "Visit",
						type: "followup",
						...(opts.visitLinks !== undefined &&
							opts.visitLinks.length > 0 && { formLinks: opts.visitLinks }),
						fields: [
							f({
								kind: "text",
								id: "mood",
								label: proseText("Mood"),
								caseWrite: { caseType: "patient", property: "mood" },
							}),
						],
					},
					{
						uuid: "frm-note",
						name: "Note",
						type: "survey",
						fields: [f({ kind: "text", id: "n", label: proseText("N") })],
					},
				],
			},
			{
				uuid: "mod-households",
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-inspect",
						name: "Inspect",
						type: "followup",
						fields: [
							f({
								kind: "int",
								id: "size",
								label: proseText("Size"),
								caseWrite: { caseType: "household", property: "size" },
							}),
						],
					},
				],
			},
		],
	});
}
