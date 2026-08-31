import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { projectCaseListForHq } from "@/lib/commcare/hqJson/caseList";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type Form, proseText } from "@/lib/domain";

const RETYPE = testUuid("88888888-8888-4888-8888-888888888888");

describe("multi-select HQ JSON emission", () => {
	it("carries selected-entity execution into the uploaded XForm source", () => {
		const base = caseListConfig([{ field: "case_name", header: "Name" }]);
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						...base,
						selection: { kind: "multiple", maximum: 10 },
					},
					forms: [
						{
							name: "Add visits",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "visit_name",
									caseWrite: { caseType: "visit", property: "case_name" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "visit",
					parent_type: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
		});
		const hq = expandDoc(doc);
		const source = Object.entries(hq._attachments).find(([name]) =>
			name.endsWith(".xml"),
		)?.[1];
		const ccz = new AdmZip(compileCcz(hq, doc.appName, doc));
		const compiled = ccz.readAsText("modules-0/forms-0.xml");
		const suite = ccz.readAsText("suite.xml");
		expect(source).toContain(
			`<instance src="jr://instance/selected-entities/selected_cases" id="selected_cases"/>`,
		);
		expect(source).toContain(
			`<__nova_subcase_0 vellum:role="SaveToCase" vellum:case_type="visit">`,
		);
		// HQ always allocates this scalar function datum from FormActions, even
		// though one selected parent now creates one child apiece. Keep local
		// suite parity, but make the orphan explicit: neither uploaded nor local
		// XForm source consumes it as a child id.
		expect(suite).toContain(
			`<datum id="case_id_new_visit_0" function="uuid()"/>`,
		);
		expect(source).not.toContain("session/data/case_id_new_visit_0");
		expect(compiled).not.toContain("session/data/case_id_new_visit_0");
	});

	it("keeps an ordinary batch close from undoing an earlier session retype", () => {
		const base = caseListConfig([{ field: "case_name", header: "Name" }]);
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						...base,
						selection: { kind: "multiple", maximum: 10 },
					},
					forms: [
						{
							name: "Archive selected",
							type: "close",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "archived_patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		(doc.forms[formUuid] as Form).caseOperations = [
			{
				uuid: RETYPE,
				id: "archive_selected",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				retype: "archived_patient",
			},
		];

		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const xform = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc),
		).readAsText("modules-0/forms-0.xml");
		expect(xform.indexOf("<archive_selected")).toBeLessThan(
			xform.indexOf("<__nova_close_selected_cases"),
		);
		expect(xform).toContain(
			`nodeset="/data/__nova_selected_cases/item/__nova_operations/archive_selected/case/update/case_type" calculate="&apos;archived_patient&apos;"`,
		);
		expect(xform).toContain(
			`<__nova_close_selected_cases vellum:role="SaveToCase" vellum:case_type="patient"><case case_id="" date_modified="" user_id="" xmlns="http://commcarehq.org/case/transaction/v2"><close/></case></__nova_close_selected_cases>`,
		);
		expect(xform).not.toContain(
			"/__nova_close_selected_cases/case/update/case_type",
		);
	});

	it("writes cardinality only on the short case detail", () => {
		const base = caseListConfig([{ field: "case_name", header: "Name" }]);
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						...base,
						selection: { kind: "multiple", maximum: 15 },
					},
					forms: [
						{
							name: "Review",
							type: "followup",
							fields: [
								f({ kind: "text", id: "note", label: proseText("Note") }),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
		});
		const module = doc.modules[doc.moduleOrder[0]];
		const { caseDetails } = projectCaseListForHq(module, doc);

		expect(caseDetails.short.multi_select).toBe(true);
		expect(caseDetails.short.max_select_value).toBe(15);
		expect(caseDetails.long.multi_select).toBeUndefined();
		expect(caseDetails.long.max_select_value).toBeUndefined();
	});
});
