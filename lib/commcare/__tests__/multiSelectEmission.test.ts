import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { projectCaseListForHq } from "@/lib/commcare/hqJson/caseList";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type Form, proseText } from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";

const RETYPE = testUuid("88888888-8888-4888-8888-888888888888");
const ORDINARY_WRITE = testUuid("99999999-9999-4999-8999-999999999999");
const ATTACHMENT_TARGET = {
	origin: "https://www.commcarehq.org",
	domain: "demo-project",
};

describe("multi-select HQ JSON emission", () => {
	it("emits a selected-case update when the form has no other effects", () => {
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
							name: "Add note",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "note",
									caseWrite: { caseType: "patient", property: "note" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "note", label: proseText("Note") },
					],
				},
			],
		});

		const hq = expandDoc(doc);
		const source = hq._attachments[`${hq.modules[0].forms[0].unique_id}.xml`];
		if (source === undefined) throw new Error("Missing emitted XForm source");
		expect(source).toContain(
			`<__nova_update_selected_cases vellum:role="SaveToCase" vellum:case_type="patient">`,
		);
		expect(validateXForm(source, "Add note", "Patients")).toEqual([]);
	});

	it("lowers shared primary answers after authored operations and before close", () => {
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
							name: "Update selected",
							type: "close",
							fields: [
								f({
									kind: "text",
									id: "full_name",
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									kind: "text",
									id: "note",
									default_value: "'Review completed'",
									caseWrite: { caseType: "patient", property: "note" },
								}),
								f({
									kind: "text",
									id: "external_id",
									caseWrite: {
										caseType: "patient",
										property: "external_id",
									},
								}),
								f({
									kind: "image",
									id: "photo",
									caseWrite: {
										caseType: "patient",
										property: "photo",
										mode: "attachment",
									},
								}),
								f({
									kind: "image",
									id: "photo_link",
									caseWrite: {
										caseType: "patient",
										property: "photo_url",
										mode: "url",
									},
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "note", label: proseText("Note") },
						{ name: "reviewed", label: proseText("Reviewed") },
						{ name: "photo", label: proseText("Photo") },
						{ name: "photo_url", label: proseText("Photo link") },
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		(doc.forms[formUuid] as Form).caseOperations = [
			{
				uuid: ORDINARY_WRITE,
				id: "mark_selected",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [
					{
						property: "reviewed",
						value: term(literal("yes")),
					},
				],
			},
		];

		const hq = expandDoc(doc, { attachmentTarget: ATTACHMENT_TARGET });
		const actions = hq.modules[0].forms[0].actions;
		expect(actions.update_case.condition.type).toBe("never");
		expect(actions.update_case.update).toEqual({});
		expect(actions.case_preload.condition.type).toBe("never");
		expect(actions.case_preload.preload).toEqual({});

		const source = hq._attachments[`${hq.modules[0].forms[0].unique_id}.xml`];
		if (source === undefined) throw new Error("Missing emitted XForm source");
		const decoded = source
			.replaceAll("&apos;", "'")
			.replaceAll("&gt;", ">")
			.replaceAll("&lt;", "<");
		const primaryStart = decoded.indexOf("<__nova_update_selected_cases");
		expect(decoded.indexOf("<mark_selected")).toBeLessThan(primaryStart);
		expect(primaryStart).toBeLessThan(
			decoded.indexOf("<__nova_close_selected_cases"),
		);
		expect(decoded).toContain(
			`<update><case_name/><note/><external_id/><photo_url/></update><attachment><photo src="" from="local"/></attachment>`,
		);
		expect(decoded).toContain(
			`nodeset="/data/__nova_selected_cases/item/__nova_operations/__nova_update_selected_cases" relevant="(count(/data/full_name) > 0 and string(replace(/data/full_name, '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')) != '') or (count(/data/note) > 0 and string(/data/note) != '')`,
		);
		expect(decoded).toContain(
			`nodeset="/data/__nova_selected_cases/item/__nova_operations/__nova_update_selected_cases/case/update/note" calculate="/data/note" relevant="count(/data/note) > 0 and string(/data/note) != ''"`,
		);
		expect(decoded).toContain(
			`nodeset="/data/__nova_selected_cases/item/__nova_operations/__nova_update_selected_cases/case/attachment/photo" relevant="count(/data/photo) = 1 and string(/data/photo) != ''"`,
		);
		expect(decoded).toContain(
			`nodeset="/data/__nova_selected_cases/item/__nova_operations/__nova_update_selected_cases/case/update/photo_url" calculate="/data/__nova_url_photo_link" relevant="count(/data/__nova_url_photo_link) > 0 and string(/data/__nova_url_photo_link) != ''"`,
		);
		expect(decoded).not.toContain(
			`event="xforms-ready" ref="/data/note" value="instance('casedb')`,
		);
		expect(source).toContain(
			`event="xforms-ready" vellum:ref="#form/note" ref="/data/note" value="&apos;Review completed&apos;"`,
		);
		expect(validateXForm(source, "Update selected", "Patients")).toEqual([]);

		const compiled = new AdmZip(compileCcz(hq, doc.appName, doc)).readAsText(
			"modules-0/forms-0.xml",
		);
		expect(compiled).toContain(
			`<__nova_update_selected_cases vellum:role="SaveToCase" vellum:case_type="patient">`,
		);
		expect(compiled).not.toContain(`nodeset="/data/case/update/case_name"`);

		const withoutTarget = expandDoc(doc);
		const withoutTargetSource =
			withoutTarget._attachments[
				`${withoutTarget.modules[0].forms[0].unique_id}.xml`
			];
		if (withoutTargetSource === undefined) {
			throw new Error("Missing targetless XForm source");
		}
		expect(withoutTargetSource).toContain(
			`/__nova_update_selected_cases/case/attachment/photo`,
		);
		expect(withoutTargetSource).not.toContain(
			`/__nova_update_selected_cases/case/update/photo_url`,
		);
	});

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
