import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec } from "@/lib/__tests__/docHelpers";
import type { ProseTemplate } from "@/lib/domain";
import { buildEngineInput } from "../engineInput";
import { FormEngine } from "../formEngine";
import { projectFormPresentation } from "../formPresentation";
import { availablePages } from "../sectionPaging";

function runtime(fields: FieldSpec[]) {
	const formUuid = testUuid("worker-presentation-form");
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [{ uuid: formUuid, name: "Visit", type: "survey", fields }],
			},
		],
	});
	// These containers intentionally have no worker-facing title. buildDoc's
	// default labels are useful for most fixtures, but would add content here.
	for (const field of Object.values(doc.fields)) {
		if (
			(field.kind === "repeat" || field.kind === "group") &&
			field.id.startsWith("untitled_")
		)
			delete field.label;
	}
	const input = buildEngineInput(doc, formUuid, null);
	if (!input) throw new Error("Form fixture is incomplete.");
	return { doc, input, engine: new FormEngine(input) };
}

const literalText = (prose: ProseTemplate) =>
	prose.parts
		.flatMap((part) => (part.kind === "text" ? [part.text] : []))
		.join("");

function observe(engine: FormEngine) {
	return projectFormPresentation(
		engine.getFieldTree(),
		{ stateAt: (_field, path) => engine.getState(path) },
		{
			currentSectionUuid: engine.currentSectionUuid(),
			availableSectionUuids: new Set(
				availablePages(engine.sectionPages()).map((page) => page.uuid),
			),
			text: literalText,
		},
	);
}

it("keeps the authored hierarchy and instance order after restoring a differently ordered checkpoint", () => {
	const { engine, input } = runtime([
		{ kind: "label", id: "intro", label: "Read this first" },
		{
			kind: "group",
			id: "inspection",
			label: "Inspection",
			children: [{ kind: "text", id: "notes", label: "Notes" }],
		},
		{
			kind: "repeat",
			id: "visits",
			children: [{ kind: "int", id: "rating", label: "Rating" }],
		},
		{ kind: "label", id: "review", label: "Review your visit" },
	]);
	engine.addRepeat("/data/visits");
	engine.setValue("/data/visits[0]/rating", "2");
	engine.setValue("/data/visits[1]/rating", "4");
	const checkpoint = engine.entryCheckpoint();
	engine.restoreEntryCheckpoint({
		...checkpoint,
		state: Object.fromEntries(Object.entries(checkpoint.state).reverse()),
	});
	const view = observe(engine);
	expect(view.fields.map(({ path }) => path)).toEqual([
		"/data/intro",
		"/data/inspection",
		"/data/inspection/notes",
		"/data/visits",
		"/data/visits[0]/rating",
		"/data/visits[1]/rating",
		"/data/review",
	]);
	expect(view.nodes.map(({ path }) => path)).toEqual([
		"intro",
		"inspection",
		"visits",
		"review",
	]);
	expect(view.nodes[2]).toMatchObject({
		kind: "repeat",
		controls: { add: true },
		repeatCount: 2,
		children: [
			{
				kind: "repeat-instance",
				path: "visits[0]",
				index: 0,
				controls: { remove: true },
				children: [{ path: "visits[0]/rating", label: "Rating" }],
			},
			{
				kind: "repeat-instance",
				path: "visits[1]",
				index: 1,
				controls: { remove: true },
				children: [{ path: "visits[1]/rating", label: "Rating" }],
			},
		],
	});
	// A live reorder changes presentation immediately while preserving answers.
	const reordered = structuredClone(input);
	reordered.fieldOrder[input.formUuid].reverse();
	engine.rebuildDag(reordered);
	expect(observe(engine).nodes.map(({ path }) => path)).toEqual([
		"review",
		"visits",
		"inspection",
		"intro",
	]);
	expect(engine.getState("/data/visits[1]/rating").value).toBe("4");
});

it("omits automatic processing chrome while retaining its calculations, headings, media and manual controls", () => {
	const mediaId = testUuid("worker-presentation-image");
	const { engine } = runtime([
		{
			kind: "repeat",
			id: "untitled_processing",
			repeat_mode: "count_bound",
			repeat_count: "2",
			children: [{ kind: "hidden", id: "computed", calculate: "7" }],
		},
		{
			kind: "repeat",
			id: "untitled_media",
			repeat_mode: "count_bound",
			repeat_count: "1",
			label_media: { image: mediaId },
			children: [{ kind: "hidden", id: "computed", calculate: "9" }],
		},
		{
			kind: "repeat",
			id: "batch_title",
			label: "Batch summary",
			repeat_mode: "count_bound",
			repeat_count: "2",
			children: [{ kind: "hidden", id: "computed", calculate: "11" }],
		},
		{
			kind: "repeat",
			id: "untitled_manual",
			children: [{ kind: "hidden", id: "computed", calculate: "3" }],
		},
		{ kind: "label", id: "summary", label: "Saved when you submit" },
	]);
	const view = observe(engine);
	expect(view.nodes.map(({ path }) => path)).toEqual([
		"untitled_media",
		"batch_title",
		"untitled_manual",
		"summary",
	]);
	expect(view.nodes[0]).toMatchObject({
		media: { label: { image: mediaId } },
		children: [],
	});
	expect(view.nodes[1]).toMatchObject({ label: "Batch summary", children: [] });
	expect(view.nodes[2]).toMatchObject({
		controls: { add: true },
		children: [
			{ kind: "repeat-instance", controls: { remove: false }, children: [] },
		],
	});
	expect(
		view.fields
			.filter(({ path }) => path.startsWith("/data/untitled_processing"))
			.map(({ visible, state }) => ({ visible, value: state.value })),
	).toEqual([
		{ visible: false, value: "" },
		{ visible: false, value: "7" },
		{ visible: false, value: "7" },
	]);
	expect(
		engine
			.effectivelyVisiblePaths()
			.has("/data/untitled_processing[1]/computed"),
	).toBe(true);
	expect(
		engine.computeSubmissionMutation({ entryKey: "presentation-entry" }),
	).toMatchObject({ kind: "survey" });
});

it("uses concrete-instance relevance and resolved prose without replacing optional blanks", () => {
	const { engine } = runtime([
		{
			kind: "repeat",
			id: "untitled_rows",
			repeat_mode: "count_bound",
			repeat_count: "2",
			children: [
				{
					kind: "int",
					id: "show",
					label: "Show",
				},
				{
					kind: "label",
					id: "details",
					label: {
						parts: [
							{ kind: "text", text: "Phone: " },
							{ kind: "field-ref", uuid: testUuid("optional-phone") },
						],
					},
					relevant: "#form/untitled_rows/show = 1",
				},
			],
		},
		{
			kind: "text",
			id: "phone",
			uuid: testUuid("optional-phone"),
			label: "Téléphone",
		},
	]);
	engine.setValue("/data/untitled_rows[0]/show", "0");
	engine.setValue("/data/untitled_rows[1]/show", "1");
	const view = observe(engine);
	expect(view.nodes[0]).toMatchObject({
		children: [
			{ children: [{ path: "untitled_rows[0]/show" }] },
			{
				children: [
					{ path: "untitled_rows[1]/show" },
					{ path: "untitled_rows[1]/details", label: "Phone: " },
				],
			},
		],
	});
	const repeat = view.nodes[0];
	expect(repeat.children?.[0]?.children).toHaveLength(1);
	expect(view.nodes[1]).toMatchObject({ label: "Téléphone" });
	expect(
		view.fields.find(({ path }) => path === "/data/untitled_rows[0]/details"),
	).toMatchObject({ visible: false });
});

it("marks the current page and excludes pages the actual pager skips", () => {
	const { engine } = runtime([
		{
			kind: "section",
			id: "first",
			label: "First page",
			children: [{ kind: "text", id: "name", label: "Name" }],
		},
		{
			kind: "section",
			id: "processing",
			label: "Processing",
			children: [{ kind: "hidden", id: "computed", calculate: "1" }],
		},
		{
			kind: "section",
			id: "review",
			label: "Review",
			children: [
				{ kind: "label", id: "intro", label: "Review before submitting" },
			],
		},
	]);
	const initial = observe(engine);
	expect(
		initial.nodes.map(({ path, onCurrentPage }) => ({ path, onCurrentPage })),
	).toEqual([
		{ path: "first", onCurrentPage: true },
		{ path: "review", onCurrentPage: false },
	]);
	const review = engine
		.getFieldTree()
		.find(({ field }) => field.id === "review");
	if (!review) throw new Error("Review page is missing.");
	engine.enterSection(review.field.uuid);
	const next = observe(engine);
	expect(next.currentSectionUuid).toBe(review.field.uuid);
	expect(next.nodes[1]).toMatchObject({
		onCurrentPage: true,
		children: [{ path: "review/intro", onCurrentPage: true }],
	});
});

it("removes empty automatic iterations as relevance changes and keeps blank prompts identifiable", () => {
	const { engine } = runtime([
		{ kind: "text", id: "show", label: "" },
		{
			kind: "repeat",
			id: "untitled_rows",
			repeat_mode: "count_bound",
			repeat_count: "2",
			children: [
				{
					kind: "label",
					id: "details",
					label: "Second entry",
					relevant: "#form/show = 'yes' and position(..) = 1",
				},
			],
		},
	]);
	expect(observe(engine).nodes).toMatchObject([
		{ path: "show", label: "", position: 1, fallbackLabel: "Question 1." },
	]);
	expect(observe(engine).nodes).toHaveLength(1);
	engine.setValue("/data/show", "yes");
	const visible = observe(engine);
	expect(visible.nodes[1]).toMatchObject({
		path: "untitled_rows",
		children: [{ index: 1, children: [{ label: "Second entry" }] }],
	});
	expect(visible.nodes[1].children).toHaveLength(1);
	engine.setValue("/data/show", "no");
	expect(observe(engine).nodes).toHaveLength(1);
	expect(engine.getRepeatCount("/data/untitled_rows")).toBe(2);
});
