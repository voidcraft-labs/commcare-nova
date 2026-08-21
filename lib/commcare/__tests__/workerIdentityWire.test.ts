import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import { eq, literal, sessionUserProperty } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

const PROPERTY_UUID = testUuid("worker-property-supervisor");
const SESSION_PROPERTY =
	"instance('commcaresession')/session/user/data/is_supervisor";
const USERCASE =
	"instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]";

const CCHQ_ROOT = join(homedir(), "code/commcare-hq");
const CCHQ_USERCASE_FIXTURE = join(
	CCHQ_ROOT,
	"corehq/apps/app_manager/tests/data/suite/suite-case-detail-tabs-with-nodesets.xml",
);
const CCHQ_REQUIRED_TEST = join(
	CCHQ_ROOT,
	"corehq/apps/app_manager/tests/test_suite_remote_request.py",
);

function attributeWhere(
	xml: string,
	elementName: string,
	attributeName: string,
	where: (attributes: Readonly<Record<string, string>>) => boolean,
): string | undefined {
	let found: string | undefined;
	const parser = new Parser(
		{
			onopentag(name, attributes) {
				if (found === undefined && name === elementName && where(attributes)) {
					found = attributes[attributeName];
				}
			},
		},
		{ xmlMode: true },
	);
	parser.end(xml);
	return found;
}

function workerReferenceDoc() {
	const doc = buildDoc({
		appName: "Worker reference wire",
		modules: [
			{
				name: "Supervisors",
				displayCondition: eq(sessionUserProperty(PROPERTY_UUID), literal("n")),
				forms: [
					{
						name: "Check",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "supervisor_note",
								label: proseText("Supervisor note"),
							}),
						],
					},
				],
			},
		],
	});
	doc.userProperties = {
		[PROPERTY_UUID]: {
			uuid: PROPERTY_UUID,
			slug: "is_supervisor",
			label: "Is a supervisor",
		},
	};
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const fieldUuid = doc.fieldOrder[formUuid][0];
	(doc.fields[fieldUuid] as { relevant?: unknown }).relevant =
		parseXPathForForm(doc, formUuid, "#user/is_supervisor = 'n'");
	return { doc, moduleUuid, fieldUuid };
}

describe("custom worker reference wire", () => {
	it("emits a hyphenated XML-safe slug byte-exact on every worker path", () => {
		const { doc } = workerReferenceDoc();
		doc.userProperties = {
			[PROPERTY_UUID]: {
				uuid: PROPERTY_UUID,
				slug: "district-code",
				label: "District code",
			},
		};
		const hq = expandDoc(doc);
		const hqXform = Object.values(hq._attachments)[0];
		if (hqXform === undefined) {
			throw new Error("expandDoc emitted no XForm attachment");
		}
		expect(hq.modules[0].module_filter).toBe(
			"instance('commcaresession')/session/user/data/district-code = 'n'",
		);
		expect(
			attributeWhere(
				hqXform,
				"bind",
				"relevant",
				(attributes) => attributes.nodeset === "/data/supervisor_note",
			),
		).toBe(`${USERCASE}/district-code = 'n'`);

		const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
		const localXform = zip.readAsText("modules-0/forms-0.xml");
		expect(
			attributeWhere(
				zip.readAsText("suite.xml"),
				"menu",
				"relevant",
				(attributes) => attributes.id === "m0",
			),
		).toBe("instance('commcaresession')/session/user/data/district-code = 'n'");
		expect(
			attributeWhere(
				localXform,
				"bind",
				"relevant",
				(attributes) => attributes.nodeset === "/data/supervisor_note",
			),
		).toBe(`${USERCASE}/district-code = 'n'`);
	});

	it("emits the named CCHQ session and usercase XPath shapes through HQ JSON, suite.xml, and XForm", () => {
		const { doc, moduleUuid, fieldUuid } = workerReferenceDoc();
		const hq = expandDoc(doc);
		const hqXform = Object.values(hq._attachments)[0];
		if (hqXform === undefined) {
			throw new Error("expandDoc emitted no XForm attachment");
		}
		const sessionCondition = `${SESSION_PROPERTY} = 'n'`;
		const usercaseCondition = `${USERCASE}/is_supervisor = 'n'`;

		// HQ JSON: exact output asserted by
		// test_suite_remote_request.py::RemoteRequestSuiteTest::test_required.
		expect(hq.modules[0].module_filter).toBe(sessionCondition);

		// HQ-upload XForm: the custom `#user/` identity expands through the
		// canonical usercase join pinned by
		// suite-case-detail-tabs-with-nodesets.xml.
		expect(
			attributeWhere(
				hqXform,
				"bind",
				"relevant",
				(attributes) => attributes.nodeset === "/data/supervisor_note",
			),
		).toBe(usercaseCondition);

		const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
		const suiteXml = zip.readAsText("suite.xml");
		const localXform = zip.readAsText("modules-0/forms-0.xml");
		expect(
			attributeWhere(
				suiteXml,
				"menu",
				"relevant",
				(attributes) => attributes.id === "m0",
			),
		).toBe(sessionCondition);
		expect(
			attributeWhere(
				localXform,
				"bind",
				"relevant",
				(attributes) => attributes.nodeset === "/data/supervisor_note",
			),
		).toBe(usercaseCondition);

		// Renaming changes only the emitted external spelling. Both stored AST
		// carriers keep the same object identity and continue targeting the
		// same worker-property UUID.
		const predicateAst = doc.modules[moduleUuid].displayCondition;
		const xpathAst = (doc.fields[fieldUuid] as { relevant?: unknown }).relevant;
		doc.userProperties = {
			[PROPERTY_UUID]: {
				uuid: PROPERTY_UUID,
				slug: "supervision_status",
				label: "Supervision status",
			},
		};
		const renamed = expandDoc(doc);
		expect(doc.modules[moduleUuid].displayCondition).toBe(predicateAst);
		expect((doc.fields[fieldUuid] as { relevant?: unknown }).relevant).toBe(
			xpathAst,
		);
		expect(renamed.modules[0].module_filter).toBe(
			"instance('commcaresession')/session/user/data/supervision_status = 'n'",
		);
		const renamedXform = Object.values(renamed._attachments)[0];
		if (renamedXform === undefined) {
			throw new Error("expandDoc emitted no renamed XForm attachment");
		}
		expect(
			attributeWhere(
				renamedXform,
				"bind",
				"relevant",
				(attributes) => attributes.nodeset === "/data/supervisor_note",
			),
		).toBe(`${USERCASE}/supervision_status = 'n'`);

		const renamedZip = new AdmZip(compileCcz(renamed, doc.appName, doc));
		expect(
			attributeWhere(
				renamedZip.readAsText("suite.xml"),
				"menu",
				"relevant",
				(attributes) => attributes.id === "m0",
			),
		).toBe(
			"instance('commcaresession')/session/user/data/supervision_status = 'n'",
		);
		expect(
			attributeWhere(
				renamedZip.readAsText("modules-0/forms-0.xml"),
				"bind",
				"relevant",
				(attributes) => attributes.nodeset === "/data/supervisor_note",
			),
		).toBe(`${USERCASE}/supervision_status = 'n'`);
	});

	it.skipIf(
		!existsSync(CCHQ_USERCASE_FIXTURE) || !existsSync(CCHQ_REQUIRED_TEST),
	)("keeps the literal authorities named by the plan present upstream", () => {
		const usercaseFixture = readFileSync(CCHQ_USERCASE_FIXTURE, "utf8");
		const remoteRequestTest = readFileSync(CCHQ_REQUIRED_TEST, "utf8");

		expect(usercaseFixture).toContain(`${USERCASE}/username]`);
		expect(remoteRequestTest).toContain(
			`instance('commcaresession')/session/user/data/is_supervisor = 'n'`,
		);
	});
});
