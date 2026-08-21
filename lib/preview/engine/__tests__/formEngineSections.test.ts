/**
 * The engine's view of a sectioned form: its pages, which of them have
 * anything to show right now, page-scoped validation, and the page-scoped
 * first-invalid target the pager reveals. These are the three calls the
 * preview pager is built on; everything else about a section is the
 * ordinary group arm.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import type {
	Field,
	Form,
	ProseTemplate,
	Uuid,
	XPathExpression,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { FormEngine, type FormEngineInput } from "../formEngine";

type Spec = {
	id: string;
	kind: Field["kind"];
	label?: ProseTemplate;
	relevant?: XPathExpression;
	required?: XPathExpression;
	repeat_mode?: string;
	children?: Spec[];
};

/** Build a `FormEngineInput` from a nested spec; uuids are `testUuid(path)`. */
function input(fields: Spec[]): FormEngineInput {
	const formUuid = testUuid("form");
	const form: Form = { uuid: formUuid, id: "f", name: "F", type: "survey" };
	const fieldMap: Record<string, Field> = {};
	const fieldOrder: Record<string, Uuid[]> = {};
	const walk = (nodes: Spec[], parentUuid: Uuid, prefix: string) => {
		const order: Uuid[] = [];
		for (const node of nodes) {
			const uuid = testUuid(`${prefix}.${node.id}`);
			order.push(uuid);
			const { children, ...rest } = node;
			fieldMap[uuid as string] = { uuid, ...rest } as unknown as Field;
			if (children) walk(children, uuid, `${prefix}.${node.id}`);
		}
		fieldOrder[parentUuid as string] = order;
	};
	walk(fields, formUuid, "form");
	return { form, formUuid, fields: fieldMap, fieldOrder, caseTypes: [] };
}

const u = (path: string): Uuid => testUuid(`form.${path}`);

function sectionedForm(): FormEngine {
	return new FormEngine(
		input([
			{
				id: "intro",
				kind: "section",
				label: proseText("Intro"),
				children: [
					{
						id: "name",
						kind: "text",
						label: proseText("Name"),
						required: xp("true()"),
					},
					{ id: "gate", kind: "text", label: proseText("Gate") },
				],
			},
			{
				id: "details",
				kind: "section",
				children: [
					{
						id: "age",
						kind: "int",
						label: proseText("Age"),
						relevant: xp("/data/intro/gate = 'yes'"),
						required: xp("true()"),
					},
				],
			},
			{ id: "blank", kind: "section", children: [] },
			{
				id: "notes",
				kind: "section",
				children: [
					{
						id: "wrap",
						kind: "group",
						label: proseText("Wrap"),
						children: [{ id: "note", kind: "label", label: proseText("Note") }],
					},
				],
			},
			{
				id: "secret",
				kind: "section",
				children: [{ id: "calc", kind: "hidden", label: proseText("Calc") }],
			},
		]),
	);
}

describe("FormEngine.sectionPages", () => {
	it("lists the root sections in order, with their data paths", () => {
		const pages = sectionedForm().sectionPages();
		expect(pages.map((page) => page.uuid)).toEqual([
			u("intro"),
			u("details"),
			u("blank"),
			u("notes"),
			u("secret"),
		]);
		expect(pages.map((page) => page.path)).toEqual([
			"/data/intro",
			"/data/details",
			"/data/blank",
			"/data/notes",
			"/data/secret",
		]);
	});

	it("reports whether a page has anything to show: a label counts, an empty page, an all-irrelevant page, and a hidden-only page do not", () => {
		const engine = sectionedForm();
		const visibility = () =>
			Object.fromEntries(
				engine
					.sectionPages()
					.map((page) => [page.path, page.hasVisibleQuestions]),
			);
		expect(visibility()).toEqual({
			"/data/intro": true,
			"/data/details": false,
			"/data/blank": false,
			"/data/notes": true,
			"/data/secret": false,
		});
		engine.setValue("/data/intro/gate", "yes");
		expect(visibility()["/data/details"]).toBe(true);
		engine.setValue("/data/intro/gate", "no");
		expect(visibility()["/data/details"]).toBe(false);
	});

	it("is empty for a form that is not sectioned", () => {
		const engine = new FormEngine(
			input([
				{ id: "name", kind: "text", label: proseText("Name") },
				{
					id: "g",
					kind: "group",
					label: proseText("G"),
					children: [{ id: "inner", kind: "text", label: proseText("Inner") }],
				},
			]),
		);
		expect(engine.sectionPages()).toEqual([]);
	});
});

describe("FormEngine.validateSection", () => {
	it("checks only the questions on that page, marking them touched", () => {
		const engine = sectionedForm();
		expect(engine.validateSection(u("intro"))).toBe(false);
		const states = engine.store.getState();
		expect(states["/data/intro/name"]?.touched).toBe(true);
		expect(states["/data/intro/name"]?.valid).toBe(false);
		// The other page's required question was not looked at.
		expect(states["/data/details/age"]?.touched).toBe(false);
	});

	it("passes once the page's questions are answered, and ignores an irrelevant one", () => {
		const engine = sectionedForm();
		engine.setValue("/data/intro/name", "Ada");
		expect(engine.validateSection(u("intro"))).toBe(true);
		// `age` is required but irrelevant while the gate is closed.
		expect(engine.validateSection(u("details"))).toBe(true);
		engine.setValue("/data/intro/gate", "yes");
		expect(engine.validateSection(u("details"))).toBe(false);
	});

	it("answers true for a page with nothing on it and for a uuid that is not a section", () => {
		const engine = sectionedForm();
		expect(engine.validateSection(u("blank"))).toBe(true);
		expect(engine.validateSection(u("intro.name"))).toBe(true);
	});
});

describe("FormEngine.firstInvalidFieldTarget({ withinSection })", () => {
	it("finds the first invalid question on that page, with the section leading its ancestors", () => {
		const engine = sectionedForm();
		engine.setValue("/data/intro/gate", "yes");
		engine.validateAll();
		expect(
			engine.firstInvalidFieldTarget({ withinSection: u("details") }),
		).toEqual({
			fieldUuid: u("details.age"),
			instancePath: "/data/details/age",
			ancestorUuids: [u("details")],
		});
		// Across the whole form the earlier page's question comes first.
		expect(engine.firstInvalidFieldTarget()?.fieldUuid).toBe(u("intro.name"));
	});

	it("answers undefined for a valid page and for a uuid that is not a section", () => {
		const engine = sectionedForm();
		engine.setValue("/data/intro/name", "Ada");
		engine.validateAll();
		expect(
			engine.firstInvalidFieldTarget({ withinSection: u("intro") }),
		).toBeUndefined();
		expect(
			engine.firstInvalidFieldTarget({ withinSection: u("nope") }),
		).toBeUndefined();
	});
});
