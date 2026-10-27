/**
 * The engine's view of a sectioned form: its pages, which of them have
 * anything to show right now, page-scoped validation, and the page-scoped
 * first-invalid target the pager reveals. These are the three calls the
 * preview pager is built on; everything else about a section is the
 * ordinary group arm.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { FieldSpec } from "@/lib/__tests__/docHelpers";
import type { Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { FormEngine, type FormEngineInput } from "../formEngine";
import type { PreviewDevice } from "../previewDevice";
import { availablePages } from "../sectionPaging";
import { engineFixtureInput } from "./fixtures/engineInput";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

/** Lower-level page projection includes deliberately empty/hidden-only sections
 * to exercise defensive page skipping in a complete document topology. */
function input(fields: FieldSpec[]): FormEngineInput {
	return engineFixtureInput(fields, {
		formUuid: testUuid("form"),
		formType: "survey",
	});
}

const u = (path: string): Uuid => testUuid(`form.${path}`);

function sectionedForm(device?: PreviewDevice): FormEngine {
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
						required: "true()",
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
						relevant: "/data/intro/gate = 'yes'",
						required: "true()",
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
				children: [{ id: "calc", kind: "hidden" }],
			},
		]),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		device === undefined ? {} : { device },
	);
}

describe("FormEngine.sectionScreens", () => {
	it("lists the root sections in order, with their data paths", () => {
		const pages = sectionedForm().sectionScreens();
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
					.sectionScreens()
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
		expect(engine.sectionScreens()).toEqual([]);
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

describe("FormEngine.formScreens", () => {
	function on(
		device: PreviewDevice,
		fields: FieldSpec[],
		unlabeled: readonly string[] = [],
	): FormEngine {
		const built = input(fields);
		/* A group's label is optional, and the fixture gives every group
		 * one; an unlabeled group draws no field-list. */
		for (const path of unlabeled) {
			const field = built.doc.fields[u(path)];
			if (field !== undefined && "label" in field) delete field.label;
		}
		return new FormEngine(
			built,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ device },
		);
	}
	const shown = (engine: FormEngine) =>
		availablePages(engine.formScreens()).map(({ kind, path }) => ({
			kind,
			path,
		}));

	it("is one screen on Web Apps, sections and all", () => {
		const engine = sectionedForm(webAppsDevice());
		expect(
			engine.formScreens().map(({ kind, path }) => ({ kind, path })),
		).toEqual([{ kind: "form", path: "/data" }]);
		expect(engine.currentScreenPath()).toBe("/data");
	});

	it("is one screen per section of a sectioned form on Android", () => {
		const engine = sectionedForm(androidDevice());
		expect(
			engine.formScreens().map(({ kind, path }) => ({ kind, path })),
		).toEqual(
			engine.sectionScreens().map(({ path }) => ({ kind: "section", path })),
		);
	});

	it("pages an unsectioned form on Android as Core collects its prompts", () => {
		const engine = on(
			androidDevice(),
			[
				{ id: "name", kind: "text", label: proseText("Name") },
				{ id: "secret", kind: "hidden", calculate: "1" },
				{
					id: "household",
					kind: "group",
					label: proseText("Household"),
					children: [
						{ id: "size", kind: "int", label: proseText("Size") },
						{
							id: "inner",
							kind: "group",
							label: proseText("Head"),
							children: [
								{ id: "head", kind: "text", label: proseText("Head") },
							],
						},
						{
							id: "members",
							kind: "repeat",
							children: [
								{ id: "member", kind: "text", label: proseText("Member") },
							],
						},
					],
				},
				{
					id: "loose",
					kind: "group",
					children: [
						{ id: "phone", kind: "text", label: proseText("Phone") },
						{
							id: "skipped",
							kind: "text",
							label: proseText("Skipped"),
							relevant: "/data/name = 'yes'",
						},
					],
				},
				{
					id: "visits",
					kind: "repeat",
					children: [
						{
							id: "visit",
							kind: "group",
							label: proseText("Visit"),
							children: [
								{ id: "note", kind: "text", label: proseText("Note") },
							],
						},
						{ id: "rating", kind: "int", label: proseText("Rating") },
					],
				},
			],
			["loose"],
		);
		/* The form opens with one entry; add a second. */
		engine.addRepeat("/data/visits");
		/* A labeled group, with its nested group and its repeat, is one
		 * screen and offers no screen of its own to add an entry; an
		 * unlabeled group's questions are a screen each, an irrelevant one
		 * skipped; a hidden value is on no screen; a repeat's questions are
		 * one screen per entry. */
		expect(shown(engine)).toEqual([
			{ kind: "question", path: "/data/name" },
			{ kind: "field-list", path: "/data/household" },
			{ kind: "question", path: "/data/loose/phone" },
			{ kind: "field-list", path: "/data/visits[0]/visit" },
			{ kind: "question", path: "/data/visits[0]/rating" },
			{ kind: "field-list", path: "/data/visits[1]/visit" },
			{ kind: "question", path: "/data/visits[1]/rating" },
		]);
		const paths = engine.formScreens().map(({ path }) => path);
		expect(new Set(paths).size).toBe(paths.length);
		expect(
			engine.formScreens().find(({ path }) => path === "/data/loose/skipped"),
		).toMatchObject({ hasVisibleQuestions: false });
	});
});

describe("FormEngine.repeatPromptPoints", () => {
	function engineOn(device: PreviewDevice, fields: FieldSpec[]): FormEngine {
		return new FormEngine(
			input(fields),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ device },
		);
	}
	const FIELDS: FieldSpec[] = [
		{ id: "name", kind: "text", label: proseText("Name") },
		{
			id: "visits",
			kind: "repeat",
			repeat_mode: "user_controlled",
			label: proseText("Visit"),
			children: [{ id: "note", kind: "text", label: proseText("Note") }],
		},
		{
			id: "counted",
			kind: "repeat",
			repeat_mode: "count_bound",
			repeat_count: "1",
			children: [{ id: "item", kind: "text", label: proseText("Item") }],
		},
		{
			id: "household",
			kind: "group",
			label: proseText("Household"),
			children: [
				{
					id: "members",
					kind: "repeat",
					repeat_mode: "user_controlled",
					children: [
						{ id: "member", kind: "text", label: proseText("Member") },
					],
				},
			],
		},
		{ id: "done", kind: "text", label: proseText("Done") },
	];

	it("places Android's prompt after a user-added repeat's last screen, and none in a labeled group or for a counted repeat", () => {
		const engine = engineOn(androidDevice(), FIELDS);
		const screens = engine.formScreens().map(({ path }) => path);
		const [visits] = engine.repeatPromptPoints();
		expect(engine.repeatPromptPoints()).toHaveLength(1);
		expect(visits).toMatchObject({
			repeatUuid: u("visits"),
			repeatPath: "/data/visits",
			visible: true,
		});
		expect(screens[visits.afterScreen]).toBe(
			`/data/visits[${visits.entryCount - 1}]/note`,
		);
		engine.addRepeat("/data/visits");
		const [after] = engine.repeatPromptPoints();
		expect(after.entryCount).toBe(visits.entryCount + 1);
		expect(engine.formScreens()[after.afterScreen].path).toBe(
			`/data/visits[${after.entryCount - 1}]/note`,
		);
	});

	it("has no prompt on Web Apps or in a sectioned form", () => {
		expect(engineOn(webAppsDevice(), FIELDS).repeatPromptPoints()).toEqual([]);
		expect(sectionedForm(androidDevice()).repeatPromptPoints()).toEqual([]);
	});
});

describe("FormEngine.firstInvalidFieldTarget({ withinScreen })", () => {
	it("finds an invalid question only on the screen it is asked about", () => {
		const engine = new FormEngine(
			input([
				{
					id: "first",
					kind: "text",
					label: proseText("First"),
					required: "true()",
				},
				{
					id: "second",
					kind: "text",
					label: proseText("Second"),
					required: "true()",
				},
			]),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ device: androidDevice() },
		);
		expect(engine.validateScreen("/data/second")).toBe(false);
		expect(
			engine.firstInvalidFieldTarget({ withinScreen: "/data/second" }),
		).toMatchObject({ instancePath: "/data/second" });
		expect(
			engine.firstInvalidFieldTarget({ withinScreen: "/data/first" }),
		).toBeUndefined();
	});
});
