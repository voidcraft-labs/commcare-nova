/**
 * `guardedMutate` — the one write path every mutating shared tool routes
 * through. The contract under test:
 *
 *   - a batch the gate rejects persists NOTHING (`recordMutations`
 *     never fires) and returns the person-to-person error;
 *   - a passing batch persists exactly once, with the post-batch doc and
 *     the caller's stage tag;
 *   - completeness gates like soundness — an entity lands with what
 *     makes it complete, or not at all;
 *   - tool-level integration: an `editField` carrying an unparseable
 *     XPath fails the call with `{ error }` and an unchanged doc.
 *
 * The chat and MCP surfaces share these tool bodies, so this single
 * layer is what gives both per-call gating.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	makeToolWorkspaceHarness,
	type ToolWorkspaceHarness,
} from "../../__tests__/fixtures";
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
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: { caseType: "patient", property: "village" },
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
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
				],
			},
		],
	});
}

/** Drive a DIRECT `guardedMutate` call through the workspace — the same
 *  `invoke` path a tool body runs under, so the helper receives the live
 *  `ToolInvocationContext` bound to the workspace's current snapshot. The
 *  harness's `recordMutations` / `recordMutationStages` spies are the
 *  assertion surfaces; nothing here touches Postgres. Both return the
 *  `{ events, committedDoc }` shape the guarded writer surfaces, echoing the
 *  prepared candidate's post-mutation doc as the committed doc (the real
 *  writer's hydrated `nextDoc` — here with no concurrent peer edit to
 *  merge). */
function runGuarded(
	harness: ToolWorkspaceHarness,
	mutations: unknown,
	stage?: string,
) {
	return harness.workspace.invoke({
		toolName: "test-tool",
		execute: (ctx) => guardedMutate(ctx, mutations, stage),
	});
}

function badRelevantMutation(doc: BlueprintDoc): Mutation[] {
	const target = Object.values(doc.fields).find((fl) => fl.id === "village");
	return [
		{
			kind: "updateField",
			uuid: target?.uuid,
			targetKind: "text",
			patch: { relevant: xp("if(") },
		} as Mutation,
	];
}

function villageAddress(doc: BlueprintDoc) {
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const fieldUuid = Object.values(doc.fields).find(
		(field) => field.id === "village",
	)?.uuid;
	if (!fieldUuid) throw new Error("fixture missing village");
	return { moduleUuid, formUuid, fieldUuid };
}

describe("guardedMutate", () => {
	it("persists a passing batch once, with the post-batch doc and stage tag", async () => {
		const doc = minDoc();
		const h = makeToolWorkspaceHarness(doc);
		const target = Object.values(doc.fields).find((fl) => fl.id === "village");
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: target?.uuid,
				targetKind: "text",
				patch: { label: proseText("Home village") },
			} as Mutation,
		];

		const outcome = await runGuarded(h, mutations, "form:0-0");

		expect(outcome.ok).toBe(true);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		const [prepared, stage] = h.recordMutations.mock.calls[0] ?? [];
		expect(prepared?.mutations).toEqual(mutations);
		expect(stage).toBe("form:0-0");
		// The persisted doc IS the post-batch doc the tool continues against.
		if (outcome.ok) expect(prepared?.nextDoc).toBe(outcome.newDoc);
	});

	it("persists nothing on a gate rejection and returns the findings as prose", async () => {
		const doc = minDoc();
		const h = makeToolWorkspaceHarness(doc);

		const outcome = await runGuarded(h, badRelevantMutation(doc), "form:0-0");

		expect(outcome.ok).toBe(false);
		expect(h.recordMutations).not.toHaveBeenCalled();
		if (!outcome.ok) {
			expect(outcome.error).toContain("This change wasn't applied");
			expect(outcome.error).toContain("Nothing was changed.");
		}
	});

	it("rejects a completeness introduction — an empty form never lands", async () => {
		const doc = minDoc();
		const addEmptyForm: Mutation[] = [
			{
				kind: "addForm",
				moduleUuid: doc.moduleOrder[0],
				form: {
					uuid: testUuid("form-new"),
					id: "form_new",
					name: "Empty survey",
					type: "survey",
				} as never,
			},
		];

		const h = makeToolWorkspaceHarness(doc);
		const rejected = await runGuarded(h, addEmptyForm);
		expect(rejected.ok).toBe(false);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("skips persistence entirely for an empty batch", async () => {
		const doc = minDoc();
		const h = makeToolWorkspaceHarness(doc);
		const outcome = await runGuarded(h, []);
		expect(outcome).toEqual({ ok: true, newDoc: doc, mutations: [] });
		expect(h.recordMutations).not.toHaveBeenCalled();
	});
});

describe("tool-level gating (editField through the shared layer)", () => {
	it("fails the call with { error } and persists nothing when the patch introduces a soundness error", async () => {
		const doc = minDoc();
		const h = makeToolWorkspaceHarness(doc);

		const out = await h.runTool(editFieldTool, {
			...villageAddress(doc),
			updates: { kind: "text", relevant: xp("if(") },
		});

		expect(out.kind).toBe("mutate");
		expect(out.mutations).toEqual([]);
		expect(h.currentDoc()).toBe(doc);
		expect("error" in out.result && out.result.error).toContain(
			"This change wasn't applied",
		);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("an ID-changing edit is atomic — a bad sibling property leaves zero committed prefix", async () => {
		// The ID change alone is valid; the relevant expression introduces
		// XPATH_SYNTAX. The whole updateField patch gates as ONE candidate,
		// so the ID change must NOT commit — nothing persists, the doc is untouched,
		// and the agent can re-issue the corrected call from the original
		// state ("a rejected call saved nothing" holds with no asterisk).
		const doc = minDoc();
		const h = makeToolWorkspaceHarness(doc);

		const out = await h.runTool(editFieldTool, {
			...villageAddress(doc),
			updates: {
				kind: "text",
				id: "village_name",
				relevant: xp("if("),
			},
		});

		expect("error" in out.result && out.result.error).toContain(
			"This change wasn't applied",
		);
		expect(out.mutations).toEqual([]);
		expect(h.currentDoc()).toBe(doc);
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(h.recordMutationStages).not.toHaveBeenCalled();
		// The rename never landed.
		const renamed = Object.values(doc.fields).find(
			(fl) => fl.id === "village_name",
		);
		expect(renamed).toBeUndefined();
	});

	it("a passing ID-and-property edit persists as one canonical update stage", async () => {
		const doc = minDoc();
		const h = makeToolWorkspaceHarness(doc);

		const out = await h.runTool(editFieldTool, {
			...villageAddress(doc),
			updates: {
				kind: "text",
				id: "village_name",
				label: proseText("Home village"),
			} as never,
		});

		expect("message" in out.result).toBe(true);
		// One persistence call, with ID and label carried by the same
		// target-kind-aware updateField stage.
		expect(h.recordMutationStages).toHaveBeenCalledTimes(1);
		const stages = h.recordMutationStages.mock.calls[0]?.[1] as {
			slices: readonly { stage?: string }[];
		};
		const formUuid = villageAddress(doc).formUuid;
		expect(stages.slices.map((s) => s.stage)).toEqual([`edit:${formUuid}`]);
	});

	it("commits a clean edit unchanged (the gate is transparent on pass)", async () => {
		const doc = minDoc();
		const h = makeToolWorkspaceHarness(doc);

		const out = await h.runTool(editFieldTool, {
			...villageAddress(doc),
			updates: { kind: "text", label: proseText("Home village") },
		});

		expect("message" in out.result).toBe(true);
		expect(out.mutations.length).toBeGreaterThan(0);
		expect(h.recordMutationStages).toHaveBeenCalledTimes(1);
	});
});
