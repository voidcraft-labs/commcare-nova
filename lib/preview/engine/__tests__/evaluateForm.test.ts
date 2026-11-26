import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	evaluatePreparedMutationCandidate,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { type BlueprintDoc, simpleSearchInputDef } from "@/lib/domain";
import { evaluationScenarioCases } from "@/lib/preview/engine/evaluationScenario";
import {
	evaluateForm,
	FormEvaluationInputError,
	FormRefusedError,
} from "../evaluateForm";
import { previewAsMe } from "../identity";
import { previewLookupData } from "../lookupEvaluation";
import { createEvaluationApp } from "./evaluationFixture";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

/** The root answer a proposed submission carries for the question `id`. */
function answerOf(
	doc: BlueprintDoc,
	submission:
		| {
				readonly operationAnswers?: {
					readonly root: ReadonlyArray<{
						readonly fieldUuid: string;
						readonly value: string | readonly string[];
					}>;
				};
		  }
		| undefined,
	id: string,
): string | readonly string[] | undefined {
	const field = Object.values(doc.fields).find(
		(candidate) => candidate.id === id,
	);
	return submission?.operationAnswers?.root.find(
		(entry) => entry.fieldUuid === field?.uuid,
	)?.value;
}

it("observes repeat headings and unnamed questions in the resolved worker language", async () => {
	const doc = await createEvaluationApp(
		[{ name: "Visits", forms: [{ name: "Checklist", type: "survey" }] }],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Visits",
					formUuid: "Checklist",
					fields: [
						{ kind: "hidden", id: "blank", calculate: "''" },
						{
							kind: "repeat",
							id: "visits",
							label: "Visits",
							repeat: { mode: "user_controlled" },
						},
						{
							kind: "text",
							id: "note",
							parentUuid: "visits",
							label: "{{blank}}",
						},
					],
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Visits",
					formUuid: "Checklist",
					fieldUuid: "fixture_placeholder",
				},
			},
			{
				toolName: "addLanguage",
				input: { language: { language: "spa", region: "MX" } },
			},
			{ toolName: "addLanguage", input: { language: { language: "fra" } } },
		],
	);
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Checklist",
	)?.uuid;
	const identity = previewAsMe({ id: "member" }, doc);
	if (!formUuid || !identity)
		throw new Error("Evaluation fixture is incomplete.");
	const before = structuredClone(doc);
	for (const [language, heading, question] of [
		[undefined, "Instance", "Question"],
		["eng", "Instance", "Question"],
		["spa-MX", "Repetición", "Pregunta"],
		["fra", "Instance", "Question"],
		["spa", "Instance", "Question"],
	] as const) {
		const result = await evaluateForm(
			doc,
			{
				formUuid,
				language,
				repeats: [{ path: "visits", count: 2 }],
				answers: [
					{ path: "visits[0]/note", value: "first" },
					{ path: "visits[1]/note", value: "second" },
				],
			},
			{
				identity,
				device: webAppsDevice(),
				cases: { rows: [], indices: [] },
				lookup: {
					projectRevision: "0",
					definitions: [],
					rowsByTable: new Map(),
				},
			},
		);
		expect(result.valid).toBe(true);
		expect(result.presentation.nodes).toMatchObject([
			{
				path: "visits",
				children: [
					{
						kind: "repeat-instance",
						path: "visits[0]",
						label: `${heading} 1`,
						children: [
							{ path: "visits[0]/note", fallbackLabel: `${question} 1.` },
						],
					},
					{
						kind: "repeat-instance",
						path: "visits[1]",
						label: `${heading} 2`,
						children: [
							{ path: "visits[1]/note", fallbackLabel: `${question} 1.` },
						],
					},
				],
			},
		]);
		expect(
			result.fields
				.filter((field) => field.kind === "text")
				.map(({ path, value }) => ({ path, value })),
		).toEqual([
			{ path: "visits[0]/note", value: "first" },
			{ path: "visits[1]/note", value: "second" },
		]);
	}
	expect(doc).toEqual(before);
});

it("reports a bounded runtime cause when an expression expects one record but receives several", async () => {
	const doc = await createEvaluationApp(
		[
			{
				name: "Loans",
				caseType: "loan",
				forms: [{ name: "Inspect", type: "followup" }],
			},
		],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Loans",
					formUuid: "Inspect",
					fields: [
						{
							kind: "hidden",
							id: "record_name",
							calculate: "string(instance('casedb')/casedb/case/case_name)",
						},
					],
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Loans",
					formUuid: "Inspect",
					fieldUuid: "fixture_placeholder",
				},
			},
		],
	);
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Inspect",
	)?.uuid;
	const identity = previewAsMe({ id: "member", name: "Member" }, doc);
	if (!formUuid || !identity)
		throw new Error("Evaluation fixture is incomplete.");
	const records = [{ id: "first", caseType: "loan" }];
	const run = () =>
		evaluateForm(
			doc,
			{ formUuid, caseIds: ["first"], answers: [] },
			{
				identity,
				device: webAppsDevice(),
				cases: evaluationScenarioCases(doc, identity.ownerId, { records }),
				lookup: {
					projectRevision: "0",
					definitions: [],
					rowsByTable: new Map(),
				},
			},
		);
	expect((await run()).valid).toBe(true);
	records.push({ id: "second", caseType: "loan" });
	await expect(run()).rejects.toMatchObject({
		fault: {
			path: "/data/record_name",
			code: "evaluation-failed",
			reason: { phase: "evaluation", kind: "nodeset-cardinality" },
		},
	});
});

it("evaluates worker-only validation, branch state and a proposed named record without changing the document", async () => {
	const doc = await createEvaluationApp(
		[
			{
				name: "People",
				caseType: "person",
				forms: [{ name: "Register", type: "registration" }],
			},
		],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "People",
					formUuid: "Register",
					fields: [
						{
							kind: "text",
							id: "name",
							label: "Name",
							required: true,
							validate: {
								expr: "regex(#form/name, '^[A-Z][a-z]+$')",
								msg: "Use a capitalized name",
							},
						},
						{ kind: "int", id: "age", label: "Age", required: true },
						{
							kind: "text",
							id: "guardian",
							label: "Guardian",
							relevant: "#form/age < 18",
							required: true,
							caseWrite: { caseType: "person", property: "guardian" },
						},
					],
				},
			},
			{
				toolName: "updateForm",
				input: {
					moduleUuid: "People",
					formUuid: "Register",
					recordName: "#form/name",
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "People",
					formUuid: "Register",
					fieldUuid: "fixture_placeholder",
				},
			},
		],
	);
	const before = structuredClone(doc);
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Register",
	)?.uuid;
	const identity = previewAsMe({ id: "member", name: "Member" }, doc);
	if (!identity || !formUuid)
		throw new Error("Evaluation fixture is incomplete.");
	const context = {
		identity,
		device: webAppsDevice(),
		cases: { rows: [], indices: [] },
		lookup: previewLookupData({
			projectRevision: "0",
			definitions: [],
			rowsByTable: new Map(),
		}),
	};
	const invalid = await evaluateForm(
		doc,
		{
			formUuid,
			answers: [
				{ path: "name", value: "ada" },
				{ path: "age", value: "17" },
			],
		},
		context,
	);
	expect(invalid.valid).toBe(false);
	expect(invalid).not.toHaveProperty("submission");
	expect(invalid.fields).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				path: "name",
				valid: false,
				error: "Use a capitalized name",
			}),
			expect.objectContaining({
				path: "guardian",
				visible: true,
				required: true,
				valid: false,
			}),
		]),
	);
	const adult = await evaluateForm(
		doc,
		{
			formUuid,
			answers: [
				{ path: "name", value: "Ada" },
				{ path: "age", value: "18" },
			],
		},
		context,
	);
	expect(adult.valid).toBe(true);
	expect(adult.fields).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ path: "guardian", visible: false }),
		]),
	);
	expect(adult.submission).toMatchObject({ kind: "registration" });
	// The answer that names the new case reaches the case changes.
	expect(answerOf(doc, adult.submission, "name")).toBe("Ada");
	expect(doc).toEqual(before);
	await expect(
		evaluateForm(
			doc,
			{ formUuid, answers: [{ path: "missing", value: "x" }] },
			context,
		),
	).rejects.toBeInstanceOf(FormEvaluationInputError);
});

it("evaluates separate repeat answers and refuses writes to a calculated value", async () => {
	const doc = await createEvaluationApp(
		[{ name: "Visits", forms: [{ name: "Checklist", type: "survey" }] }],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Visits",
					formUuid: "Checklist",
					fields: [
						{
							kind: "text",
							id: "delivering",
							label: "Delivering",
							default_value: "'yes'",
						},
						{
							kind: "repeat",
							id: "visits",
							label: "Visits",
							relevant: "#form/delivering = 'yes'",
							repeat: { mode: "user_controlled" },
						},
						{
							kind: "int",
							id: "rating",
							parentUuid: "visits",
							label: "Rating",
							required: true,
							validate: { expr: ". >= 1 and . <= 5", msg: "Use 1 through 5" },
						},
						{
							kind: "hidden",
							id: "total",
							calculate: "sum(#form/visits/rating)",
						},
					],
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Visits",
					formUuid: "Checklist",
					fieldUuid: "fixture_placeholder",
				},
			},
		],
	);
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Checklist",
	)?.uuid;
	const identity = previewAsMe({ id: "member" }, doc);
	if (!formUuid || !identity)
		throw new Error("Evaluation fixture is incomplete.");
	const context = {
		identity,
		device: webAppsDevice(),
		cases: { rows: [], indices: [] },
		lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
	};
	const empty = await evaluateForm(
		doc,
		{ formUuid, answers: [], repeats: [{ path: "visits", count: 0 }] },
		context,
	);
	expect(
		empty.presentation.nodes.find((node) => node.path === "visits"),
	).toMatchObject({
		repeatCount: 0,
		children: [],
	});
	expect(empty.fields.map(({ path }) => path)).not.toContain(
		"visits[0]/rating",
	);
	await expect(
		evaluateForm(
			doc,
			{
				formUuid,
				answers: [{ path: "visits[0]/rating", value: "4" }],
			},
			context,
		),
	).rejects.toThrow("Add that entry before answering its questions.");
	const result = await evaluateForm(
		doc,
		{
			formUuid,
			repeats: [{ path: "visits", count: 2 }],
			answers: [
				{ path: "visits[0]/rating", value: "2" },
				{ path: "visits[1]/rating", value: "4" },
			],
		},
		context,
	);
	expect(result.valid).toBe(true);
	expect(result.fields.map(({ path }) => path)).toEqual([
		"delivering",
		"visits",
		"visits[0]/rating",
		"visits[1]/rating",
		"total",
	]);
	expect(result.presentation.nodes).toMatchObject([
		{ path: "delivering", label: "Delivering", onCurrentPage: true },
		{
			path: "visits",
			label: "Visits",
			children: [
				{
					kind: "repeat-instance",
					index: 0,
					children: [{ path: "visits[0]/rating", label: "Rating" }],
				},
				{
					kind: "repeat-instance",
					index: 1,
					children: [{ path: "visits[1]/rating", label: "Rating" }],
				},
			],
		},
	]);
	expect(result.presentation.nodes).toHaveLength(2);
	expect(result.fields).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ path: "visits[0]/rating", value: "2" }),
			expect.objectContaining({ path: "visits[1]/rating", value: "4" }),
			expect.objectContaining({ path: "total", value: "6" }),
		]),
	);
	const hidden = await evaluateForm(
		doc,
		{
			formUuid,
			repeats: [{ path: "visits", count: 2 }],
			answers: [
				{ path: "visits[0]/rating", value: "0" },
				{ path: "visits[1]/rating", value: "0" },
				{ path: "delivering", value: "no" },
			],
		},
		context,
	);
	expect(hidden.valid).toBe(true);
	for (const path of ["visits", "visits[0]/rating", "visits[1]/rating"]) {
		const field = hidden.fields.find((f) => f.path === path);
		expect(field).toMatchObject({
			participates: false,
			visible: false,
			required: false,
			valid: true,
		});
		expect(field).not.toHaveProperty("error");
		expect(field).not.toHaveProperty("value");
	}
	expect(
		hidden.fields.find((f) => f.path === "visits[0]/rating"),
	).toMatchObject({
		retainedValue: "0",
	});
	expect(hidden.fields.find((f) => f.path === "total")).toMatchObject({
		kind: "hidden",
		participates: true,
		visible: false,
		value: "0",
	});
	await expect(
		evaluateForm(
			doc,
			{ formUuid, answers: [{ path: "total", value: "99" }] },
			context,
		),
	).rejects.toBeInstanceOf(FormEvaluationInputError);
});

it("honors the authored selection maximum for a form that closes several records", async () => {
	const doc = await createEvaluationApp(
		[
			{
				name: "Loans",
				caseType: "loan",
				forms: [{ name: "Return", type: "close" }],
			},
		],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Loans",
					formUuid: "Return",
					fields: [{ kind: "text", id: "note", label: "Note" }],
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Loans",
					formUuid: "Return",
					fieldUuid: "fixture_placeholder",
				},
			},
			{
				toolName: "configureCaseSelection",
				input: {
					moduleUuid: "Loans",
					selection: { kind: "multiple", maximum: 1 },
				},
			},
		],
		// Choosing several cases runs in Web Apps alone.
		{ runsOnlyOn: "web-apps" },
	);
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Return",
	)?.uuid;
	const identity = previewAsMe({ id: "member" }, doc);
	if (!formUuid || !identity)
		throw new Error("Evaluation fixture is incomplete.");
	const context = {
		identity,
		device: webAppsDevice(),
		cases: {
			rows: ["drill", "saw"].map((case_id) => ({
				case_id,
				app_id: doc.appId,
				case_type: "loan",
				owner_id: identity.ownerId,
				status: "open" as const,
				opened_on: null,
				modified_on: null,
				closed_on: null,
				case_name: case_id,
				external_id: null,
				parent_case_id: null,
				properties: {},
			})),
			indices: [],
		},
		lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
	};
	const allowed = await evaluateForm(
		doc,
		{ formUuid, answers: [], caseIds: ["drill"] },
		context,
	);
	expect(allowed.valid).toBe(true);
	expect(allowed.submission).toMatchObject({
		kind: "close",
		caseIds: ["drill"],
	});
	await expect(
		evaluateForm(
			doc,
			{ formUuid, answers: [], caseIds: ["drill", "saw"] },
			context,
		),
	).rejects.toBeInstanceOf(FormEvaluationInputError);
});

it("uses the running Search's date-range values in a no-matches registration", async () => {
	const inputUuid = testUuid("evaluation-dates");
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(
			inputUuid,
			"visit_date",
			"Dates",
			"date-range",
			"visit_date",
		),
	];
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "visit_date", label: "Date", data_type: "date" }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListMenuItem: {},
				caseSearchConfig: { formsReadSearch: true },
				caseListRegistrationForm: { formUuid: "evaluation-register" },
				caseListConfig: config,
				forms: [
					{
						uuid: "evaluation-register",
						name: "Register",
						type: "registration",
						fields: [
							f({
								id: "name",
								kind: "text",
								label: "Name",
								default_value: "#search/visit_date",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	expect(
		evaluatePreparedMutationCandidate(
			prepareMutationCandidate(doc, admitMutationBatch([])),
			LOOKUP_CONTEXT_UNAVAILABLE,
		).ok,
	).toBe(true);
	const formUuid = Object.values(doc.forms)[0].uuid;
	const identity = previewAsMe({ id: "worker" }, doc);
	if (!identity) throw new Error("Evaluation fixture is incomplete.");
	const result = await evaluateForm(
		doc,
		{
			formUuid,
			answers: [],
			searchAnswers: [
				{ name: "visit_date:from", value: "2025-01-02" },
				{ name: "visit_date:to", value: "2025-03-04" },
			],
		},
		{
			identity,
			device: webAppsDevice(),
			cases: { rows: [], indices: [] },
			lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		},
	);
	expect(result.valid).toBe(true);
	expect(result.fields).toContainEqual(
		expect.objectContaining({
			path: "name",
			value: "__range__2025-01-02__2025-03-04",
		}),
	);
});

it("continues an entry without rerunning defaults, its query rows following the answer they read", async () => {
	const doc = await createEvaluationApp(
		[
			{
				name: "Equipment",
				caseType: "equipment",
				forms: [{ name: "Inspect", type: "followup" }],
			},
		],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Inspect",
					fields: [
						{
							kind: "text",
							id: "ids",
							label: "Parts",
							// The query snapshot runs before the late case preload.
							// Give this retention fixture an earlier initialization action.
							default_value: "#equipment/ids",
							caseWrite: { caseType: "equipment", property: "ids" },
						},
						{
							kind: "text",
							id: "token",
							label: "Inspection token",
							default_value: "uuid()",
						},
						{
							kind: "repeat",
							id: "parts",
							label: "Parts",
							repeat: { mode: "query_bound", ids_query: "string(#form/ids)" },
						},
						{
							kind: "hidden",
							id: "part_id",
							parentUuid: "parts",
							calculate: "current()/../@id",
						},
						{
							kind: "text",
							id: "condition",
							parentUuid: "parts",
							label: "Condition",
						},
					],
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Inspect",
					fieldUuid: "fixture_placeholder",
				},
			},
		],
	);
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Inspect",
	)?.uuid;
	const identity = previewAsMe({ id: "member" }, doc);
	if (!formUuid || !identity)
		throw new Error("Evaluation fixture is incomplete.");
	const context = {
		identity,
		device: webAppsDevice(),
		cases: evaluationScenarioCases(doc, identity.ownerId, {
			records: [
				{
					id: "pump",
					caseType: "equipment",
					properties: { ids: "rotor seal" },
				},
			],
		}),
		lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		captureEntry: true,
	};
	const opened = await evaluateForm(
		doc,
		{ formUuid, caseIds: ["pump"], answers: [] },
		context,
	);
	expect(
		opened.fields
			.filter((field) => field.path.endsWith("/part_id"))
			.map((field) => field.value),
	).toEqual(["rotor", "seal"]);
	const changed = await evaluateForm(
		doc,
		{ formUuid, caseIds: ["pump"], answers: [{ path: "ids", value: "rotor" }] },
		{ ...context, entry: opened.entry },
	);
	const resumed = await evaluateForm(
		doc,
		{
			formUuid,
			caseIds: ["pump"],
			answers: [{ path: "parts[0]/condition", value: "Replace" }],
		},
		{ ...context, entry: changed.entry },
	);
	expect(resumed.fields.find((field) => field.path === "token")?.value).toBe(
		opened.fields.find((field) => field.path === "token")?.value,
	);
	// The query reads an answer, so its rows follow it: the entry keeps both
	// rows, and the one past the end of the new result leaves the form.
	expect(
		resumed.fields
			.filter((field) => field.path.endsWith("/part_id"))
			.map((field) => [field.participates, field.value]),
	).toEqual([
		[true, "rotor"],
		[false, undefined],
	]);
	expect(
		resumed.fields.find((field) => field.path === "parts[0]/condition")?.value,
	).toBe("Replace");
	expect(resumed.entry?.entryKey).toBe(opened.entry?.entryKey);
});

it("uses location-picker coordinates and separates malformed test answers from authored validation", async () => {
	const doc = await createEvaluationApp(
		[
			{
				name: "Sites",
				caseType: "site",
				forms: [{ name: "Register", type: "registration" }],
			},
		],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Sites",
					formUuid: "Register",
					fields: [
						{ kind: "text", id: "name", label: "Name", required: true },
						{
							kind: "geopoint",
							id: "location",
							label: "Location",
							required: true,
							caseWrite: { caseType: "site", property: "location" },
						},
					],
				},
			},
			{
				toolName: "updateForm",
				input: {
					moduleUuid: "Sites",
					formUuid: "Register",
					recordName: "#form/name",
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Sites",
					formUuid: "Register",
					fieldUuid: "fixture_placeholder",
				},
			},
		],
	);
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Register",
	)?.uuid;
	const identity = previewAsMe({ id: "member", name: "Member" }, doc);
	if (!identity || !formUuid)
		throw new Error("Missing evaluation identity or form");
	const context = {
		identity,
		device: webAppsDevice(),
		cases: { rows: [], indices: [] },
		lookup: {
			projectRevision: "0",
			definitions: [],
			rowsByTable: new Map(),
		},
	};
	const picked = await evaluateForm(
		doc,
		{
			formUuid,
			answers: [
				{ path: "name", value: "Site" },
				{
					path: "location",
					value: { latitude: 12.3456789, longitude: -45.1234567 },
				},
			],
		},
		context,
	);
	expect(picked.valid).toBe(true);
	expect(
		picked.fields.find((field) => field.path === "location"),
	).toMatchObject({
		interaction: "location-picker",
		value: "12.3456789 -45.1234567 0.0 0.0",
	});
	expect(answerOf(doc, picked.submission, "location")).toBe(
		"12.3456789 -45.1234567 0.0 0.0",
	);
	for (const answer of [
		{ path: "location", value: "12.3 -45.1" },
		{ path: "location", value: "12  34 0 0" },
		{ path: "location", value: " 12 34 0 0 " },
		{ path: "location", value: "0x10 34 0 0" },
		{ path: "location", value: " " },
		{ path: "location", value: { latitude: 91, longitude: 0 } },
		{ path: "name", value: { latitude: 12, longitude: 3 } },
	]) {
		await expect(
			evaluateForm(doc, { formUuid, answers: [answer] }, context),
		).rejects.toBeInstanceOf(FormEvaluationInputError);
	}
	const cleared = await evaluateForm(
		doc,
		{
			formUuid,
			answers: [
				{ path: "name", value: "Site" },
				{ path: "location", value: "" },
			],
		},
		context,
	);
	expect(cleared.valid).toBe(false);
	expect(
		cleared.fields.find((field) => field.path === "location"),
	).toMatchObject({
		visible: true,
		required: true,
		valid: false,
	});
	expect(cleared).not.toHaveProperty("submission");
});

it("reports a starting value CommCare refuses as a form refusal across the worker", async () => {
	const doc = await createEvaluationApp(
		[{ name: "Visits", forms: [{ name: "Count", type: "survey" }] }],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Visits",
					formUuid: "Count",
					fields: [
						{
							kind: "text",
							id: "seed",
							label: "Seed",
							default_value: "'many'",
						},
						{
							kind: "int",
							id: "visits",
							label: "Visits",
							default_value: "#form/seed",
						},
					],
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Visits",
					formUuid: "Count",
					fieldUuid: "fixture_placeholder",
				},
			},
		],
	);
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Count",
	)?.uuid;
	const visits = Object.values(doc.fields).find(
		(field) => field.id === "visits",
	);
	const identity = previewAsMe({ id: "member" }, doc);
	if (!formUuid || !visits || !identity)
		throw new Error("Evaluation fixture is incomplete.");
	const refusal = evaluateForm(
		doc,
		{ formUuid, answers: [] },
		{
			identity,
			device: webAppsDevice(),
			cases: { rows: [], indices: [] },
			lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		},
	);
	await expect(refusal).rejects.toBeInstanceOf(FormRefusedError);
	await expect(refusal).rejects.toBeInstanceOf(FormEvaluationInputError);
	await expect(refusal).rejects.toMatchObject({
		message:
			"This form can't open yet. The starting value of “Visits” works out to “many”, which isn't a whole number, so CommCare won't open the form. You can change the question's starting value so it gives a whole number.",
		refusal: {
			kind: "form-refused",
			cause: "starting-value",
			fieldUuid: visits.uuid,
			path: "/data/visits",
			value: "many",
			answerType: "int",
		},
	});
});

it("evaluates questions in a private registration before its record name is authored", async () => {
	const doc = structuredClone(
		await createEvaluationApp(
			[
				{
					name: "Patients",
					caseType: "patient",
					forms: [{ name: "Register", type: "registration" }],
				},
			],
			[],
		),
	);
	const form = Object.values(doc.forms).find(
		(form) => form.name === "Register",
	);
	if (!form) throw new Error("Missing registration");
	const own = form.caseOperations?.find((op) => op.action === "own");
	if (own?.action !== "own") throw new Error("Missing own operation");
	delete own.name;
	const identity = previewAsMe({ id: "member" }, doc);
	if (!identity) throw new Error("Missing worker");
	const result = await evaluateForm(
		doc,
		{ formUuid: form.uuid, answers: [] },
		{
			identity,
			device: webAppsDevice(),
			cases: { rows: [], indices: [] },
			lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		},
	);
	expect(result).toHaveProperty("presentation");
});

it("visits the worker's field-list page before accepting a question submitted under the preceding page", async () => {
	const first = testUuid("submitted-early");
	const doc = buildDoc({
		modules: [
			{
				name: "Visit",
				forms: [
					{
						name: "Review",
						type: "survey",
						fields: [
							f({
								kind: "group",
								uuid: first,
								id: "first",
								fieldList: true,
								children: [
									f({
										kind: "text",
										id: "gate",
										label: "Name",
										required: "true()",
									}),
								],
							}),
							f({
								kind: "group",
								id: "second",
								fieldList: true,
								children: [
									f({
										kind: "text",
										id: "answer",
										label: "Outcome",
										submissionPlacement: { parent: first },
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = Object.values(doc.forms)[0].uuid;
	const identity = previewAsMe({ id: "member" }, doc);
	if (!identity) throw new Error("The worker is missing.");
	const context = {
		identity,
		device: androidDevice(),
		cases: { rows: [], indices: [] },
		lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		captureEntry: true,
	};
	const open = await evaluateForm(doc, { formUuid, answers: [] }, context);
	expect(open.screens.find((s) => s.current)?.path).toBe("/data/first");
	const answer = { path: "first/answer", value: "Visited" };
	await expect(
		evaluateForm(
			doc,
			{ formUuid, answers: [answer] },
			{ ...context, entry: open.entry },
		),
	).rejects.toThrow("A question before this one needs an answer first.");
	const recorded = await evaluateForm(
		doc,
		{ formUuid, answers: [{ path: "first/gate", value: "Jo" }, answer] },
		{ ...context, entry: open.entry },
	);
	expect(recorded.screens.find((s) => s.current)?.path).toBe("/data/second");
	expect(recorded.fields.find((f) => f.path === answer.path)).toMatchObject({
		value: "Visited",
		onCurrentPage: true,
	});
});

it.each([webAppsDevice(), androidDevice()])(
	"retains messages until the worker commits their actual screen or submits on $platform",
	async (device) => {
		const doc = buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Checklist",
							type: "survey",
							fields: [
								f({
									kind: "group",
									id: "opening",
									fieldList: true,
									children: [
										f({ kind: "text", id: "note" }),
										f({
											kind: "label",
											id: "notice",
											label: "Read the instructions",
										}),
									],
								}),
								f({
									kind: "group",
									id: "finish",
									fieldList: true,
									children: [
										f({
											kind: "label",
											id: "consent",
											label: "Check your answers",
											askForConfirmation: true,
										}),
										f({
											kind: "text",
											id: "extra",
											relevant: "#form/finish/consent = 'OK'",
										}),
										f({ kind: "label", id: "closing", label: "Thank you" }),
									],
								}),
							],
						},
					],
				},
			],
		});
		const formUuid = Object.values(doc.forms)[0].uuid;
		const identity = previewAsMe({ id: "member" }, doc);
		if (!identity) throw new Error("Missing worker identity");
		const context = {
			identity,
			device,
			cases: { rows: [], indices: [] },
			lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
			captureEntry: true,
		};
		const observe = (
			entry?: Awaited<ReturnType<typeof evaluateForm>>["entry"],
			answers: { path: string; value: string }[] = [],
			screenPath?: string,
			submitEntry = false,
		) =>
			evaluateForm(
				doc,
				{ formUuid, answers, screenPath },
				{ ...context, entry, submitEntry },
			);
		const opened = await observe();
		const changed = await observe(opened.entry, [
			{ path: "opening/note", value: "Read at the visit" },
		]);
		for (const result of [opened, changed]) {
			expect(
				result.fields.find((field) => field.path === "opening/notice")?.value,
			).toBe("");
			expect(
				result.fields.find((field) => field.path === "finish/extra")?.visible,
			).toBe(false);
			expect(result.entry?.checkpoint.state["/data/finish/closing"].value).toBe(
				"",
			);
			expect(result.entry?.checkpoint.state["/data/finish/consent"].value).toBe(
				"",
			);
		}
		let entry = changed.entry;
		if (device.platform === "android") {
			const next = await observe(entry, [], "/data/finish");
			expect(next.entry?.checkpoint.state["/data/opening/notice"].value).toBe(
				"OK",
			);
			expect(next.entry?.checkpoint.state["/data/finish/closing"].value).toBe(
				"",
			);
			const checked = await observe(next.entry, [
				{ path: "finish/consent", value: "OK" },
			]);
			expect(
				checked.fields.find((field) => field.path === "finish/extra")?.visible,
			).toBe(true);
			entry = checked.entry;
		}
		const submitted = await observe(entry, [], undefined, true);
		expect(submitted.submission).toBeDefined();
		for (const path of ["opening/notice", "finish/consent", "finish/closing"])
			expect(submitted.entry?.checkpoint.state[`/data/${path}`].value).toBe(
				"OK",
			);
		expect(
			submitted.fields.find((field) => field.path === "finish/extra")?.visible,
		).toBe(true);
	},
);

it("changes repeat rows only while their control is reachable and retains hidden rows on resume", async () => {
	const form = testUuid("repeat-edit-form");
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Roster",
						type: "survey",
						fields: [
							f({ kind: "text", id: "open" }),
							f({
								kind: "group",
								id: "visible_group",
								relevant: "#form/open = 'yes'",
								children: [
									f({
										kind: "repeat",
										id: "roster",
										repeat_mode: "user_controlled",
										children: [f({ kind: "text", id: "note" })],
									}),
								],
							}),
							f({ kind: "text", id: "last" }),
						],
					},
				],
			},
		],
	});
	const identity = previewAsMe({ id: "member" }, doc);
	if (!identity) throw new Error("Missing worker identity");
	const context = {
		identity,
		device: webAppsDevice(),
		cases: { rows: [], indices: [] },
		lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		captureEntry: true,
	};
	const repeatPath = "visible_group/roster";
	const notePath = `${repeatPath}[0]/note`;
	const observe = (
		entry?: Awaited<ReturnType<typeof evaluateForm>>["entry"],
		count?: number,
		answers: { path: string; value: string }[] = [],
	) =>
		evaluateForm(
			doc,
			{
				formUuid: form,
				answers,
				repeats:
					count === undefined ? undefined : [{ path: repeatPath, count }],
			},
			{ ...context, entry },
		);
	const closed = await observe();
	await expect(observe(closed.entry, 1)).rejects.toThrow(
		`Open the page with repeat ${repeatPath}`,
	);
	const opened = await observe(closed.entry, undefined, [
		{ path: "open", value: "yes" },
	]);
	const edited = await observe(opened.entry, 1, [
		{ path: notePath, value: "Keep me" },
	]);
	const hidden = await observe(edited.entry, undefined, [
		{ path: "open", value: "no" },
	]);
	await expect(observe(hidden.entry, 0)).rejects.toThrow(
		`Open the page with repeat ${repeatPath}`,
	);
	const returned = await observe(hidden.entry, undefined, [
		{ path: "open", value: "yes" },
	]);
	expect(returned.fields.find((field) => field.path === notePath)?.value).toBe(
		"Keep me",
	);
	const removed = await observe(returned.entry, 0);
	expect(
		removed.fields.find((field) => field.path === repeatPath)?.repeatCount,
	).toBe(0);
});

it("requires the Android repeat invitation and its preceding answers before adding nested entries", async () => {
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Roster",
						type: "survey",
						fields: [
							f({ kind: "text", id: "opening" }),
							f({ kind: "text", id: "gate", required: "true()" }),
							f({
								kind: "repeat",
								id: "roster",
								repeat_mode: "user_controlled",
								children: [
									f({ kind: "text", id: "name" }),
									f({
										kind: "repeat",
										id: "visits",
										repeat_mode: "user_controlled",
										children: [f({ kind: "text", id: "note" })],
									}),
								],
							}),
							f({ kind: "text", id: "last" }),
						],
					},
				],
			},
		],
	});
	const formUuid = Object.values(doc.forms)[0].uuid;
	const identity = previewAsMe({ id: "member" }, doc);
	if (!identity) throw new Error("Missing worker identity");
	const context = {
		identity,
		device: androidDevice(),
		cases: { rows: [], indices: [] },
		lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		captureEntry: true,
	};
	const opened = await evaluateForm(doc, { formUuid, answers: [] }, context);
	const request = (entry: typeof opened.entry, path: string) =>
		evaluateForm(
			doc,
			{ formUuid, answers: [], repeats: [{ path, count: 1 }] },
			{ ...context, entry },
		);
	await expect(request(opened.entry, "roster")).rejects.toThrow(
		"Open the page",
	);
	await expect(request(opened.entry, "roster[0]/visits")).rejects.toThrow(
		"containing entry first",
	);
	const gate = await evaluateForm(
		doc,
		{ formUuid, answers: [], screenPath: "/data/gate" },
		{ ...context, entry: opened.entry },
	);
	await expect(request(gate.entry, "roster")).rejects.toThrow("Open the page");
	const ready = await evaluateForm(
		doc,
		{ formUuid, answers: [{ path: "gate", value: "done" }] },
		{ ...context, entry: gate.entry },
	);
	const first = await request(ready.entry, "roster");
	expect(
		first.fields.find((field) => field.path === "roster")?.repeatCount,
	).toBe(1);
	await expect(request(first.entry, "roster[0]/visits")).rejects.toThrow(
		"Open the page",
	);
	const inside = await evaluateForm(
		doc,
		{ formUuid, answers: [{ path: "roster[0]/name", value: "Lee" }] },
		{ ...context, entry: first.entry },
	);
	const nested = await request(inside.entry, "roster[0]/visits");
	expect(
		nested.fields.find((field) => field.path === "roster[0]/visits")
			?.repeatCount,
	).toBe(1);
});
