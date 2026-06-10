/**
 * `guardedMutate` — the one write path every mutating shared tool routes
 * through. The contract under test:
 *
 *   - a batch the gate rejects persists NOTHING (`ctx.recordMutations`
 *     never fires) and returns the person-to-person error;
 *   - a passing batch persists exactly once, with the post-batch doc and
 *     the caller's stage tag;
 *   - the phase comes from `ctx.commitPhase` (building defers
 *     completeness, complete ratchets it);
 *   - tool-level integration: an `editField` carrying an unparseable
 *     XPath fails the call with `{ error }` and an unchanged doc.
 *
 * The chat and MCP surfaces share these tool bodies, so this single
 * layer is what gives both per-call gating.
 */

import { describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { guardedMutate } from "../common";
import { editFieldTool } from "../editField";

/** Minimal valid doc: one registration module/form writing two properties. */
function minDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Test",
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Form",
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

/** Bare `ToolExecutionContext` stub — `recordMutations` (single-batch
 *  tools) and `recordMutationStages` (multi-stage tools) are the
 *  assertion surfaces; nothing here touches Firestore. */
function makeCtx(phase: "building" | "complete") {
	const recordMutations = vi.fn().mockResolvedValue([]);
	const recordMutationStages = vi.fn().mockResolvedValue([]);
	const ctx: ToolExecutionContext = {
		appId: "app-1",
		userId: "user-1",
		runId: "run-1",
		commitPhase: phase,
		recordMutations,
		recordMutationStages,
		recordConversation: vi.fn(),
	};
	return { ctx, recordMutations, recordMutationStages };
}

function badRelevantMutation(doc: BlueprintDoc): Mutation[] {
	const target = Object.values(doc.fields).find((fl) => fl.id === "village");
	return [
		{
			kind: "updateField",
			uuid: target?.uuid,
			targetKind: "text",
			patch: { relevant: "if(" },
		} as Mutation,
	];
}

describe("guardedMutate", () => {
	it("persists a passing batch once, with the post-batch doc and stage tag", async () => {
		const doc = minDoc();
		const { ctx, recordMutations } = makeCtx("complete");
		const target = Object.values(doc.fields).find((fl) => fl.id === "village");
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: target?.uuid,
				targetKind: "text",
				patch: { label: "Home village" },
			} as Mutation,
		];

		const outcome = await guardedMutate(ctx, doc, mutations, "form:0-0");

		expect(outcome.ok).toBe(true);
		expect(recordMutations).toHaveBeenCalledTimes(1);
		const [persistedMuts, persistedDoc, stage] =
			recordMutations.mock.calls[0] ?? [];
		expect(persistedMuts).toBe(mutations);
		expect(stage).toBe("form:0-0");
		// The persisted doc IS the post-batch doc the tool continues against.
		if (outcome.ok) expect(persistedDoc).toBe(outcome.newDoc);
	});

	it("persists nothing on a gate rejection and returns the findings as prose", async () => {
		const doc = minDoc();
		const { ctx, recordMutations } = makeCtx("building");

		const outcome = await guardedMutate(
			ctx,
			doc,
			badRelevantMutation(doc),
			"form:0-0",
		);

		expect(outcome.ok).toBe(false);
		expect(recordMutations).not.toHaveBeenCalled();
		if (!outcome.ok) {
			expect(outcome.error).toContain("This change wasn't applied");
			expect(outcome.error).toContain("Nothing was changed.");
		}
	});

	it("defers completeness while building, ratchets it when complete", async () => {
		const doc = minDoc();
		const addEmptyForm: Mutation[] = [
			{
				kind: "addForm",
				moduleUuid: doc.moduleOrder[0],
				form: {
					uuid: asUuid("form-new"),
					id: "form_new",
					name: "Empty survey",
					type: "survey",
				} as never,
			},
		];

		const building = makeCtx("building");
		const accepted = await guardedMutate(building.ctx, doc, addEmptyForm);
		expect(accepted.ok).toBe(true);
		expect(building.recordMutations).toHaveBeenCalledTimes(1);

		const complete = makeCtx("complete");
		const rejected = await guardedMutate(complete.ctx, doc, addEmptyForm);
		expect(rejected.ok).toBe(false);
		expect(complete.recordMutations).not.toHaveBeenCalled();
	});

	it("skips persistence entirely for an empty batch", async () => {
		const doc = minDoc();
		const { ctx, recordMutations } = makeCtx("complete");
		const outcome = await guardedMutate(ctx, doc, []);
		expect(outcome).toEqual({ ok: true, newDoc: doc });
		expect(recordMutations).not.toHaveBeenCalled();
	});
});

describe("tool-level gating (editField through the shared layer)", () => {
	it("fails the call with { error } and persists nothing when the patch introduces a soundness error", async () => {
		const doc = minDoc();
		const { ctx, recordMutations } = makeCtx("complete");

		const out = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "village",
				updates: { kind: "text", relevant: "if(" } as never,
			},
			ctx,
			doc,
		);

		expect(out.kind).toBe("mutate");
		expect(out.mutations).toEqual([]);
		expect(out.newDoc).toBe(doc);
		expect("error" in out.result && out.result.error).toContain(
			"This change wasn't applied",
		);
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("a multi-stage edit (rename + patch) is atomic — a bad patch leaves zero committed prefix", async () => {
		// The rename alone is valid; the relevant patch introduces
		// XPATH_SYNTAX. The whole edit gates as ONE candidate, so the
		// rename must NOT commit — nothing persists, the doc is untouched,
		// and the agent can re-issue the corrected call from the original
		// state ("a rejected call saved nothing" holds with no asterisk).
		const doc = minDoc();
		const { ctx, recordMutations, recordMutationStages } = makeCtx("complete");

		const out = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "village",
				updates: {
					kind: "text",
					id: "village_name",
					relevant: "if(",
				} as never,
			},
			ctx,
			doc,
		);

		expect("error" in out.result && out.result.error).toContain(
			"This change wasn't applied",
		);
		expect(out.mutations).toEqual([]);
		expect(out.newDoc).toBe(doc);
		expect(recordMutations).not.toHaveBeenCalled();
		expect(recordMutationStages).not.toHaveBeenCalled();
		// The rename never landed.
		const renamed = Object.values(doc.fields).find(
			(fl) => fl.id === "village_name",
		);
		expect(renamed).toBeUndefined();
	});

	it("a passing multi-stage edit persists as ONE save carrying each stage's own tag", async () => {
		const doc = minDoc();
		const { ctx, recordMutationStages } = makeCtx("complete");

		const out = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "village",
				updates: {
					kind: "text",
					id: "village_name",
					label: "Home village",
				} as never,
			},
			ctx,
			doc,
		);

		expect("message" in out.result).toBe(true);
		// One persistence call for the whole sequence — the stages ride
		// inside it, in order, each with its own tag.
		expect(recordMutationStages).toHaveBeenCalledTimes(1);
		const stages = recordMutationStages.mock.calls[0]?.[0] as Array<{
			stage?: string;
		}>;
		expect(stages.map((s) => s.stage)).toEqual(["rename:0-0", "edit:0-0"]);
	});

	it("commits a clean edit unchanged (the gate is transparent on pass)", async () => {
		const doc = minDoc();
		const { ctx, recordMutationStages } = makeCtx("complete");

		const out = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "village",
				updates: { kind: "text", label: "Home village" } as never,
			},
			ctx,
			doc,
		);

		expect("message" in out.result).toBe(true);
		expect(out.mutations.length).toBeGreaterThan(0);
		expect(recordMutationStages).toHaveBeenCalledTimes(1);
	});
});
