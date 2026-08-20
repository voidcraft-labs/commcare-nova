/**
 * Local-suite ↔ HQ-JSON parity for after-submit links. One document,
 * both emitters: every `<create if>` on the local entry equals the
 * `form_links[i].xpath` HQ receives, and the fallback frame's `if` is the
 * join HQ's `_get_fallback_frame` derives from those xpaths — present
 * exactly when `post_form_workflow_fallback` names a frame-producing
 * workflow.
 */

import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { HqApplication } from "@/lib/commcare";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, PostSubmitDestination } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

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

/** HQ's `_get_fallback_frame` literal over the sent xpaths. */
function hqFallbackGuard(hq: HqApplication, m: number, fi: number): string {
	return hq.modules[m].forms[fi].form_links
		.map((link) => link.xpath)
		.filter((xpath) => xpath.trim().length > 0)
		.map((xpath) => `not(${xpath})`)
		.join(" and ");
}

const CARE = testUuid("mod-care");
const VISIT = testUuid("frm-visit");

function parityDoc(
	postSubmit: PostSubmitDestination | undefined,
	links: "conditional-then-else" | "conditional-only" | "unconditional",
): BlueprintDoc {
	const nameWriter = () =>
		f({
			kind: "text",
			id: "case_name",
			label: proseText("Name"),
			caseWrite: { caseType: "frog", property: "case_name" },
		});
	const conditional = {
		uuid: "lnk-cond",
		condition: "#user/username = 'alice'",
		target: { type: "form" as const, moduleUuid: CARE, formUuid: VISIT },
	};
	const unconditional = {
		uuid: "lnk-else",
		target: { type: "module" as const, moduleUuid: CARE },
	};
	return buildDoc({
		appName: "Parity",
		caseTypes: [
			{
				name: "frog",
				properties: [{ name: "mood", label: proseText("Mood") }],
			},
		],
		modules: [
			{
				uuid: "mod-intake",
				name: "Intake",
				caseType: "frog",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-reg",
						name: "Register frog",
						type: "registration",
						...(postSubmit !== undefined && { postSubmit }),
						formLinks:
							links === "conditional-then-else"
								? [conditional, unconditional]
								: links === "conditional-only"
									? [conditional]
									: [unconditional],
						fields: [nameWriter()],
					},
				],
			},
			{
				uuid: "mod-care",
				name: "Frog care",
				caseType: "frog",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-visit",
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "mood",
								label: proseText("Mood"),
								caseWrite: { caseType: "frog", property: "mood" },
							}),
						],
					},
				],
			},
		],
	});
}

describe("form-link parity: local suite ↔ HQ JSON", () => {
	it("each local <create if> equals the xpath HQ receives, and the else link carries no if", () => {
		const doc = parityDoc(undefined, "conditional-then-else");
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) =>
				e.code.startsWith("FORM_LINK"),
			),
		).toEqual([]);
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
		const doc = parityDoc("module", "conditional-only");
		const { hq, suite } = compile(doc);
		const form = hq.modules[0].forms[0];
		const creates = stackCreates(suite, "m0-f0");

		expect(form.post_form_workflow_fallback).toBe("module");
		expect(creates).toHaveLength(2);
		expect(creates[0].ifClause).toBe(form.form_links[0].xpath);
		expect(creates[1].ifClause).toBe(hqFallbackGuard(hq, 0, 0));
		expect(creates[1].children).toEqual(["command:'m0'"]);
	});

	it("an app_home fallback is HQ's `default`: no frame on either path", () => {
		const doc = parityDoc("app_home", "conditional-only");
		const { hq, suite } = compile(doc);
		const form = hq.modules[0].forms[0];
		expect(form.post_form_workflow_fallback).toBe("default");
		expect(stackCreates(suite, "m0-f0")).toHaveLength(1);
	});

	it("a previous fallback pushes the projected previous frame under HQ's guard", () => {
		const doc = parityDoc("previous", "conditional-only");
		const { hq, suite } = compile(doc);
		const form = hq.modules[0].forms[0];
		const creates = stackCreates(suite, "m0-f0");
		expect(form.post_form_workflow_fallback).toBe("previous_screen");
		expect(creates).toHaveLength(2);
		expect(creates[1].ifClause).toBe(hqFallbackGuard(hq, 0, 0));
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
		const doc = parityDoc(undefined, "unconditional");
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
