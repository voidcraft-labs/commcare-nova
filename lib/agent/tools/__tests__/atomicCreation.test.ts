/**
 * Atomic structural creation — `createForm` / `createModule` land an
 * entity TOGETHER with what makes it sound and complete, in one gated
 * batch. This is what makes the completeness ratchet livable on a
 * complete app: before these shapes, nothing could create a form
 * (EMPTY_FORM rejected the lone addForm) or a case-managing module
 * (NO_FORMS_OR_CASE_LIST in both phases; MISSING_CASE_LIST_COLUMNS on
 * complete) — every structural-creation path was a dead end. The tests
 * pin both directions: the atomic call commits on a complete app, and
 * the under-specified call is rejected with findings the SAME call can
 * satisfy.
 */

import { describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { createFormTool } from "../createForm";
import { createModuleTool } from "../createModule";

function makeCtx(phase: "building" | "complete") {
	const recordMutations = vi.fn().mockResolvedValue([]);
	const ctx: ToolExecutionContext = {
		appId: "app-1",
		userId: "user-1",
		runId: "run-1",
		commitPhase: phase,
		recordMutations,
		recordMutationStages: vi.fn().mockResolvedValue([]),
		getCompletionBasis: vi.fn().mockResolvedValue(null),
		recordConversation: vi.fn(),
	};
	return { ctx, recordMutations };
}

/** A COMPLETE app: one patient module, registration form, case list. */
function completeDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Clinic",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
		],
	});
}

describe("createForm — atomic form + fields", () => {
	it("grows a COMPLETE app: a followup form lands with its fields in one batch", async () => {
		const { ctx, recordMutations } = makeCtx("complete");
		const out = await createFormTool.execute(
			{
				moduleIndex: 0,
				name: "Follow up",
				type: "followup",
				fields: [
					{
						kind: "text",
						id: "visit_notes",
						label: "Visit notes",
						case_property_on: "patient",
					} as never,
				],
			},
			ctx,
			completeDoc(),
		);

		expect("message" in out.result).toBe(true);
		expect(recordMutations).toHaveBeenCalledTimes(1);
		// One batch: addForm + its addField(s) — no transitional empty form
		// ever exists on any surface.
		const kinds = out.mutations.map((m) => m.kind);
		expect(kinds[0]).toBe("addForm");
		expect(kinds).toContain("addField");
	});

	it("rejects a registration form missing its case_name writer with guidance THIS call can satisfy", async () => {
		const { ctx, recordMutations } = makeCtx("complete");
		const out = await createFormTool.execute(
			{
				moduleIndex: 0,
				name: "Enroll",
				type: "registration",
				fields: [
					{
						kind: "text",
						id: "village",
						label: "Village",
						case_property_on: "patient",
					} as never,
				],
			},
			ctx,
			completeDoc(),
		);

		expect("error" in out.result && out.result.error).toContain("case_name");
		expect(out.mutations).toEqual([]);
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("nests fields under a group created in the same call", async () => {
		const { ctx } = makeCtx("complete");
		const out = await createFormTool.execute(
			{
				moduleIndex: 0,
				name: "Assessment",
				type: "followup",
				fields: [
					{ kind: "group", id: "vitals", label: "Vitals" } as never,
					{
						kind: "decimal",
						id: "temperature",
						label: "Temperature",
						parentId: "vitals",
					} as never,
				],
			},
			ctx,
			completeDoc(),
		);

		expect("message" in out.result).toBe(true);
		const addFields = out.mutations.filter(
			(m): m is Extract<typeof m, { kind: "addField" }> =>
				m.kind === "addField",
		);
		const group = addFields.find((m) => m.field.id === "vitals");
		const child = addFields.find((m) => m.field.id === "temperature");
		expect(group).toBeDefined();
		expect(child?.parentUuid).toBe(group?.field.uuid);
	});
});

describe("createModule — atomic module + forms + case list", () => {
	it("grows a COMPLETE app: a case-managing module lands with forms and columns in one batch", async () => {
		const { ctx, recordMutations } = makeCtx("complete");
		const out = await createModuleTool.execute(
			{
				name: "Households",
				case_type: "household",
				forms: [
					{
						name: "Register household",
						type: "registration",
						fields: [
							{
								kind: "text",
								id: "case_name",
								label: "Household name",
								case_property_on: "household",
							} as never,
							{
								kind: "text",
								id: "head_of_household",
								label: "Head of household",
								case_property_on: "household",
							} as never,
						],
					},
				],
				case_list_columns: [
					{ kind: "plain", field: "case_name", header: "Name" } as never,
				],
			},
			ctx,
			completeDoc(),
		);

		expect("message" in out.result).toBe(true);
		expect(recordMutations).toHaveBeenCalledTimes(1);
		const kinds = out.mutations.map((m) => m.kind);
		expect(kinds[0]).toBe("addModule");
		expect(kinds).toContain("addForm");
		expect(kinds).toContain("addField");
		// The case-list columns ride the addModule entity itself.
		const addModule = out.mutations.find(
			(m): m is Extract<typeof m, { kind: "addModule" }> =>
				m.kind === "addModule",
		);
		expect(addModule?.module.caseListConfig?.columns).toHaveLength(1);
	});

	it("rejects a case-typed module with no forms in BOTH phases (forms belong in this call)", async () => {
		for (const phase of ["building", "complete"] as const) {
			const { ctx, recordMutations } = makeCtx(phase);
			const out = await createModuleTool.execute(
				{ name: "Households", case_type: "household" },
				ctx,
				completeDoc(),
			);
			expect("error" in out.result && out.result.error).toContain("forms");
			expect(recordMutations).not.toHaveBeenCalled();
		}
	});

	it("rejects a case-managing module without case-list columns on a complete app", async () => {
		const { ctx, recordMutations } = makeCtx("complete");
		const out = await createModuleTool.execute(
			{
				name: "Households",
				case_type: "household",
				forms: [
					{
						name: "Register household",
						type: "registration",
						fields: [
							{
								kind: "text",
								id: "case_name",
								label: "Household name",
								case_property_on: "household",
							} as never,
							{
								kind: "text",
								id: "head_of_household",
								label: "Head of household",
								case_property_on: "household",
							} as never,
						],
					},
				],
			},
			ctx,
			completeDoc(),
		);

		expect("error" in out.result && out.result.error).toContain("column");
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("still creates a plain (case-less) survey module the simple way", async () => {
		const { ctx } = makeCtx("complete");
		const out = await createModuleTool.execute(
			{
				name: "Feedback",
				forms: [
					{
						name: "Feedback survey",
						type: "survey",
						fields: [
							{ kind: "text", id: "comments", label: "Comments" } as never,
						],
					},
				],
			},
			ctx,
			completeDoc(),
		);
		expect("message" in out.result).toBe(true);
	});
});

// ── Atomic creation on complete Connect apps ─────────────────────────

/** A COMPLETE Connect learn app: every form carries its connect block. */
function completeConnectDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Training",
		connectType: "learn",
		modules: [
			{
				name: "Lessons",
				caseType: "trainee",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Enroll trainee",
						type: "registration",
						connect: {
							learn_module: {
								id: "enroll_module",
								name: "Enrollment",
								description: "Sign-up basics",
								time_estimate: 10,
							},
						},
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "trainee",
							}),
							f({
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "trainee",
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "trainee",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
		],
	});
}

describe("atomic creation on a complete Connect app", () => {
	it("createForm with a connect block commits in one batch", async () => {
		const { ctx, recordMutations } = makeCtx("complete");
		const out = await createFormTool.execute(
			{
				moduleIndex: 0,
				name: "Lesson two",
				type: "followup",
				fields: [
					{
						kind: "text",
						id: "lesson_notes",
						label: "Notes",
						case_property_on: "trainee",
					} as never,
				],
				connect: {
					learn_module: {
						id: "lesson_two",
						name: "Lesson two",
						description: "Follow-up content",
						time_estimate: 20,
					},
				},
			},
			ctx,
			completeConnectDoc(),
		);

		expect("message" in out.result).toBe(true);
		expect(recordMutations).toHaveBeenCalledTimes(1);
	});

	it("createForm WITHOUT a connect block is rejected with guidance the same call satisfies", async () => {
		const { ctx, recordMutations } = makeCtx("complete");
		const out = await createFormTool.execute(
			{
				moduleIndex: 0,
				name: "Lesson two",
				type: "followup",
				fields: [
					{
						kind: "text",
						id: "lesson_notes",
						label: "Notes",
						case_property_on: "trainee",
					} as never,
				],
			},
			ctx,
			completeConnectDoc(),
		);

		const error = "error" in out.result ? out.result.error : "";
		expect(error).toContain("Connect");
		// The named repair is satisfiable on THIS call — the creation tools
		// accept `connect` directly.
		expect(error).toContain("connect");
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("createModule lands forms with their connect blocks in one batch", async () => {
		const { ctx, recordMutations } = makeCtx("complete");
		const out = await createModuleTool.execute(
			{
				name: "Assessments",
				case_type: "assessment_case",
				forms: [
					{
						name: "Register assessment",
						type: "registration",
						fields: [
							{
								kind: "text",
								id: "case_name",
								label: "Assessment name",
								case_property_on: "assessment_case",
							} as never,
							{
								kind: "text",
								id: "topic",
								label: "Topic",
								case_property_on: "assessment_case",
							} as never,
						],
						connect: {
							learn_module: {
								id: "assessment_intro",
								name: "Assessment intro",
								description: "How scoring works",
								time_estimate: 5,
							},
						},
					},
				],
				case_list_columns: [
					{ kind: "plain", field: "case_name", header: "Name" } as never,
				],
			},
			ctx,
			completeConnectDoc(),
		);

		expect("message" in out.result).toBe(true);
		expect(recordMutations).toHaveBeenCalledTimes(1);
	});
});

// ── Connect-id source enforcement on the creation tools ──────────────
//
// The creation tools are connect-block writers, so they carry the same
// at-source id contract `updateForm` / `generateScaffold` hold: an
// omitted id is autofilled (valid, unique, name-derived, STORED on the
// doc) and an explicit invalid/duplicate id fails the call with nothing
// persisted. Nothing downstream supplies a default — the emit resolver
// throws on a missing id — so this enforcement is what makes the
// schema's "leave the id unset and Nova fills it in" description true.

describe("creation tools force connect ids correct at the source", () => {
	it("createForm autofills an omitted connect id from the module name, unique against stored ids", async () => {
		const { ctx } = makeCtx("complete");
		const out = await createFormTool.execute(
			{
				moduleIndex: 0,
				name: "Lesson two",
				type: "followup",
				fields: [
					{
						kind: "text",
						id: "lesson_notes",
						label: "Notes",
						case_property_on: "trainee",
					} as never,
				],
				connect: {
					learn_module: {
						// id omitted — the normal case the schema description promises.
						name: "Lesson two",
						description: "Follow-up content",
						time_estimate: 20,
					},
				},
			},
			ctx,
			completeConnectDoc(),
		);

		expect("message" in out.result).toBe(true);
		const addForm = out.mutations.find(
			(m): m is Extract<typeof m, { kind: "addForm" }> => m.kind === "addForm",
		);
		// Derived from the module name ("Lessons"), valid + unique vs the
		// stored "enroll_module".
		expect(addForm?.form.connect?.learn_module?.id).toBe("lessons");
	});

	it("createForm rejects an explicit duplicate connect id (nothing persisted)", async () => {
		const { ctx, recordMutations } = makeCtx("complete");
		const out = await createFormTool.execute(
			{
				moduleIndex: 0,
				name: "Lesson two",
				type: "followup",
				fields: [
					{
						kind: "text",
						id: "lesson_notes",
						label: "Notes",
						case_property_on: "trainee",
					} as never,
				],
				connect: {
					learn_module: {
						id: "enroll_module", // already taken by the stored form
						name: "Lesson two",
						description: "Follow-up content",
						time_estimate: 20,
					},
				},
			},
			ctx,
			completeConnectDoc(),
		);

		expect("error" in out.result && out.result.error).toContain(
			"enroll_module",
		);
		expect(out.mutations).toEqual([]);
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("createForm rejects an explicit XML-illegal connect id", async () => {
		const { ctx, recordMutations } = makeCtx("complete");
		const out = await createFormTool.execute(
			{
				moduleIndex: 0,
				name: "Lesson two",
				type: "followup",
				fields: [
					{
						kind: "text",
						id: "lesson_notes",
						label: "Notes",
						case_property_on: "trainee",
					} as never,
				],
				connect: {
					learn_module: {
						id: "bad id",
						name: "Lesson two",
						description: "Follow-up content",
						time_estimate: 20,
					},
				},
			},
			ctx,
			completeConnectDoc(),
		);

		expect("error" in out.result && out.result.error).toContain("bad id");
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("createModule autofills omitted ids uniquely across the call's own forms", async () => {
		// Two id-less learn_module blocks in ONE creation both derive from the
		// module name — the threaded id set must suffix the second, so the
		// batch can't be born with a duplicate.
		const { ctx } = makeCtx("complete");
		const out = await createModuleTool.execute(
			{
				name: "Refreshers",
				case_type: "refresher",
				forms: [
					{
						name: "Refresher one",
						type: "registration",
						fields: [
							{
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "refresher",
							} as never,
							{
								kind: "text",
								id: "topic_covered",
								label: "Topic covered",
								case_property_on: "refresher",
							} as never,
						],
						connect: {
							learn_module: {
								name: "Refresher one",
								description: "Part one",
								time_estimate: 5,
							},
						},
					},
					{
						name: "Refresher two",
						type: "followup",
						fields: [
							{
								kind: "text",
								id: "notes",
								label: "Notes",
								case_property_on: "refresher",
							} as never,
						],
						connect: {
							learn_module: {
								name: "Refresher two",
								description: "Part two",
								time_estimate: 5,
							},
						},
					},
				],
				case_list_columns: [
					{ kind: "plain", field: "case_name", header: "Name" } as never,
				],
			},
			ctx,
			completeConnectDoc(),
		);

		expect("message" in out.result).toBe(true);
		const ids = out.mutations
			.filter(
				(m): m is Extract<typeof m, { kind: "addForm" }> =>
					m.kind === "addForm",
			)
			.map((m) => m.form.connect?.learn_module?.id);
		expect(ids).toEqual(["refreshers", "refreshers_2"]);
	});

	it("createModule rejects an explicit duplicate id against a stored block (nothing persisted)", async () => {
		const { ctx, recordMutations } = makeCtx("complete");
		const out = await createModuleTool.execute(
			{
				name: "Refreshers",
				case_type: "refresher",
				forms: [
					{
						name: "Refresher one",
						type: "registration",
						fields: [
							{
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "refresher",
							} as never,
							{
								kind: "text",
								id: "topic_covered",
								label: "Topic covered",
								case_property_on: "refresher",
							} as never,
						],
						connect: {
							learn_module: {
								id: "enroll_module", // taken by the stored form
								name: "Refresher one",
								description: "Part one",
								time_estimate: 5,
							},
						},
					},
				],
				case_list_columns: [
					{ kind: "plain", field: "case_name", header: "Name" } as never,
				],
			},
			ctx,
			completeConnectDoc(),
		);

		expect("error" in out.result && out.result.error).toContain(
			"enroll_module",
		);
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("caps an id autofilled from a long module name at the 50-character slug limit", async () => {
		// LEEP regression: this module name's snake-id is 52 chars, over the
		// varchar(50) Connect column — the autofill must cap at derivation so
		// CONNECT_ID_TOO_LONG can never fire on an id the user didn't type.
		const { ctx } = makeCtx("complete");
		const out = await createModuleTool.execute(
			{
				name: "Module 3 — Conducting the 15-question seller interview",
				case_type: "seller",
				forms: [
					{
						name: "Interview",
						type: "registration",
						fields: [
							{
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "seller",
							} as never,
							{
								kind: "text",
								id: "stall_location",
								label: "Stall location",
								case_property_on: "seller",
							} as never,
						],
						connect: {
							learn_module: {
								name: "Interview",
								description: "Seller interview training",
								time_estimate: 15,
							},
						},
					},
				],
				case_list_columns: [
					{ kind: "plain", field: "case_name", header: "Name" } as never,
				],
			},
			ctx,
			completeConnectDoc(),
		);

		expect("message" in out.result).toBe(true);
		const addForm = out.mutations.find(
			(m): m is Extract<typeof m, { kind: "addForm" }> => m.kind === "addForm",
		);
		const id = addForm?.form.connect?.learn_module?.id as string;
		expect(id.length).toBeLessThanOrEqual(50);
	});
});
