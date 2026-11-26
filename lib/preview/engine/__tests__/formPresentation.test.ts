import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec } from "@/lib/__tests__/docHelpers";
import type { ProseTemplate } from "@/lib/domain";
import { buildEngineInput } from "../engineInput";
import { FormEngine } from "../formEngine";
import { projectFormPresentation } from "../formPresentation";
import type { PreviewDevice } from "../previewDevice";
import { availablePages } from "../sectionPaging";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

function runtime(
	fields: FieldSpec[],
	device?: PreviewDevice,
	dataRootName?: string,
) {
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
	if (dataRootName !== undefined)
		doc.forms[formUuid].dataRootName = dataRootName;
	const input = buildEngineInput(doc, formUuid, null);
	if (!input) throw new Error("Form fixture is incomplete.");
	return {
		doc,
		input,
		engine: new FormEngine(
			input,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			device === undefined ? {} : { device },
		),
	};
}

const literalText = (prose: ProseTemplate) =>
	prose.parts
		.flatMap((part) => (part.kind === "text" ? [part.text] : []))
		.join("");

function observe(engine: FormEngine) {
	return projectFormPresentation(
		engine.getControlTree(),
		{
			stateAt: (_field, path) => engine.getState(path),
			workerRelevant: engine.workerRelevantPaths(),
		},
		{
			rootPath: engine.rootPath,
			currentSectionUuid: engine.currentSectionUuid(),
			availableSectionUuids: new Set(
				availablePages(engine.sectionScreens()).map((page) => page.uuid),
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
		children: [],
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

const PAGED_FORM: FieldSpec[] = [
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
];

it("puts every shown page on Web Apps' one screen", () => {
	const { engine } = runtime(PAGED_FORM, webAppsDevice());
	const screens = engine.formScreens();
	expect(screens.map(({ kind, path }) => ({ kind, path }))).toEqual([
		{ kind: "form", path: "/data" },
	]);
	const view = projectFormPresentation(
		engine.getControlTree(),
		{
			stateAt: (_field, path) => engine.getState(path),
			workerRelevant: engine.workerRelevantPaths(),
		},
		{
			currentScreenPath: engine.currentScreenPath(),
			/* As `evaluate_form` passes: a section with nothing to show is
			 * drawn on no screen. */
			availableSectionUuids: new Set(
				availablePages(engine.sectionScreens()).map((page) => page.uuid),
			),
			text: literalText,
		},
	);
	expect(
		view.nodes.map(({ path, onCurrentPage }) => ({ path, onCurrentPage })),
	).toEqual([
		{ path: "first", onCurrentPage: true },
		{ path: "review", onCurrentPage: true },
	]);
});

it("marks the current page and excludes pages the actual pager skips", () => {
	const { engine } = runtime(PAGED_FORM, androidDevice());
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

it("draws the question outside its submitted group on Android and saves the answer there", () => {
	const group = testUuid("address-group");
	const question = testUuid("address-question");
	const { input } = runtime(
		[
			{
				id: "visit",
				uuid: group,
				kind: "group",
				children: [{ id: "in_group", kind: "text" }],
			},
			{
				id: "outside",
				uuid: question,
				kind: "text",
				submissionPlacement: { parent: group, position: 0 },
			},
		],
		androidDevice(),
		"household",
	);
	const engine = new FormEngine(
		input,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ device: androidDevice() },
	);
	expect(engine.formScreens().map((screen) => screen.path)).toContain(
		"/household/visit/outside",
	);
	expect(
		engine.containsControl("/household/visit", "/household/visit/outside"),
	).toBe(false);
	engine.setValue("/household/visit/outside", "Collected outside the group");
	expect(engine.getState("/household/visit/outside").value).toBe(
		"Collected outside the group",
	);
	expect(engine.fieldTarget("/household/visit/outside")?.ancestorUuids).toEqual(
		[],
	);
	expect(
		engine.getFieldTree()[0].children?.map((node) => node.field.id),
	).toEqual(["outside", "in_group"]);
	expect(engine.getControlTree().map((node) => node.field.id)).toEqual([
		"visit",
		"outside",
	]);
});

it("runs and resumes a form at its submitted answer root on both platforms", () => {
	for (const device of [webAppsDevice(), androidDevice()]) {
		const { engine } = runtime(
			[
				{ id: "rate", kind: "int", label: "Rating" },
				{
					id: "visits",
					kind: "repeat",
					children: [{ id: "note", kind: "text", label: "Visit note" }],
				},
			],
			device,
			"visit.survey",
		);
		engine.setValue("/visit.survey/rate", "2");
		expect(engine.addRepeat("/visit.survey/visits")).toBe(0);
		engine.setValue("/visit.survey/visits[0]/note", "first");
		engine.addRepeat("/visit.survey/visits");
		engine.setValue("/visit.survey/visits[1]/note", "second");
		engine.restoreEntryCheckpoint(engine.entryCheckpoint());
		expect(
			engine.getValueSnapshot().values.get("/visit.survey/visits[1]/note"),
		).toBe("second");
		expect(
			engine
				.formScreens()
				.every(({ path }) => path.startsWith("/visit.survey")),
		).toBe(true);
		expect(observe(engine).nodes.map(({ path }) => path)).toEqual([
			"rate",
			"visits",
		]);
	}
});

it("confirms passive messages and preserves the worker's Android checkbox through validation", () => {
	for (const device of [androidDevice(), webAppsDevice()]) {
		const { engine } = runtime(
			[
				{
					kind: "label",
					id: "notice",
					label: "Take a seat",
					required: "true()",
				},
				{
					kind: "label",
					id: "confirm",
					label: "I have checked the form",
					required: "true()",
					askForConfirmation: true,
				},
				{ kind: "hidden", id: "copy", calculate: "#form/confirm" },
			],
			device,
		);
		const android = device.platform === "android";
		expect(engine.validateAll()).toBe(!android);
		expect(engine.getState("/data/notice").value).toBe("OK");
		expect(engine.getState("/data/confirm").value).toBe(android ? "" : "OK");
		if (android) {
			expect(engine.firstInvalidFieldTarget()?.instancePath).toBe(
				"/data/confirm",
			);
			engine.setValue("/data/confirm", "OK");
			expect(engine.validateAll()).toBe(true);
			expect(engine.getState("/data/copy").value).toBe("OK");
			engine.setValue("/data/confirm", "");
			expect(engine.validateAll()).toBe(false);
		}
	}
});

it("confirms visible messages at their submitted addresses and leaves messages outside the worker's screen alone", () => {
	const group = testUuid("message-storage-group");
	const { engine } = runtime(
		[
			{ kind: "text", id: "show_storage" },
			{
				kind: "group",
				uuid: group,
				id: "storage",
				relevant: "#form/show_storage = 'yes'",
				children: [
					{ kind: "text", id: "notes" },
					{
						kind: "label",
						id: "controls_only",
						label: "Read the result",
						submissionPlacement: {
							parent: testUuid("worker-presentation-form"),
							position: 1,
						},
					},
				],
			},
			{
				kind: "label",
				id: "notice",
				label: "Read the visit instructions",
				submissionPlacement: { parent: group, position: 0 },
			},
			{
				kind: "label",
				id: "consent",
				label: "Confirm consent",
				askForConfirmation: true,
			},
		],
		androidDevice(),
		"visit_report",
	);
	const address = "/visit_report/storage/notice";
	engine.validateAll();
	expect(engine.getState(address).value).toBe("");
	expect(
		engine.effectivelyVisiblePaths().has("/visit_report/controls_only"),
	).toBe(true);
	expect(engine.getState("/visit_report/controls_only").value).toBe("");
	engine.setValue("/visit_report/show_storage", "yes");
	expect(engine.validateScreen("/visit_report/consent")).toBe(true);
	expect(engine.getState(address).value).toBe("");
	expect(engine.validateScreen(address)).toBe(true);
	expect(engine.getState(address).value).toBe("OK");
	expect(engine.getState("/visit_report/consent").value).toBe("");
	expect(engine.validateScreen("/visit_report/controls_only")).toBe(true);
	expect(engine.getState("/visit_report/controls_only").value).toBe("OK");
});

it("asks before inserting the first visit and can return to the empty invitation", () => {
	const { engine, input } = runtime([
		{
			kind: "repeat",
			id: "visit",
			label: "Visit",
			addFirstLabel: { parts: [{ kind: "text", text: "Record a place" }] },
			addLabel: { parts: [{ kind: "text", text: "Record another place" }] },
			children: [
				{ kind: "text", id: "village", label: "Village" },
				{
					kind: "repeat",
					id: "person",
					children: [{ kind: "text", id: "name" }],
				},
			],
		},
	]);
	const path = "/data/visit";
	const expectEmpty = () => {
		expect(engine.getRepeatCount(path)).toBe(0);
		expect(observe(engine).nodes[0]).toMatchObject({
			repeatCount: 0,
			controls: { addLabel: "Record a place" },
			children: [],
		});
	};
	expectEmpty();
	expect(engine.addRepeat(path)).toBe(0);
	expect(engine.getRepeatCount(path + "[0]/person")).toBe(0);
	engine.setValue(path + "[0]/village", "Oak Hill");
	expect(observe(engine).nodes[0]).toMatchObject({
		repeatCount: 1,
		controls: { addLabel: "Record another place" },
		children: [{ controls: { remove: true } }],
	});
	const chosen = engine.getRepeatInstanceKey(path, 0);
	engine.updateSchema(input);
	expect(engine.getRepeatCount(path)).toBe(1);
	expect(engine.getState(path + "[0]/village").value).toBe("Oak Hill");
	expect(engine.getRepeatInstanceKey(path, 0)).toBe(chosen);
	const checkpoint = engine.entryCheckpoint();
	engine.removeRepeat(path, 0);
	expect(engine.setValue(path + "[0]/village", "Late answer")).toBe(false);
	expectEmpty();
	expect(engine.addRepeat(path)).toBe(0);
	expect(engine.getState(path + "[0]/village").value).toBe("");
	expect(engine.getRepeatInstanceKey(path, 0)).not.toBe(chosen);
	engine.restoreEntryCheckpoint(checkpoint);
	expect(engine.getState(path + "[0]/village").value).toBe("Oak Hill");
	expect(engine.getRepeatInstanceKey(path, 0)).toBe(chosen);
});

it("keeps live answers and dependent calculations when the submission root changes", () => {
	const { engine, input } = runtime([
		{ kind: "text", id: "name", label: "Name" },
		{ kind: "hidden", id: "echo", calculate: "concat(#form/name, '!')" },
	]);
	engine.setValue("/data/name", "Ana");
	engine.renamePaths(
		["name", "echo"].map((id) => ({
			oldPath: "/data/" + id,
			newPath: "/visit/" + id,
		})),
	);
	engine.rebuildDag({
		...input,
		form: { ...input.form, dataRootName: "visit" },
	});
	engine.evaluatePathsInto(engine.getAllPaths());
	expect(engine.getValueSnapshot().values.get("/visit/name")).toBe("Ana");
	engine.setValue("/visit/name", "Bo");
	expect(engine.getValueSnapshot().values.get("/visit/echo")).toBe("Bo!");
	expect(engine.getValueSnapshot().values.has("/data/name")).toBe(false);
});

it.each([androidDevice(), webAppsDevice()])(
	"matches both control and data relevance without dropping submitted defaults",
	(device) => {
		const form = testUuid("worker-presentation-form");
		const group = testUuid("worker-private-group");
		const { engine } = runtime(
			[
				{ kind: "text", id: "show" },
				{
					kind: "group",
					uuid: group,
					id: "visit",
					relevant: "#form/show = 'yes'",
					children: [
						{
							kind: "text",
							id: "reported",
							default_value: "'stored'",
							submissionPlacement: { parent: form, position: 1 },
						},
					],
				},
				{
					kind: "text",
					id: "local",
					default_value: "'private'",
					submissionPlacement: { parent: group, position: 0 },
				},
			],
			device,
		);
		const worker = () =>
			observe(engine)
				.fields.filter((f) => f.visible)
				.map((f) => f.path);
		expect(worker()).toEqual(["/data/show"]);
		expect(engine.effectivelyVisiblePaths().has("/data/reported")).toBe(true);
		expect(engine.getState("/data/reported").value).toBe("stored");
		expect(engine.effectivelyVisiblePaths().has("/data/visit/local")).toBe(
			false,
		);
		if (device.platform === "android") {
			expect(availablePages(engine.formScreens()).map((p) => p.path)).toEqual([
				"/data/show",
			]);
		}
		engine.setValue("/data/show", "yes");
		expect(worker()).toEqual([
			"/data/show",
			"/data/visit",
			"/data/reported",
			"/data/visit/local",
		]);
		expect(engine.effectivelyVisiblePaths().has("/data/visit/local")).toBe(
			true,
		);
		expect(engine.getState("/data/visit/local").value).toBe("private");
		engine.setValue("/data/show", "no");
		expect(worker()).toEqual(["/data/show"]);
		expect(engine.getState("/data/reported").value).toBe("stored");
	},
);
