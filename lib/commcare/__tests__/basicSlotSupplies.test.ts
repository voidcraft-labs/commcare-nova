/**
 * A form's entry gives a session value to the case a registration creates
 * only where its own arm takes Case Management's slot, and to a child it
 * creates at the root only where that create takes a basic subcase slot
 * (`suite_xml/sections/entries.py::EntriesHelper.get_new_case_id_datums_meta`).
 * The checker's supplies and the wire's datums read one eligibility
 * (`lib/domain/basicCaseSlots.ts`). Catches a read the checker admits of a
 * datum the entry does not declare, which the emitter cannot print.
 */
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { planFormCaseWire } from "@/lib/commcare/casePlacementPlan";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { planPlacements } from "@/lib/commcare/placement";
import { caseListRegistrationForm } from "@/lib/commcare/validator/rules/case-search/caseListRegistration";
import { runValidation } from "@/lib/commcare/validator/runner";
import { buildXForm } from "@/lib/commcare/xform/builder";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type CaseOperation,
	type DatumRef,
	datumRefKey,
	entryDatumSupplies,
	proseText,
	type Uuid,
} from "@/lib/domain";
import {
	concat,
	formField,
	gt,
	literal,
	term,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { checkCompilerEvidence } from "./compilerEvidence";
import { expectEntryDatumAgreement } from "./entryDatumAgreement";
import { asBasicModule } from "./hqBasicShape";
import {
	childCreate,
	OP,
	OWN,
	own,
	placementFixture,
	read,
	U,
} from "./placementFixture";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

const over18: Expression = gt(read("age"), literal(18));

function supplied(doc: BlueprintDoc, formUuid: Uuid, moduleUuid: Uuid) {
	return entryDatumSupplies(doc, {
		kind: "form",
		module: moduleUuid,
		form: formUuid,
	}).refs.map(({ ref }) => datumRefKey(ref));
}

/** The fixture's hidden question calculated by `expression`. */
function calculated(doc: BlueprintDoc, expression: Expression): void {
	const flag = doc.fields[U("flag")];
	if (flag?.kind !== "hidden")
		throw new Error("The fixture has a hidden flag.");
	doc.fields[U("flag")] = { ...flag, calculate: expression };
}

function sessionRead(datum: DatumRef): Expression {
	return { kind: "term", term: { kind: "session-datum", datum } };
}

function sessionFindings(doc: BlueprintDoc) {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
		(finding) =>
			finding.code === "SESSION_DATUM_NOT_SUPPLIED" &&
			finding.location.fieldUuid === U("flag"),
	);
}

function elements(node: { children: unknown[] }): Element[] {
	return (node.children as Element[])
		.filter(isTag)
		.flatMap((child) => [child, ...elements(child)]);
}

describe("a registration whose own arm takes Save to Case", () => {
	const fixture = () =>
		placementFixture("registration", {
			operations: () => [own({ name: read("name") })],
			form: { openCondition: over18 },
		});

	it("gives its new case no session value, as HQ's entry gives none", () => {
		const { doc, formUuid, moduleUuid } = fixture();
		expect(
			planPlacements(doc, formUuid).placements.get(OWN)?.placement.kind,
		).toBe("save-to-case");
		expect(planFormCaseWire(doc, formUuid).datums).toEqual([]);
		expect(supplied(doc, formUuid, moduleUuid)).not.toContain(
			datumRefKey({ kind: "new-case" }),
		);
		expectEntryDatumAgreement(doc);
	});

	it("refuses a read of the new case's id instead of printing an undeclared datum", () => {
		const { doc } = fixture();
		calculated(doc, {
			kind: "term",
			term: { kind: "form-case", caseType: "patient", property: "case_id" },
		});
		const findings = sessionFindings(doc);
		expect(findings).toHaveLength(1);
		expect(findings[0].details).toMatchObject({
			reason: "own-case-save-to-case",
		});
	});

	it("refuses a session read of the new case", () => {
		const { doc } = fixture();
		calculated(doc, sessionRead({ kind: "new-case" }));
		expect(sessionFindings(doc)).toHaveLength(1);
	});

	it("reads its own block's id in a close block of its own, never a datum", () => {
		const { doc, formUuid } = placementFixture("registration", {
			operations: () => [own({ name: read("name") })],
			form: {
				openCondition: over18,
				closeCondition: read("flag"),
				ownClosePlacement: {
					kind: "save-to-case",
					path: ["nova_operations", "nova_condition_close", "nova_close"],
				},
			},
		});
		expect(
			planPlacements(doc, formUuid).placements.get("own-close")?.held,
		).toBe(true);
		const xml = buildXForm(doc, formUuid, {
			xmlns: "http://openrosa.org/formdesigner/own-close-block",
			moduleCaseType: "patient",
		});
		const closeId = elements(parseDocument(xml, { xmlMode: true })).find(
			(element) =>
				element.name === "bind" &&
				element.attribs.nodeset?.endsWith("/nova_close/case/@case_id"),
		)?.attribs.calculate;
		expect(closeId).toBeDefined();
		expect(closeId).not.toContain("case_id_new_");
		expect(closeId).toContain("/case/@case_id");
	});

	it("is refused as a form opened after a search finds nothing", () => {
		const { doc, formUuid, moduleUuid } = fixture();
		const host = {
			...doc.modules[moduleUuid],
			caseListRegistrationForm: {
				kind: "after-empty-search" as const,
				formUuid,
			},
		};
		const findings = caseListRegistrationForm(host, moduleUuid, {
			...doc,
			modules: { ...doc.modules, [moduleUuid]: host },
		}).filter((f) => f.code === "CASE_LIST_REGISTRATION_NOT_REGISTRATION");
		expect(findings).toHaveLength(1);
		expect(findings[0].details).toEqual({
			formUuid,
			formName: doc.forms[formUuid]?.name,
			reason: "own-case-save-to-case",
		});
	});
});

describe("a registration named by a computed value", () => {
	const FIRST = testUuid("computed-name-first");
	const LAST = testUuid("computed-name-last");

	/** A plain `patient` app whose one registration names its case
	 *  `concat(first, ' ', last)`, which keeps the own arm off Case
	 *  Management, so a Save to Case block creates the case. */
	function computedNameDoc(): BlueprintDoc {
		const doc = buildDoc({
			appName: "Computed name",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "computed-name-form",
							name: "Register",
							type: "registration",
							fields: [
								f({ uuid: "computed-name-first", kind: "text", id: "first" }),
								f({ uuid: "computed-name-last", kind: "text", id: "last" }),
							],
						},
					],
				},
			],
		});
		const formUuid = testUuid("computed-name-form");
		const form = doc.forms[formUuid];
		doc.forms[formUuid] = {
			...form,
			caseOperations: (form.caseOperations ?? []).map((operation) =>
				operation.action === "own"
					? ({
							...operation,
							name: concat(
								term(formField(FIRST)),
								term(literal(" ")),
								term(formField(LAST)),
							),
						} as CaseOperation)
					: operation,
			),
		};
		return doc;
	}

	it("creates its case in its own block, with no update HQ's build refuses and no undeclared datum", () => {
		const doc = computedNameDoc();
		const formUuid = testUuid("computed-name-form");
		const ownUuid = doc.forms[formUuid].caseOperations?.[0]?.uuid;
		expect(ownUuid).toBeDefined();
		expect(
			planPlacements(doc, formUuid).placements.get(ownUuid as Uuid)?.placement
				.kind,
		).toBe("save-to-case");
		// Every oracle, the binding oracle over the local archive included.
		checkCompilerEvidence(doc);

		const hq = expandDoc(doc);
		const hqForm = asBasicModule(hq.modules[0]).forms[0];
		expect(hqForm.requires).toBe("none");
		expect(hqForm.actions.open_case.condition.type).toBe("never");
		expect(hqForm.actions.update_case.condition.type).toBe("never");

		// The local archive holds the Save to Case block and no form-level
		// `case` block reading a session case.
		const zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		);
		const local = zip.readAsText("modules-0/forms-0.xml");
		const data = elements(parseDocument(local, { xmlMode: true })).find(
			(element) => element.name === "data",
		);
		expect(data).toBeDefined();
		expect(
			(data as Element).children.filter(isTag).map((child) => child.name),
		).not.toContain("case");
		expect(local).not.toContain("session/data/case_id");
		expect(local).toContain("nova_operations");
	});
});

describe("a root child the entry gives no session value", () => {
	const kidRead = sessionRead({ kind: "new-child-case", caseType: "kid" });
	const cases: readonly {
		readonly name: string;
		readonly formType: "registration" | "followup";
		readonly operations: (t: "registration" | "followup") => CaseOperation[];
		readonly form?: { readonly openCondition: Expression };
	}[] = [
		{
			name: "a create under a condition Case Management can't state",
			formType: "followup",
			operations: (t) => [
				own(),
				childCreate("kid", t, { condition: gt(read("age"), literal(2)) }),
			],
		},
		{
			name: "a child of a registration whose own arm is not basic",
			formType: "registration",
			operations: (t) => [own({ name: read("name") }), childCreate("kid", t)],
			form: { openCondition: over18 },
		},
		{
			name: "a root create named by a question in a repeat",
			formType: "followup",
			operations: (t) => [
				own(),
				childCreate("kid", t, { name: read("kid_name") }),
			],
		},
		{
			name: "a create a later change updates",
			formType: "followup",
			operations: (t) => [
				own(),
				childCreate("kid", t),
				{
					uuid: OP("touch"),
					id: "touch",
					action: "update",
					caseType: "kid",
					target: { kind: "op", opUuid: OP("kid") },
					writes: [{ property: "age", value: read("age") }],
				} as CaseOperation,
			],
		},
		{
			name: "a stale held subcase slot",
			formType: "followup",
			operations: (t) => [
				own(),
				childCreate("kid", t, {
					condition: gt(read("age"), literal(2)),
					placement: { kind: "basic", slot: "subcase", index: 0 },
				}),
			],
		},
	];
	it.each(cases)("$name", ({ formType, operations, form }) => {
		const { doc, formUuid, moduleUuid } = placementFixture(formType, {
			operations: (t) => operations(t as "registration" | "followup"),
			...(form !== undefined && { form }),
		});
		expect(
			planFormCaseWire(doc, formUuid).datums.map((d) => d.ref),
		).not.toContainEqual({ kind: "new-child-case", caseType: "kid" });
		expect(supplied(doc, formUuid, moduleUuid)).not.toContain(
			datumRefKey({ kind: "new-child-case", caseType: "kid" }),
		);
		expectEntryDatumAgreement(doc);
		calculated(doc, kidRead);
		expect(sessionFindings(doc)).toHaveLength(1);
	});

	it("still gives an eligible root child its session value", () => {
		const { doc, formUuid, moduleUuid } = placementFixture("followup", {
			operations: (t) => [own(), childCreate("kid", t)],
		});
		expect(supplied(doc, formUuid, moduleUuid)).toContain(
			datumRefKey({ kind: "new-child-case", caseType: "kid" }),
		);
		expectEntryDatumAgreement(doc);
		calculated(doc, kidRead);
		expect(sessionFindings(doc)).toEqual([]);
	});
});
