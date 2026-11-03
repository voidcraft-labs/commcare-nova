/** Structural regression checks on admitted documents; native links corpus owns HQ/Core acceptance. */

import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import type { HqApplication } from "@/lib/commcare";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { validateHqJson } from "@/lib/commcare/validator/hqJsonOracle";
import type { BlueprintDoc } from "@/lib/domain";
import {
	formLinkWireFixture,
	formLinkWireScenarios,
} from "./formLinkWireFixture";
import {
	admitNestedDoc,
	followupNestedDoc,
	nestSecondModule,
} from "./nestedMenuWireFixture";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { xpathEvidence } from "./xpathEvidence";

interface StackCreate {
	readonly ifClause: string | undefined;
	readonly children: readonly string[];
}

/** The `<create>` frames of the entry whose command id is `commandId`. */
function stackCreates(suite: string, commandId: string): StackCreate[] {
	const root = parseDocument(suite, { xmlMode: true });
	const entry = DomUtils.findOne(
		(node) =>
			node.name === "entry" &&
			DomUtils.findOne(
				(child) =>
					child.name === "command" &&
					DomUtils.getAttributeValue(child, "id") === commandId,
				node.children,
				false,
			) !== null,
		root.children,
		true,
	);
	if (entry === null) throw new Error(`no entry for ${commandId}`);
	return DomUtils.findAll((node) => node.name === "create", entry.children).map(
		(create) => ({
			ifClause: DomUtils.getAttributeValue(create, "if"),
			children: DomUtils.getChildren(create)
				.filter((child) => isTag(child))
				.map((child) =>
					child.name === "command"
						? `command:${DomUtils.getAttributeValue(child, "value")}`
						: `datum:${DomUtils.getAttributeValue(child, "id")}=${DomUtils.getAttributeValue(child, "value")}`,
				),
		}),
	);
}

function compile(doc: BlueprintDoc): { hq: HqApplication; suite: string } {
	const hq = expandDoc(doc);
	const zip = new AdmZip(
		compileCcz(hq, "Parity", doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
	);
	return { hq, suite: zip.readAsText("suite.xml") };
}

/** The `if` HQ's `_get_fallback_frame` writes over the `xpath`s it is sent:
 *  `' and '.join(f'not({condition})' for every non-blank condition)`. */
function hqFallbackIf(hq: HqApplication): string {
	return hq.modules[0].forms[0].form_links
		.map((link) => link.xpath)
		.filter((xpath) => xpath.trim() !== "")
		.map((xpath) => `not(${xpath})`)
		.join(" and ");
}

/** Each HQ link's `xpath` beside the local frame that link writes: equal
 *  byte for byte, the empty `xpath` as a frame with no `if`. */
function expectLinkFramesMatch(hq: HqApplication, creates: StackCreate[]) {
	const links = hq.modules[0].forms[0].form_links;
	expect(
		creates.slice(0, links.length).map((create) => create.ifClause),
	).toEqual(links.map((link) => (link.xpath === "" ? undefined : link.xpath)));
}

const ALICE =
	"instance('casedb')/casedb/case[@case_type = 'commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/username = 'alice'";
const HELD = (id: string) =>
	`count(instance('casedb')/casedb/case[@case_id = ${id} and @case_type = 'frog']) > 0`;
const NEW_FROG = "instance('commcaresession')/session/data/case_id_new_frog_0";
const VISIT_CARRYING_NEW = [
	"command:'m1'",
	`datum:case_id=${NEW_FROG}`,
	"command:'m1-f0'",
];

describe("form-link local wire structure (native HQ/Core proof owns compatibility)", () => {
	it.each(formLinkWireScenarios)(
		"the %s scenario's HQ JSON resolves every link and fallback",
		(scenario) => {
			expect(validateHqJson(expandDoc(formLinkWireFixture(scenario)))).toEqual(
				[],
			);
		},
	);

	it("HQ's oracle refuses a fallback beside links whose xpaths are all blank", () => {
		const hq = expandDoc(formLinkWireFixture("unconditional"));
		hq.modules[0].forms[0].post_form_workflow_fallback = "module";
		expect(validateHqJson(hq).map((error) => error.code)).toEqual([
			"HQJSON_BAD_POST_FORM_WORKFLOW_FALLBACK",
		]);
	});

	it("an otherwise link is one more link negating every destination, with no fallback", () => {
		const { hq, suite } = compile(formLinkWireFixture("else"));
		const form = hq.modules[0].forms[0];
		const creates = stackCreates(suite, "m0-f0");
		expect(form.post_form_workflow).toBe("form");
		expect(form.post_form_workflow_fallback).toBeNull();
		expect(form.form_links.map((link) => link.xpath)).toEqual([
			ALICE,
			`not(${ALICE})`,
		]);
		expectLinkFramesMatch(hq, creates);
		expect(creates).toHaveLength(2);
		// Frog care holds one followup, so its common datum prefix is the
		// whole [case_id]: a case-first frame, the selection hoisted ahead of
		// the form command and filled from the case this form creates.
		expect(creates[0].children).toEqual(VISIT_CARRYING_NEW);
		expect(creates[1].children).toEqual(["command:'m1'"]);
	});

	it("destinations are emitted in reverse author order, and a built-in otherwise is HQ's fallback frame", () => {
		const { hq, suite } = compile(formLinkWireFixture("chain"));
		const form = hq.modules[0].forms[0];
		const creates = stackCreates(suite, "m0-f0");
		// The author's first destination (Visit as alice) is pushed last, so
		// it runs first; the every-time menu is pushed first.
		expect(form.form_links.map((link) => link.xpath)).toEqual(["", ALICE]);
		expect(form.post_form_workflow_fallback).toBe("root");
		expectLinkFramesMatch(hq, creates);
		expect(creates.map((create) => create.children)).toEqual([
			["command:'m1'"],
			VISIT_CARRYING_NEW,
			[],
		]);
		// HQ's root fallback is an empty frame over the one non-blank xpath.
		expect(creates[2].ifClause).toBe(hqFallbackIf(hq));
		expect(creates[2].ifClause).toBe(`not(${ALICE})`);
	});

	it("each held-case guard joins its destination's condition, and the fallback negates every guarded xpath", () => {
		const { hq, suite } = compile(formLinkWireFixture("carried-held"));
		const form = hq.modules[0].forms[0];
		const creates = stackCreates(suite, "m0-f0");
		expect(form.form_links.map((link) => link.xpath)).toEqual([
			`${ALICE} and ${HELD(NEW_FROG)}`,
			HELD("'no-such-frog'"),
		]);
		expect(form.form_links.map((link) => link.datums)).toEqual([
			[{ name: "case_id", xpath: NEW_FROG }],
			[{ name: "case_id", xpath: "'no-such-frog'" }],
		]);
		expect(form.post_form_workflow_fallback).toBe("module");
		expectLinkFramesMatch(hq, creates);
		expect(creates).toHaveLength(3);
		expect(creates[2]).toEqual({
			ifClause: hqFallbackIf(hq),
			children: ["command:'m0'"],
		});
	});

	it("a carried literal alone guards an otherwise every-time destination", () => {
		const { hq, suite } = compile(formLinkWireFixture("manual"));
		const form = hq.modules[0].forms[0];
		expect(form.form_links.map((link) => link.xpath)).toEqual([
			HELD("'explicit-frog'"),
		]);
		expect(form.post_form_workflow_fallback).toBeNull();
		expectLinkFramesMatch(hq, stackCreates(suite, "m0-f0"));
	});

	it("written exclusivity stays in each condition, and the otherwise link negates both", () => {
		const { hq, suite } = compile(formLinkWireFixture("overlap"));
		const form = hq.modules[0].forms[0];
		const creates = stackCreates(suite, "m0-f0");
		const second = form.form_links[0].xpath;
		expect(form.form_links.map((link) => link.xpath)).toEqual([
			second,
			ALICE,
			`not(${second}) and not(${ALICE})`,
		]);
		expectLinkFramesMatch(hq, creates);
		expect(creates.map((create) => create.children)).toEqual([
			["command:'m1'"],
			VISIT_CARRYING_NEW,
			["command:'m0'"],
		]);
	});

	it("a conditional destination with a module otherwise adds HQ's fallback frame", () => {
		const { hq, suite } = compile(formLinkWireFixture("module"));
		const form = hq.modules[0].forms[0];
		const creates = stackCreates(suite, "m0-f0");
		expect(form.post_form_workflow_fallback).toBe("module");
		expect(creates).toHaveLength(2);
		expectLinkFramesMatch(hq, creates);
		expect(creates[1]).toEqual({
			ifClause: hqFallbackIf(hq),
			children: ["command:'m0'"],
		});
	});

	it("no otherwise is the app home: no fallback on either path", () => {
		const { hq, suite } = compile(formLinkWireFixture("home"));
		const form = hq.modules[0].forms[0];
		expect(form.post_form_workflow_fallback).toBeNull();
		expect(stackCreates(suite, "m0-f0")).toHaveLength(1);
	});

	it("a previous otherwise pushes the projected previous frame under HQ's fallback", () => {
		const { hq, suite } = compile(formLinkWireFixture("previous"));
		const form = hq.modules[0].forms[0];
		const creates = stackCreates(suite, "m0-f0");
		expect(form.post_form_workflow_fallback).toBe("previous_screen");
		expect(creates).toHaveLength(2);
		expect(creates[1].ifClause).toBe(hqFallbackIf(hq));
		expect(xpathEvidence(creates[1].ifClause ?? "")).toEqual(
			xpathEvidence(`not(${ALICE})`),
		);
		// Intake holds one registration form, so its function datum is the
		// module's common prefix: [m0, case_id_new_frog_0, m0-f0] → pop the
		// command → stop. The frame keeps the function datum, exactly as HQ's
		// `form_link_tdh_with_fallback_previous.xml` keeps
		// `case_id_new_visit_0=uuid()`.
		expect(creates[1].children).toEqual([
			"command:'m0'",
			"datum:case_id_new_frog_0=uuid()",
		]);
	});

	it("a sole unconditional link emits one unguarded frame and no fallback", () => {
		const { hq, suite } = compile(formLinkWireFixture("unconditional"));
		const form = hq.modules[0].forms[0];
		const creates = stackCreates(suite, "m0-f0");
		expect(form.form_links).toEqual([
			{ xpath: "", module_unique_id: hq.modules[1].unique_id, datums: [] },
		]);
		expect(form.post_form_workflow_fallback).toBeNull();
		expect(creates).toEqual([
			{ ifClause: undefined, children: ["command:'m1'"] },
		]);
	});

	it("start this form again names the source form in its own menu and opens a new registration", () => {
		const { hq, suite } = compile(formLinkWireFixture("this-form"));
		const form = hq.modules[0].forms[0];
		expect(form.form_links).toEqual([
			{
				xpath: "",
				form_id: form.unique_id,
				form_module_id: hq.modules[0].unique_id,
				datums: [],
			},
		]);
		expect(stackCreates(suite, "m0-f0")).toEqual([
			{
				ifClause: undefined,
				children: [
					"command:'m0'",
					"datum:case_id_new_frog_0=uuid()",
					"command:'m0-f0'",
				],
			},
		]);
	});

	it("a firstMenu destination is HQ's root: one empty frame", () => {
		const doc = followupNestedDoc({ sameCaseType: true });
		const { root } = nestSecondModule(doc);
		const form = doc.formOrder[root][0];
		doc.forms[form].postSubmit = "firstMenu";
		admitNestedDoc(doc);
		const { hq, suite } = compile(doc);
		expect(hq.modules[0].forms[0].post_form_workflow).toBe("root");
		expect(stackCreates(suite, "m0-f0")).toEqual([
			{ ifClause: undefined, children: [] },
		]);
	});

	it("a parentMenu destination is HQ's parent_module: the parent's frame with its selection", () => {
		const doc = followupNestedDoc({ sameCaseType: true });
		const { childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("fixture child has no form");
		doc.forms[childForm].postSubmit = "parentMenu";
		admitNestedDoc(doc);
		const { hq, suite } = compile(doc);
		expect(hq.modules[1].root_module_id).toBe(hq.modules[0].unique_id);
		expect(hq.modules[1].forms[0].post_form_workflow).toBe("parent_module");
		expect(stackCreates(suite, "m1-f0")).toEqual([
			{
				ifClause: undefined,
				children: [
					"command:'m0'",
					"datum:case_id=instance('commcaresession')/session/data/case_id",
				],
			},
		]);
	});
});
