/**
 * The no-matches registration form on the wire.
 *
 * Oracles, all in `~/code/commcare-hq` (the binding facts live in
 * `docs/plans/complex-app-plan.md` § Register when nothing matches):
 *
 *   - `tests/data/case_list_form/case-list-form-suite.xml`: the Register
 *     `<action>` on `m0_case_short` (display, push with the target command,
 *     the new-case datum, `return_to`).
 *   - `tests/test_case_list_form.py`: the `relevant` attribute the action
 *     carries under `FOLLOWUP_FORMS_AS_CASE_LIST_FORM`.
 *   - `suite_xml/post_process/workflow.py::CaseListFormWorkflow`: the
 *     return frame (`<create if="…return_to = 'm0'">` with the host command
 *     and the results query re-keyed to the new case id).
 *   - `suite_xml/sections/menus.py::_generate_menu`: `module_filter` →
 *     `<menu relevant>`.
 *   - `post_process/instances.py::search_input_instances`: the XForm's
 *     `jr://instance/search-input/results:inline` declaration.
 */

import AdmZip from "adm-zip";
import { type ChildNode, type Element, isTag } from "domhandler";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { emissionPlan, syntheticModuleUuid } from "@/lib/commcare/emissionPlan";
import { expandDoc } from "@/lib/commcare/expander";
import { CASE_FIXTURE_URL_TEMPLATE } from "@/lib/commcare/formLinkProjection";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { simpleSearchInputDef } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

// ── Structural comparison ────────────────────────────────────────────

interface Shape {
	readonly name: string;
	readonly attribs: Readonly<Record<string, string>>;
	readonly children: readonly Shape[];
}

function shapeOf(element: Element): Shape {
	return {
		name: element.name,
		attribs: Object.fromEntries(
			Object.entries(element.attribs).sort(([a], [b]) => a.localeCompare(b)),
		),
		children: element.children.filter(isTag).map(shapeOf),
	};
}

function elementsOf(nodes: readonly ChildNode[]): Element[] {
	return nodes.filter(isTag);
}

function parseXml(xml: string): Element[] {
	return elementsOf(parseDocument(xml, { xmlMode: true }).children);
}

function childrenNamed(parent: Element, name: string): Element[] {
	return elementsOf(parent.children).filter((child) => child.name === name);
}

function expectPartialEqual(actual: Element, expectedPartial: string): void {
	const [partial] = parseXml(expectedPartial);
	const [expected] = elementsOf(partial.children);
	expect(shapeOf(actual)).toEqual(shapeOf(expected));
}

// ── The app ─────────────────────────────────────────────────────────

const HOST_MODULE = testUuid("00000000-0000-4000-8000-0000000b0010");
const FOLLOWUP_FORM = testUuid("00000000-0000-4000-8000-0000000b0011");
const REGISTER_FORM = testUuid("00000000-0000-4000-8000-0000000b0012");
const NAME_INPUT = testUuid("00000000-0000-4000-8000-0000000b0001");
const NAME_FIELD = testUuid("00000000-0000-4000-8000-0000000b0020");
const HOUSEHOLD_MODULE = testUuid("00000000-0000-4000-8000-0000000b0030");

/**
 * A search-first "Patients" module with one prompt `patient_name`, one
 * followup menu form, and one no-matches registration form whose name
 * field defaults to `#search/patient_name`.
 */
function noMatchesDoc(
	options: { readonly label?: string; readonly caseListOnly?: boolean } = {},
): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(
			NAME_INPUT,
			"patient_name",
			"Patient name",
			"text",
			"case_name",
		),
	];
	const registerForm = {
		uuid: REGISTER_FORM,
		name: "Register patient",
		type: "registration" as const,
		entry: {
			kind: "search-no-matches" as const,
			...(options.label !== undefined && { label: options.label }),
		},
		fields: [
			f({
				uuid: NAME_FIELD,
				kind: "text",
				id: "case_name",
				label: proseText("Name"),
				caseWrite: { caseType: "patient", property: "case_name" },
				default_value: {
					parts: [{ kind: "search-answer-ref", searchInputUuid: NAME_INPUT }],
				},
			}),
		],
	};
	return buildDoc({
		appName: "Registry",
		modules: [
			{
				uuid: HOST_MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				caseSearchConfig: { searchFirst: true },
				...(options.caseListOnly === true
					? { caseListOnly: true, forms: [registerForm] }
					: {
							forms: [
								{
									uuid: FOLLOWUP_FORM,
									name: "Visit",
									type: "followup" as const,
									fields: [
										f({
											kind: "text",
											id: "note",
											label: proseText("Note"),
										}),
									],
								},
								registerForm,
							],
						}),
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
}

function compileSuite(doc: BlueprintDoc): {
	suite: Element;
	xform: (path: string) => string;
} {
	const ccz = compileCcz(expandDoc(doc), "Registry", doc);
	const zip = new AdmZip(ccz);
	const [suite] = parseXml(zip.readAsText("suite.xml"));
	return { suite, xform: (path) => zip.readAsText(path) };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("no-matches registration form", () => {
	it("passes the validator with the entry set on a search-first host", () => {
		const doc = noMatchesDoc();
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("lowers the form into a hidden module after every authored module", () => {
		const plan = emissionPlan(noMatchesDoc());
		const hidden = syntheticModuleUuid(REGISTER_FORM);
		expect(plan.doc.moduleOrder).toEqual([HOST_MODULE, hidden]);
		expect(plan.doc.formOrder[HOST_MODULE]).toEqual([FOLLOWUP_FORM]);
		expect(plan.doc.formOrder[hidden]).toEqual([REGISTER_FORM]);
		expect(plan.doc.modules[hidden]?.caseType).toBe("patient");
		expect(plan.doc.modules[hidden]?.caseListConfig).toBeUndefined();
	});

	it("mounts the Register action on the host's case list (case-list-form-suite.xml + test_case_list_form.py relevant)", () => {
		const { suite } = compileSuite(noMatchesDoc());
		const detail = childrenNamed(suite, "detail").find(
			(candidate) => candidate.attribs.id === "m0_case_short",
		);
		if (detail === undefined) throw new Error("no m0_case_short");
		const [action] = childrenNamed(detail, "action");
		expectPartialEqual(
			action,
			`<partial>
			<action relevant="count(instance('results:inline')/results/case) = 0">
				<display>
					<text>
						<locale id="case_list_form.m0"/>
					</text>
				</display>
				<stack>
					<push>
						<command value="'m1-f0'"/>
						<datum id="case_id_new_patient_0" value="uuid()"/>
						<datum id="return_to" value="'m0'"/>
					</push>
				</stack>
			</action>
			</partial>`,
		);
		// Only the hidden module's detail-less form is left: no second action.
		expect(childrenNamed(detail, "action")).toHaveLength(1);
	});

	it("hides the module and returns to the host's Results showing the new case (CaseListFormWorkflow)", () => {
		const { suite } = compileSuite(noMatchesDoc());
		const menus = childrenNamed(suite, "menu");
		expect(menus.map((menu) => menu.attribs.id)).toEqual(["m0", "m1"]);
		expect(menus[0].attribs.relevant).toBeUndefined();
		expect(menus[1].attribs.relevant).toBe("false()");
		expect(
			childrenNamed(menus[1], "command").map((command) => command.attribs.id),
		).toEqual(["m1-f0"]);
		// The host menu lists only its menu form.
		expect(
			childrenNamed(menus[0], "command").map((command) => command.attribs.id),
		).toEqual(["m0-f0"]);

		const entry = childrenNamed(suite, "entry").find((candidate) =>
			childrenNamed(candidate, "command").some(
				(command) => command.attribs.id === "m1-f0",
			),
		);
		if (entry === undefined) throw new Error("no m1-f0 entry");
		const [stack] = childrenNamed(entry, "stack");
		expectPartialEqual(
			stack,
			`<partial>
			<stack>
				<create if="count(instance('commcaresession')/session/data/return_to) = 1 and instance('commcaresession')/session/data/return_to = 'm0'">
					<command value="'m0'"/>
					<query id="results:inline" value="${CASE_FIXTURE_URL_TEMPLATE}">
						<data key="case_type" ref="'patient'"/>
						<data key="case_id" ref="instance('commcaresession')/session/data/case_id_new_patient_0"/>
					</query>
				</create>
			</stack>
			</partial>`,
		);
		// No detail is emitted for the hidden module.
		expect(
			childrenNamed(suite, "detail").map((detail) => detail.attribs.id),
		).toEqual(["m0_case_short", "m0_case_long"]);
	});

	it("declares the search-input instance and reads the answer in the XForm", () => {
		const { xform } = compileSuite(noMatchesDoc());
		const form = xform("modules-1/forms-0.xml");
		expect(form).toContain(
			'<instance src="jr://instance/search-input/results:inline" id="search-input:results:inline"/>',
		);
		// The serializer spells the quotes as `&apos;`.
		expect(form).toContain(
			'value="instance(&apos;search-input:results:inline&apos;)/input/field[@name=&apos;patient_name&apos;]"',
		);
		expect(form).not.toContain("#search/");
	});

	it("labels the action from the entry label, else the form name", () => {
		const labelled = compileSuite(noMatchesDoc({ label: "Add a new patient" }));
		const named = compileSuite(noMatchesDoc());
		const strings = (suite: { xform: (path: string) => string }) =>
			suite.xform("default/app_strings.txt");
		expect(strings(labelled)).toContain("case_list_form.m0=Add a new patient");
		expect(strings(named)).toContain("case_list_form.m0=Register patient");
	});

	it("emits case_list_form on the host and a hidden module in HQ JSON", () => {
		const hq = expandDoc(noMatchesDoc({ label: "Add a new patient" }));
		expect(hq.modules).toHaveLength(2);
		const [host, hidden] = hq.modules;
		expect(host.case_list_form).toEqual({
			doc_type: "CaseListForm",
			form_id: hidden.forms[0].unique_id,
			label: { en: "Add a new patient" },
			post_form_workflow: "case_list",
			relevancy_expression:
				"count(instance('results:inline')/results/case) = 0",
		});
		expect(host.forms).toHaveLength(1);
		expect(hidden.module_filter).toBe("false()");
		expect(hidden.case_type).toBe("patient");
		expect(hidden.forms).toHaveLength(1);
		expect(hidden.forms[0].name).toEqual({ en: "Register patient" });
		expect(hidden.case_list_form.form_id).toBeNull();
	});

	it("copies a parent selection from the host's first menu form (case-list-form-suite-parent-child-basic.xml)", () => {
		const base = noMatchesDoc();
		const doc: BlueprintDoc = {
			...base,
			modules: {
				...base.modules,
				[HOUSEHOLD_MODULE]: {
					...base.modules[HOST_MODULE],
					uuid: HOUSEHOLD_MODULE,
					id: "households",
					name: "Households",
					caseListOnly: true,
					caseType: "household",
					caseSearchConfig: undefined,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				},
			},
			moduleOrder: [...base.moduleOrder, HOUSEHOLD_MODULE],
			formOrder: { ...base.formOrder, [HOUSEHOLD_MODULE]: [] },
			caseTypes: [
				...(base.caseTypes ?? []).map((caseType) =>
					caseType.name === "patient"
						? { ...caseType, parent_type: "household" }
						: caseType,
				),
				{
					name: "household",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
		};
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const { suite } = compileSuite(doc);
		const detail = childrenNamed(suite, "detail").find(
			(candidate) => candidate.attribs.id === "m0_case_short",
		);
		if (detail === undefined) throw new Error("no m0_case_short");
		const [action] = childrenNamed(detail, "action");
		const [stack] = childrenNamed(action, "stack");
		const [push] = childrenNamed(stack, "push");
		// HQ `get_datums_for_action`: the target's parent selection reads the
		// session value of the host's first menu form's datum of that case
		// type; the new-case datum keeps its function.
		expect(
			elementsOf(push.children).map((child) => [
				child.name,
				child.attribs.id ?? child.attribs.value,
				child.attribs.id === undefined ? undefined : child.attribs.value,
			]),
		).toEqual([
			["command", "'m2-f0'", undefined],
			[
				"datum",
				"case_id",
				"instance('commcaresession')/session/data/parent_id",
			],
			["datum", "case_id_new_patient_0", "uuid()"],
			["datum", "return_to", "'m0'"],
		]);
	});

	it("still lowers on a bare case list host, with a bare return frame", () => {
		const doc = noMatchesDoc({ caseListOnly: true });
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const { suite } = compileSuite(doc);
		const entry = childrenNamed(suite, "entry").find((candidate) =>
			childrenNamed(candidate, "command").some(
				(command) => command.attribs.id === "m1-f0",
			),
		);
		if (entry === undefined) throw new Error("no m1-f0 entry");
		const [stack] = childrenNamed(entry, "stack");
		const [create] = childrenNamed(stack, "create");
		// HQ's `get_module_datums` reads form entries only, so a formless
		// host contributes no common datums: the frame is the command alone.
		expect(elementsOf(create.children).map((child) => child.name)).toEqual([
			"command",
		]);
	});
});
