/**
 * The no-matches registration form on the wire.
 *
 * Oracles, all in `~/code/commcare-hq` (the binding facts live in
 * `docs/architecture/complex-apps.md` § Register when nothing matches):
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
import { textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { emissionPlan, syntheticModuleUuid } from "@/lib/commcare/emissionPlan";
import { expandDoc } from "@/lib/commcare/expander";
import { CASE_FIXTURE_URL_TEMPLATE } from "@/lib/commcare/formLinkProjection";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import {
	admitNoMatchesDoc,
	FOLLOWUP_FORM,
	HOST_MODULE,
	noMatchesDoc,
	noMatchesWireFixture,
	REGISTER_FORM,
} from "./noMatchesWireFixture";

// ── Structural comparison ────────────────────────────────────────────

interface Shape {
	readonly name: string;
	readonly text: string;
	readonly attribs: Readonly<Record<string, string>>;
	readonly children: readonly Shape[];
}

function shapeOf(element: Element): Shape {
	return {
		name: element.name,
		text: element.children.some(isTag) ? "" : textContent(element),
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

function compileSuite(doc: BlueprintDoc): {
	suite: Element;
	xform: (path: string) => string;
} {
	admitNoMatchesDoc(doc);
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
		const nodes = (e: Element): Element[] => [
			e,
			...e.children.filter(isTag).flatMap(nodes),
		];
		const all = parseXml(form).flatMap(nodes);
		expect(
			all
				.filter(
					(e) =>
						e.name === "instance" &&
						e.attribs.id === "search-input:results:inline",
				)
				.map((e) => e.attribs.src),
		).toEqual(["jr://instance/search-input/results:inline"]);
		expect(
			all
				.filter(
					(e) => e.name === "setvalue" && e.attribs.ref === "/data/case_name",
				)
				.map((e) => e.attribs.value),
		).toEqual([
			"instance('search-input:results:inline')/input/field[@name='patient_name']",
		]);
	});

	it("labels the action from the entry label, else the form name", () => {
		const labelled = compileSuite(noMatchesDoc({ label: "Add a new patient" }));
		const named = compileSuite(noMatchesDoc());
		const strings = (suite: { xform: (path: string) => string }) =>
			suite.xform("default/app_strings.txt");
		expect(
			strings(labelled)
				.split("\n")
				.filter((line) => line.startsWith("case_list_form.m0=")),
		).toEqual(["case_list_form.m0=Add a new patient"]);
		expect(
			strings(named)
				.split("\n")
				.filter((line) => line.startsWith("case_list_form.m0=")),
		).toEqual(["case_list_form.m0=Register patient"]);
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

	it("keeps primary registration free of a catalog parent load", () => {
		const doc = noMatchesWireFixture("parent");
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const { suite } = compileSuite(doc);
		const detail = childrenNamed(suite, "detail").find(
			(candidate) => candidate.attribs.id === "m0_case_short",
		);
		if (detail === undefined) throw new Error("no m0_case_short");
		const [action] = childrenNamed(detail, "action");
		const [stack] = childrenNamed(action, "stack");
		const [push] = childrenNamed(stack, "push");
		// Native HQ imports this exact app as requires:none/open_case; the
		// catalog relationship does not turn primary registration into subcase creation.
		expect(
			elementsOf(push.children).map((child) => [
				child.name,
				child.attribs.id ?? child.attribs.value,
				child.attribs.id === undefined ? undefined : child.attribs.value,
			]),
		).toEqual([
			["command", "'m2-f0'", undefined],
			["datum", "case_id_new_patient_0", "uuid()"],
			["datum", "return_to", "'m0'"],
		]);
	});

	it("admits primary registration on a bare parent-scoped search", () => {
		const doc = noMatchesWireFixture("parent-bare"),
			{ suite } = compileSuite(doc);
		const entry = childrenNamed(suite, "entry").find((e) =>
			childrenNamed(e, "command").some((c) => c.attribs.id === "m2-f0"),
		);
		if (!entry) throw new Error("Missing registration entry");
		expect(
			childrenNamed(childrenNamed(entry, "session")[0], "datum").map(
				(e) => e.attribs.id,
			),
		).toEqual(["case_id_new_patient_0"]);
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

describe("explicit no-matches App home", () => {
	it.each([false, true])(
		"uses HQ root and an empty local create frame (multiple=%s)",
		(multiple) => {
			const doc = noMatchesDoc();
			doc.forms[REGISTER_FORM].postSubmit = "app_home";
			if (multiple)
				doc.modules[HOST_MODULE].caseListConfig = {
					...(doc.modules[HOST_MODULE].caseListConfig ?? caseListConfig([])),
					selection: { kind: "multiple", maximum: 5 },
				};
			const hq = expandDoc(doc);
			expect(hq.modules.at(-1)?.forms[0].post_form_workflow).toBe("root");
			const { suite } = compileSuite(doc);
			const entry = childrenNamed(suite, "entry").find((entry) =>
				childrenNamed(entry, "command").some(
					(command) => command.attribs.id === "m1-f0",
				),
			);
			expect(entry).toBeDefined();
			if (!entry) throw new Error("Missing registration entry");
			const stack = childrenNamed(entry, "stack")[0];
			const creates = childrenNamed(stack, "create");
			expect(creates).toHaveLength(1);
			expect(creates[0].attribs).toEqual({});
			expect(creates[0].children).toEqual([]);
		},
	);
});
