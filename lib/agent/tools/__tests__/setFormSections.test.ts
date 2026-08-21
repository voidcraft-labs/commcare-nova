/**
 * Sections at the SA/MCP boundary: the desired-state `setFormSections` tool
 * over the shared planner, the `section` arm `addFields` gets from the
 * registry, and the placement pre-checks `addFields` / `moveField` run so a
 * refused landing reads in Nova's voice before the gate's finding list.
 * Every successful call commits through the gate, so a tool cannot promise
 * a shape the validator refuses.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import { generateToolSchemas } from "@/lib/agent/toolSchemaGenerator";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	FIELD_PLACEMENT_MESSAGES,
	formSectionsOf,
} from "@/lib/doc/formSectionVerdicts";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import { addFieldsTool } from "../addFields";
import { getFormTool } from "../getForm";
import { moveFieldTool } from "../moveField";
import {
	setFormSectionsInputSchema,
	setFormSectionsTool,
} from "../setFormSections";

const MOD = testUuid("mod-visits");
const FORM = testUuid("frm-visit");
const A = testUuid("fld-a");
const B = testUuid("fld-b");
const C = testUuid("fld-c");
const G = testUuid("fld-g");
const G_CHILD = testUuid("fld-g-child");
const R = testUuid("fld-r");
const S1 = testUuid("sec-1");
const S2 = testUuid("sec-2");
const NEW = testUuid("sec-new");

const address = { moduleUuid: MOD, formUuid: FORM };
const generated = generateToolSchemas();

function text(uuid: string, id: string) {
	return f({ kind: "text", uuid, id, label: proseText(id) });
}

function visitsRepeat() {
	return f({
		kind: "repeat",
		uuid: R,
		id: "visits",
		label: proseText("Visits"),
		repeat_mode: "user_controlled",
		children: [f({ kind: "date", id: "d", label: proseText("D") })],
	});
}

function docOf(fields: ReturnType<typeof f>[]): BlueprintDoc {
	return buildDoc({
		appName: "Sections",
		modules: [
			{
				uuid: "mod-visits",
				name: "Visits",
				forms: [{ uuid: "frm-visit", name: "Visit", type: "survey", fields }],
			},
		],
	});
}

/** Single page: a, b, group g(inner), c. */
const flat = () =>
	docOf([
		text(A, "a"),
		text(B, "b"),
		f({
			kind: "group",
			uuid: G,
			id: "g",
			label: proseText("G"),
			children: [text(G_CHILD, "inner")],
		}),
		text(C, "c"),
	]);

/** Single page: a, b, then an add-entries repeat. */
const withRepeat = () => docOf([text(A, "a"), text(B, "b"), visitsRepeat()]);

/** Two pages: [s1 "First": a, b] [s2: c]. */
const paged = () =>
	docOf([
		f({
			kind: "section",
			uuid: S1,
			id: "s1",
			label: proseText("First"),
			children: [text(A, "a"), text(B, "b")],
		}),
		f({ kind: "section", uuid: S2, id: "s2", children: [text(C, "c")] }),
	]);

const errorOf = (result: { result: unknown }): string => {
	const inner = result.result as { error?: string };
	if (inner.error === undefined) {
		throw new Error(`expected a refusal, got ${JSON.stringify(inner)}`);
	}
	return inner.error;
};

const shape = (doc: BlueprintDoc): Record<string, string[]> => {
	const ids = (uuids: readonly string[]) =>
		uuids.map((u) => doc.fields[u]?.id ?? "?");
	const out: Record<string, string[]> = {
		root: ids(doc.fieldOrder[FORM] ?? []),
	};
	for (const uuid of formSectionsOf(doc, FORM)) {
		out[doc.fields[uuid]?.id ?? "?"] = ids(orderedFieldUuids(doc, uuid));
	}
	return out;
};

describe("section at the tool boundary", () => {
	it("parses a section item on add_fields, with or without a title, and refuses logic on it", () => {
		const item = generated.addFieldsItemSchema;
		expect(
			item.safeParse({
				id: "intro",
				kind: "section",
				label: proseText("Intro"),
			}).success,
		).toBe(true);
		expect(item.safeParse({ id: "intro", kind: "section" }).success).toBe(true);
		const withLogic = item.safeParse({
			id: "intro",
			kind: "section",
			relevant: xp("true()"),
		});
		expect(withLogic.success).toBe(false);
		expect(JSON.stringify(withLogic.error?.issues)).toContain("relevant");
		expect(
			item.safeParse({ id: "intro", kind: "section", hint: proseText("h") })
				.success,
		).toBe(false);
	});

	it("publishes the desired-state shape on the wire", async () => {
		const wire = wireToolSchema(setFormSectionsInputSchema);
		const json = JSON.stringify(await wire.jsonSchema);
		for (const key of ["sections", "sectionUuid", "label", "fields"]) {
			expect(json).toContain(`"${key}"`);
		}
		const accepted = await wire.validate?.({
			...address,
			sections: [{ sectionUuid: S1, label: null, fields: [A] }],
		});
		expect(accepted?.success).toBe(true);
	});
});

describe("setFormSections", () => {
	it("pages a single-page form, reports the pages, and getForm then nests them", async () => {
		const h = makeToolWorkspaceHarness(flat());
		const result = await h.runTool(setFormSectionsTool, {
			...address,
			sections: [
				{ sectionUuid: NEW, label: proseText("About you"), fields: [A, G] },
				{ fields: [B, C] },
			],
		});
		const inner = result.result as {
			message: string;
			sections: Array<{ sectionUuid: string; fieldUuids: string[] }>;
			summary: { location: string; count: number };
		};
		expect(inner.message).toContain('Arranged "Visit" into 2 sections');
		expect(inner.message).toContain('"About you"');
		expect(inner.sections.map((s) => s.fieldUuids)).toEqual([
			[A, G],
			[B, C],
		]);
		expect(inner.sections[0]?.sectionUuid).toBe(NEW);
		expect(inner.summary).toEqual({ location: "Visit", count: 2 });
		expect(shape(h.currentDoc())).toEqual({
			root: ["about_you", "section_2"],
			about_you: ["a", "g"],
			section_2: ["b", "c"],
		});

		const read = await h.runTool(getFormTool, address);
		const form = (
			read as {
				data: {
					form: { fields: Array<{ kind: string; children?: unknown[] }> };
				};
			}
		).data.form;
		expect(form.fields.map((field) => field.kind)).toEqual([
			"section",
			"section",
		]);
		expect(form.fields[0]?.children).toHaveLength(2);
	});

	it("keeps a named page, retitles it in one mutation, and removes the rest", async () => {
		const h = makeToolWorkspaceHarness(paged());
		const result = await h.runTool(setFormSectionsTool, {
			...address,
			sections: [{ sectionUuid: S1, label: null, fields: [C, A, B] }],
		});
		expect(result.mutations.map((m) => m.kind)).toEqual([
			"updateField",
			"moveField",
			"removeField",
		]);
		expect(shape(h.currentDoc())).toEqual({
			root: ["s1"],
			s1: ["c", "a", "b"],
		});
		const kept = h.currentDoc().fields[S1];
		expect(
			kept?.kind === "section" ? kept.label : "wrong kind",
		).toBeUndefined();
	});

	it("returns a form to a single page with an empty list, and reports a no-op honestly", async () => {
		const h = makeToolWorkspaceHarness(paged());
		const result = await h.runTool(setFormSectionsTool, {
			...address,
			sections: [],
		});
		const inner = result.result as {
			message: string;
			summary: { count: number };
		};
		expect(inner.message).toContain('Removed the sections from "Visit"');
		expect(inner.summary.count).toBe(0);
		expect(shape(h.currentDoc())).toEqual({ root: ["a", "b", "c"] });

		const again = await h.runTool(setFormSectionsTool, {
			...address,
			sections: [],
		});
		expect(again.mutations).toEqual([]);
		expect((again.result as { message: string }).message).toContain(
			"already arranged this way",
		);
	});

	it("refuses a partition that is not one, in the planner's words", async () => {
		const h = makeToolWorkspaceHarness(paged());
		expect(
			errorOf(
				await h.runTool(setFormSectionsTool, {
					...address,
					sections: [{ sectionUuid: S1, fields: [A, B] }],
				}),
			),
		).toContain("Every top-level question needs a page");
		expect(
			errorOf(
				await h.runTool(setFormSectionsTool, {
					...address,
					sections: [{ sectionUuid: A, fields: [A, B, C] }],
				}),
			),
		).toContain("isn't a section of");
		expect(
			errorOf(
				await h.runTool(setFormSectionsTool, {
					...address,
					sections: [{ fields: [A, B, C, NEW] }],
				}),
			),
		).toContain("isn't a question of");
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("refuses to put an add-entries repeat on a page, naming the rule", async () => {
		const h = makeToolWorkspaceHarness(withRepeat());
		expect(
			errorOf(
				await h.runTool(setFormSectionsTool, {
					...address,
					sections: [{ fields: [A, B, R] }],
				}),
			),
		).toBe(FIELD_PLACEMENT_MESSAGES["user-repeat-in-section"]);
		// Leaving it out is not a way around the rule: it is still a
		// top-level question that needs a page.
		expect(
			errorOf(
				await h.runTool(setFormSectionsTool, {
					...address,
					sections: [{ fields: [A, B] }],
				}),
			),
		).toContain('"visits"');
		expect(h.recordMutations).not.toHaveBeenCalled();
	});
});

describe("addFields on a sectioned form", () => {
	it("lands a question inside a page and refuses one at the root", async () => {
		const h = makeToolWorkspaceHarness(paged());
		const ok = await h.runTool(addFieldsTool, {
			...address,
			fields: [
				{ id: "d", kind: "text", label: proseText("D"), parentUuid: S2 },
			],
		});
		expect(ok.result).not.toHaveProperty("error");
		expect(shape(h.currentDoc()).s2).toEqual(["c", "d"]);

		const loose = await h.runTool(addFieldsTool, {
			...address,
			fields: [{ id: "e", kind: "text", label: proseText("E") }],
		});
		expect(errorOf(loose)).toBe(
			FIELD_PLACEMENT_MESSAGES["loose-field-in-sectioned-form"],
		);
	});

	it("adds a page with its questions in one call, and refuses a section under a field", async () => {
		const h = makeToolWorkspaceHarness(paged());
		const added = await h.runTool(addFieldsTool, {
			...address,
			fields: [
				{
					id: "more",
					kind: "section",
					fieldUuid: NEW,
					label: proseText("More"),
				},
				{ id: "d", kind: "text", label: proseText("D"), parentUuid: NEW },
				{
					id: "rows",
					kind: "repeat",
					label: proseText("Rows"),
					repeat: { mode: "count_bound", count: xp("2") },
					parentUuid: NEW,
				},
			],
		});
		expect(added.result).not.toHaveProperty("error");
		expect(shape(h.currentDoc())).toEqual({
			root: ["s1", "s2", "more"],
			s1: ["a", "b"],
			s2: ["c"],
			more: ["d", "rows"],
		});

		const nested = await h.runTool(addFieldsTool, {
			...address,
			fields: [{ id: "intro", kind: "section", parentUuid: S1 }],
		});
		expect(errorOf(nested)).toBe(FIELD_PLACEMENT_MESSAGES["section-not-root"]);

		const userRepeat = await h.runTool(addFieldsTool, {
			...address,
			fields: [
				{
					id: "visits",
					kind: "repeat",
					label: proseText("Visits"),
					repeat: { mode: "user_controlled" },
					parentUuid: NEW,
				},
			],
		});
		expect(errorOf(userRepeat)).toBe(
			FIELD_PLACEMENT_MESSAGES["user-repeat-in-section"],
		);
	});

	it("refuses a first section that would leave the existing questions loose", async () => {
		const h = makeToolWorkspaceHarness(flat());
		const mixed = await h.runTool(addFieldsTool, {
			...address,
			fields: [
				{ id: "intro", kind: "section", fieldUuid: NEW },
				{ id: "q", kind: "text", label: proseText("Q"), parentUuid: NEW },
			],
		});
		expect(errorOf(mixed)).toContain("isn't split into sections yet");
		expect(errorOf(mixed)).toContain("setFormSections");
		expect(h.recordMutations).not.toHaveBeenCalled();
	});
});

describe("moveField across pages", () => {
	it("moves a question onto a page and refuses the root of a sectioned form", async () => {
		const h = makeToolWorkspaceHarness(paged());
		const onto = await h.runTool(moveFieldTool, {
			...address,
			fieldUuid: A,
			parentUuid: S2,
		});
		expect(onto.result).not.toHaveProperty("error");
		expect(shape(h.currentDoc())).toEqual({
			root: ["s1", "s2"],
			s1: ["b"],
			s2: ["c", "a"],
		});

		const toRoot = await h.runTool(moveFieldTool, {
			...address,
			fieldUuid: A,
			parentUuid: null,
		});
		expect(errorOf(toRoot)).toBe(
			FIELD_PLACEMENT_MESSAGES["loose-field-in-sectioned-form"],
		);
	});

	it("refuses to carry an add-entries repeat into a page", async () => {
		// A user repeat nested in a group on a single page; moving the group
		// onto a page would carry the repeat with it.
		const h = makeToolWorkspaceHarness(
			docOf([
				text(A, "a"),
				f({
					kind: "group",
					uuid: G,
					id: "g",
					label: proseText("G"),
					children: [visitsRepeat()],
				}),
			]),
		);
		const paging = await h.runTool(setFormSectionsTool, {
			...address,
			sections: [{ sectionUuid: S1, fields: [A, G] }],
		});
		expect(errorOf(paging)).toBe(
			FIELD_PLACEMENT_MESSAGES["user-repeat-in-section"],
		);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});
});
