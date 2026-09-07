/** Structural regression checks on admitted documents; native links corpus owns HQ/Core acceptance. */

import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import type { HqApplication } from "@/lib/commcare";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type { BlueprintDoc } from "@/lib/domain";
import { formLinkWireFixture } from "./formLinkWireFixture";

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
	const zip = new AdmZip(compileCcz(hq, "Parity", doc));
	return { hq, suite: zip.readAsText("suite.xml") };
}

describe("form-link local wire structure (native HQ/Core proof owns compatibility)", () => {
	it("emits exclusive conditions and carries the created case into the linked form", () => {
		const doc = formLinkWireFixture("else");
		const { hq, suite } = compile(doc);
		const form = hq.modules[0].forms[0];
		const creates = stackCreates(suite, "m0-f0");

		expect(form.post_form_workflow).toBe("form");
		expect(form.post_form_workflow_fallback).toBeNull();
		expect(form.form_links.map((link) => link.xpath)).toEqual([
			creates[0].ifClause,
			// The else link's guard is the negated prior — HQ receives it as
			// the link's xpath and emits the same frame guard.
			creates[1].ifClause,
		]);
		expect(creates).toHaveLength(2);
		// Frog care holds one followup, so its common datum prefix is the
		// whole [case_id]: a case-first frame, the selection hoisted ahead of
		// the form command and filled from the case this form creates.
		expect(creates[0].children).toEqual([
			"command:'m1'",
			"datum:case_id=instance('commcaresession')/session/data/case_id_new_frog_0",
			"command:'m1-f0'",
		]);
		expect(creates[1].children).toEqual(["command:'m1'"]);
	});

	it("a conditional-only list with a module fallback adds HQ's fallback frame", () => {
		const doc = formLinkWireFixture("module");
		const { hq, suite } = compile(doc);
		const form = hq.modules[0].forms[0];
		const creates = stackCreates(suite, "m0-f0");

		expect(form.post_form_workflow_fallback).toBe("module");
		expect(creates).toHaveLength(2);
		expect(creates[0].ifClause).toBe(form.form_links[0].xpath);
		expect(creates[1].ifClause).toBe(
			"not(instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/username = 'alice')",
		);
		expect(creates[1].children).toEqual(["command:'m0'"]);
	});

	it("an app_home fallback is HQ's `default`: no frame on either path", () => {
		const doc = formLinkWireFixture("home");
		const { hq, suite } = compile(doc);
		const form = hq.modules[0].forms[0];
		expect(form.post_form_workflow_fallback).toBe("default");
		expect(stackCreates(suite, "m0-f0")).toHaveLength(1);
	});

	it("a previous fallback pushes the projected previous frame under HQ's guard", () => {
		const doc = formLinkWireFixture("previous");
		const { hq, suite } = compile(doc);
		const form = hq.modules[0].forms[0];
		const creates = stackCreates(suite, "m0-f0");
		expect(form.post_form_workflow_fallback).toBe("previous_screen");
		expect(creates).toHaveLength(2);
		expect(creates[1].ifClause).toBe(
			"not(instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/username = 'alice')",
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
		const doc = formLinkWireFixture("unconditional");
		const { hq, suite } = compile(doc);
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
});
