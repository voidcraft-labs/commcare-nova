/**
 * Contract: `set_case_type_parent` (shared by the SA and MCP) edits one record type's parent
 * links through the real gate and reducer: a named link is added with its kind, removed by its
 * name and destination (its kind narrowing the match only when given, so a stored link with no
 * kind can be removed too), a removal naming no held link is refused with the links the type
 * holds, and a lone parent link left after a removal or a cleared default sits in the default
 * parent slot every `parent_type` reader sees. Plausible failures: a link call rewriting the
 * default parent, a removal that misses on the kind and answers success, and a lone parent
 * stranded under `relations`.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import type { BlueprintDoc } from "@/lib/domain";
import type { CaseType } from "@/lib/domain/blueprint";
import { proseText } from "@/lib/domain/prose";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { setCaseTypeParentTool } from "../setCaseTypeParent";

function app(visit: Omit<CaseType, "name" | "properties"> = {}): BlueprintDoc {
	return expectAdmittedDoc(
		buildDoc({
			caseTypes: [
				{ name: "visit", properties: [], ...visit },
				{ name: "clinic", properties: [] },
				{ name: "home", properties: [] },
			],
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Note",
							type: "survey",
							fields: [
								f({ kind: "text", id: "note", label: proseText("Note") }),
							],
						},
					],
				},
			],
		}),
	);
}

const visitOf = (doc: BlueprintDoc) =>
	doc.caseTypes?.find((type) => type.name === "visit");

describe("set_case_type_parent", () => {
	it("adds a named link with its kind beside the default parent", async () => {
		const harness = makeToolWorkspaceHarness(app({ parent_type: "clinic" }));
		const outcome = await harness.runTool(setCaseTypeParentTool, {
			caseType: "visit",
			parentType: "home",
			relationship: "extension",
			link: { name: "site", change: "add" },
		});
		expect(outcome.result).toMatchObject({ ok: true });
		expect(visitOf(harness.currentDoc())).toEqual({
			name: "visit",
			properties: [],
			parent_type: "clinic",
			relations: [
				{ identifier: "site", targetType: "home", relationship: "extension" },
			],
		});
	});

	it("removes a link by its name and destination whatever its stored kind", async () => {
		for (const relationship of ["extension", undefined] as const) {
			const harness = makeToolWorkspaceHarness(
				app({
					relations: [
						{
							identifier: "site",
							targetType: "home",
							...(relationship && { relationship }),
						},
					],
				}),
			);
			const outcome = await harness.runTool(setCaseTypeParentTool, {
				caseType: "visit",
				parentType: "home",
				link: { name: "site", change: "remove" },
			});
			expect(outcome.result).toMatchObject({ ok: true });
			expect(outcome.result).not.toMatchObject({ summary: { noop: true } });
			expect(visitOf(harness.currentDoc())?.relations).toBeUndefined();
		}
	});

	it("refuses a removal that names no held link, naming the links the type holds", async () => {
		const doc = app({
			relations: [
				{ identifier: "site", targetType: "home", relationship: "extension" },
			],
		});
		const harness = makeToolWorkspaceHarness(doc);
		const outcome = await harness.runTool(setCaseTypeParentTool, {
			caseType: "visit",
			parentType: "home",
			relationship: "child",
			link: { name: "site", change: "remove" },
		});
		expect(outcome.result).toEqual({
			error: expect.stringContaining("site to home (extension)"),
		});
		expect(harness.currentDoc()).toBe(doc);
	});

	it("asks for the destination of a link", async () => {
		const harness = makeToolWorkspaceHarness(app());
		const outcome = await harness.runTool(setCaseTypeParentTool, {
			caseType: "visit",
			parentType: null,
			link: { name: "site", change: "add" },
		});
		expect(outcome.result).toEqual({
			error: "Choose the destination record type for this link.",
		});
	});

	it("refuses a link to a record type the app lacks", async () => {
		const harness = makeToolWorkspaceHarness(app());
		const outcome = await harness.runTool(setCaseTypeParentTool, {
			caseType: "visit",
			parentType: "nowhere",
			link: { name: "site", change: "add" },
		});
		expect(outcome.result).toMatchObject({ error: expect.any(String) });
		expect(visitOf(harness.currentDoc())?.relations).toBeUndefined();
	});

	it("moves the lone parent left by a removal or a cleared default into the default slot", async () => {
		const two = {
			parent_type: "clinic",
			relations: [
				{ identifier: "parent", targetType: "home", relationship: "extension" },
			],
		} as const;
		for (const input of [
			{
				caseType: "visit",
				parentType: "clinic",
				link: { name: "parent", change: "remove" },
			},
			{ caseType: "visit", parentType: null },
		]) {
			const harness = makeToolWorkspaceHarness(app(two));
			const outcome = await harness.runTool(setCaseTypeParentTool, input);
			expect(outcome.result).toMatchObject({ ok: true });
			expect(visitOf(harness.currentDoc())).toEqual({
				name: "visit",
				properties: [],
				parent_type: "home",
				relationship: "extension",
			});
		}
	});

	it("makes an alternative parent the default, taking it out of relations", async () => {
		const harness = makeToolWorkspaceHarness(
			app({
				parent_type: "clinic",
				relations: [
					{
						identifier: "parent",
						targetType: "home",
						relationship: "extension",
					},
				],
			}),
		);
		const outcome = await harness.runTool(setCaseTypeParentTool, {
			caseType: "visit",
			parentType: "home",
			relationship: "extension",
		});
		expect(outcome.result).toMatchObject({ ok: true });
		expect(visitOf(harness.currentDoc())).toEqual({
			name: "visit",
			properties: [],
			parent_type: "home",
			relationship: "extension",
		});
	});
});
