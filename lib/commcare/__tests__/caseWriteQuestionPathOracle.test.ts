import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { CCHQ_BASIC_UPDATE_XML } from "@/lib/commcare/__tests__/fixtures/cchqBasicUpdate";
import { buildFormActions } from "@/lib/commcare/formActions";
import { buildXForm } from "@/lib/commcare/xform";
import { addCaseBlocks } from "@/lib/commcare/xform/caseBlocks";
import { proseText } from "@/lib/domain/prose";

const CALL_CENTER_FIXTURE = join(
	homedir(),
	"code/commcare-hq/corehq/apps/app_manager/tests/data/suite/call-center.json",
);
const CCHQ_BASIC_UPDATE_FIXTURE = join(
	homedir(),
	"code/commcare-hq/corehq/ex-submodules/casexml/apps/case/tests/data/v2/basic_update.xml",
);
const CCHQ_XFORM_EMITTER = join(
	homedir(),
	"code/commcare-hq/corehq/apps/app_manager/xform.py",
);

/**
 * Literal extracted from CommCare HQ's `call-center.json` fixture. It is
 * deliberately checked in here so CI proves the wire contract even when the
 * sibling CommCare HQ checkout is unavailable.
 */
const CCHQ_ISSUE_DESCRIPTION_UPDATE = {
	question_path: "/data/description",
	update_mode: "always",
} as const;

function issueDescriptionUpdates(value: unknown): unknown[] {
	if (Array.isArray(value)) return value.flatMap(issueDescriptionUpdates);
	if (value === null || typeof value !== "object") return [];
	const object = value as Record<string, unknown>;
	return [
		...(Object.hasOwn(object, "issue_description")
			? [object.issue_description]
			: []),
		...Object.values(object).flatMap(issueDescriptionUpdates),
	];
}

describe("caseWrite field identity and property projection", () => {
	it("pins CCHQ's exact accepted basic_update.xml bytes", () => {
		const checkedInBytes = Buffer.from(CCHQ_BASIC_UPDATE_XML, "utf8");

		expect(checkedInBytes.byteLength).toBe(454);
		expect(createHash("sha256").update(checkedInBytes).digest("hex")).toBe(
			"7176e49d38af6113fb95b552c4bb0be7bc817634fbace2a7a810f771d467ceac",
		);
		expect(checkedInBytes.at(-1)).toBe(">".charCodeAt(0));
		expect(CCHQ_BASIC_UPDATE_XML).toContain(
			"<update>\n\t\t\t<case_type>updated_v2_case_type</case_type>\n\t\t\t<case_name>updated case name</case_name>",
		);
		expect(CCHQ_BASIC_UPDATE_XML).not.toContain("<create>");

		// When the sibling HQ checkout is present, detect upstream fixture drift
		// with a full byte comparison. The checked-in length + digest assertions
		// above remain the unconditional CI oracle.
		if (existsSync(CCHQ_BASIC_UPDATE_FIXTURE)) {
			expect(readFileSync(CCHQ_BASIC_UPDATE_FIXTURE)).toEqual(checkedInBytes);
		}
	});

	it("matches CCHQ when the friendly question id differs from the case property", () => {
		const doc = buildDoc({
			appName: "Call center oracle",
			caseTypes: [
				{
					name: "issue",
					properties: [
						{ name: "case_name", label: proseText("Issue") },
						{
							name: "issue_description",
							label: proseText("Description"),
						},
					],
				},
			],
			modules: [
				{
					name: "Issues",
					caseType: "issue",
					forms: [
						{
							name: "Report issue",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "subject",
									label: proseText("Issue"),
									caseWrite: {
										caseType: "issue",
										property: "case_name",
									},
								}),
								f({
									kind: "text",
									id: "description",
									label: proseText("Description"),
									caseWrite: {
										caseType: "issue",
										property: "issue_description",
									},
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const descriptionUuid = doc.fieldOrder[formUuid][1];
		const actions = buildFormActions(doc, formUuid, "issue");

		expect(actions.update_case.update.issue_description).toEqual(
			CCHQ_ISSUE_DESCRIPTION_UPDATE,
		);

		const xform = addCaseBlocks(
			buildXForm(doc, formUuid, {
				xmlns: "http://openrosa.org/formdesigner/case-write-oracle",
				moduleCaseType: "issue",
			}),
			actions,
			"issue",
		);
		expect(xform).toContain("<update><issue_description/></update>");
		expect(xform).toContain(
			'<bind nodeset="/data/case/update/issue_description" calculate="/data/description"',
		);

		const descriptionField = doc.fields[descriptionUuid];
		expect(descriptionField.kind).toBe("text");
		if (descriptionField.kind !== "text") {
			throw new Error("Oracle field must remain a text field.");
		}
		const storedDestination = structuredClone(descriptionField.caseWrite);
		descriptionField.id = "current_description";
		expect(descriptionField.caseWrite).toEqual(storedDestination);
		expect(
			buildFormActions(doc, formUuid, "issue").update_case.update
				.issue_description,
		).toEqual({
			question_path: "/data/current_description",
			update_mode: "always",
		});

		if (existsSync(CALL_CENTER_FIXTURE)) {
			const upstream = JSON.parse(
				readFileSync(CALL_CENTER_FIXTURE, "utf8"),
			) as unknown;
			expect(issueDescriptionUpdates(upstream)).toContainEqual(
				CCHQ_ISSUE_DESCRIPTION_UPDATE,
			);
		}
	});

	it("updates and preloads an existing case name through the field's current path", () => {
		const doc = buildDoc({
			appName: "Existing case name oracle",
			caseTypes: [
				{
					name: "issue",
					properties: [{ name: "case_name", label: proseText("Issue") }],
				},
			],
			modules: [
				{
					name: "Issues",
					caseType: "issue",
					forms: [
						{
							name: "Rename issue",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "display_name",
									label: proseText("Issue"),
									caseWrite: {
										caseType: "issue",
										property: "case_name",
									},
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const actions = buildFormActions(doc, formUuid, "issue");

		// HQ's authoring projection names this private FormActions key `name`;
		// XFormCaseBlock lowers it to the public wire node `<case_name>`.
		expect(actions.update_case.update.name).toEqual({
			question_path: "/data/display_name",
			update_mode: "always",
		});
		expect(actions.case_preload.preload).toEqual({
			"/data/display_name": "name",
		});

		const xform = addCaseBlocks(
			buildXForm(doc, formUuid, {
				xmlns: "http://openrosa.org/formdesigner/case-name-update-oracle",
				moduleCaseType: "issue",
			}),
			actions,
			"issue",
		);
		expect(xform).toContain("<update><case_name/></update>");
		expect(xform).toContain(
			'<bind nodeset="/data/case/update/case_name" calculate="replace(/data/display_name, &apos;^[\\x00-\\x20]+|[\\x00-\\x20]+$&apos;, &apos;&apos;)"',
		);
		expect(xform).toContain(
			'constraint="string-length(.) &gt; 0 and string-length(.) &lt;= 255"',
		);

		if (existsSync(CCHQ_XFORM_EMITTER)) {
			const upstreamEmitter = readFileSync(CCHQ_XFORM_EMITTER, "utf8");
			expect(upstreamEmitter).toContain("if key == 'name':");
			expect(upstreamEmitter).toContain("key = 'case_name'");
		}
	});

	it("refuses a stored case destination when the form emits no case action", () => {
		const doc = buildDoc({
			appName: "No action refusal",
			caseTypes: [
				{
					name: "issue",
					properties: [
						{
							name: "issue_description",
							label: proseText("Description"),
						},
					],
				},
			],
			modules: [
				{
					name: "Reference",
					forms: [
						{
							name: "Read only",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "description",
									label: proseText("Description"),
									caseWrite: {
										caseType: "issue",
										property: "issue_description",
									},
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];

		expect(() => buildFormActions(doc, formUuid, "")).toThrow(
			/has caseWrite but its form emits no case action/,
		);
	});

	it("refuses duplicate writers instead of choosing one by object assignment", () => {
		const doc = buildDoc({
			appName: "Duplicate writer refusal",
			caseTypes: [
				{
					name: "issue",
					properties: [
						{
							name: "issue_description",
							label: proseText("Description"),
						},
					],
				},
			],
			modules: [
				{
					name: "Issues",
					caseType: "issue",
					forms: [
						{
							name: "Update issue",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "description_a",
									label: proseText("Description A"),
									caseWrite: {
										caseType: "issue",
										property: "issue_description",
									},
								}),
								f({
									kind: "text",
									id: "description_b",
									label: proseText("Description B"),
									caseWrite: {
										caseType: "issue",
										property: "issue_description",
									},
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];

		expect(() => buildFormActions(doc, formUuid, "issue")).toThrow(
			/has 2 field writers for property 'issue_description'/,
		);
	});
});
