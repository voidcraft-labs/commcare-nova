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
