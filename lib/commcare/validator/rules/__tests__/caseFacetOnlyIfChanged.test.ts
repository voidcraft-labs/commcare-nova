/**
 * A case's own name and owner saved only when changed
 * (`CaseFacetOnlyIfChanged`).
 *
 * Contract: CommCare HQ's build applies `update_mode: "edit"` to the `name`
 * and `owner_id` keys of an update map as to any other key
 * (`xform.py::XFormCaseBlock.add_case_updates`): a rename of a case the form
 * loaded, the owner of the form's own case, a child case's owner, a load's
 * name and owner and an open action's owner. Nova holds it as the
 * operation's `nameOnlyIfChanged`, `renameOnlyIfChanged` and
 * `ownerOnlyIfChanged`; the gate admits each where HQ applies it, the export
 * writes `edit` on the key, and the chat and MCP tools take each flag.
 *
 * The plausible failures: the gate refusing a flag HQ builds; the gate
 * admitting a flag with no facet, on a registration's own name (whose
 * `open_case.name_update` mode HQ's build never reads), on an owner that is
 * never blank, or through Save to Case; the export writing `always`; the
 * tools dropping the flag, so an edit by chat clears what a person set.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import {
	caseOperationInputSchema,
	ownOperationInputSchema,
	resolveCaseOperationInput,
	resolveOwnCaseOperationInput,
} from "@/lib/agent/tools/case-operations/shared";
import { updateCaseOperationTool } from "@/lib/agent/tools/case-operations/updateCaseOperation";
import { applyToDoc } from "@/lib/agent/tools/common";
import {
	childCreate,
	OP,
	OWN,
	own,
	placementFixture,
	read,
} from "@/lib/commcare/__tests__/placementFixture";
import { expandDoc } from "@/lib/commcare/expander";
import { planCaseOperationUpdate } from "@/lib/doc/caseOperationMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc, OwnCaseOperation } from "@/lib/domain";
import { actingUser } from "@/lib/domain/expression/builders";
import type { ValidationError } from "../../errors";
import { runValidation } from "../../runner";

function onlyIfChangedFindings(doc: BlueprintDoc): ValidationError[] {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
		(error) => error.code === "CASE_WRITE_ONLY_IF_CHANGED_INVALID",
	);
}

function allCodes(doc: BlueprintDoc): string[] {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
		(error) => error.code,
	);
}

/** The update map HQ stores for the form under test. */
type Update = Record<string, { update_mode: string }>;
type Actions = {
	update_case: { update: Update };
	subcases: { case_properties: Update }[];
};

function actionsOf(doc: BlueprintDoc): Actions {
	const app = expandDoc(doc) as unknown as {
		modules: { forms: { name: { en: string }; actions: Actions }[] }[];
	};
	const form = app.modules[0]?.forms.find(
		(candidate) => candidate.name.en === "Under test",
	);
	if (form === undefined) throw new Error("The form under test exports.");
	return form.actions;
}

describe("a name or owner saved only when changed at the gate", () => {
	it("admits a follow-up's rename and owner and is exported as `edit` on `name` and `owner_id`", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [
				own({
					name: read("name"),
					nameOnlyIfChanged: true,
					owner: read("name"),
					ownerOnlyIfChanged: true,
				}),
			],
		});
		expect(allCodes(doc)).toEqual([]);
		const update = actionsOf(doc).update_case.update;
		expect(update.name?.update_mode).toBe("edit");
		expect(update.owner_id?.update_mode).toBe("edit");
	});

	it("admits a registration's owner and a child case's owner, each exported as `edit`", () => {
		const registration = placementFixture("registration", {
			operations: () => [
				own({
					name: read("name"),
					owner: read("status"),
					ownerOnlyIfChanged: true,
				}),
			],
		});
		const child = placementFixture("followup", {
			operations: (type) => [
				own(),
				childCreate("kid", type, {
					repeat: "kids",
					owner: read("kid_name"),
					ownerOnlyIfChanged: true,
				}),
			],
		});
		expect(allCodes(registration.doc)).toEqual([]);
		expect(allCodes(child.doc)).toEqual([]);
		expect(
			actionsOf(registration.doc).update_case.update.owner_id?.update_mode,
		).toBe("edit");
		expect(
			actionsOf(child.doc).subcases[0]?.case_properties.owner_id?.update_mode,
		).toBe("edit");
	});

	it("keeps `always` on a name and owner saved every time", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [own({ name: read("name"), owner: read("name") })],
		});
		const update = actionsOf(doc).update_case.update;
		expect(update.name?.update_mode).toBe("always");
		expect(update.owner_id?.update_mode).toBe("always");
	});

	it("refuses a flag whose name or owner the change does not save", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [own({ ownerOnlyIfChanged: true })],
		});
		const [finding] = onlyIfChangedFindings(doc);
		expect(finding?.details).toMatchObject({
			reason: "facet",
			property: "owner_id",
		});
		expect(finding && userFacingError(finding)).toBe(
			"This change saves its owner only when it changed, but it saves no owner. You can choose one, or save it every time.",
		);
	});

	it("refuses a registration's own name, whose mode HQ's build never reads", () => {
		const { doc } = placementFixture("registration", {
			operations: () => [own({ name: read("name"), nameOnlyIfChanged: true })],
		});
		const [finding] = onlyIfChangedFindings(doc);
		expect(finding?.details?.reason).toBe("registration-name");
	});

	it("refuses an owner that is the worker, which is never blank", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [
				own({ owner: actingUser(), ownerOnlyIfChanged: true }),
			],
		});
		const [finding] = onlyIfChangedFindings(doc);
		expect(finding?.details?.reason).toBe("never-blank");
	});

	it("refuses it through Save to Case, as for a write", () => {
		const { doc } = placementFixture("followup", {
			severalCases: true,
			operations: () => [own({ name: read("name"), nameOnlyIfChanged: true })],
		});
		const [finding] = onlyIfChangedFindings(doc);
		expect(finding?.details).toMatchObject({
			reason: "placement",
			ineligibility: "several-cases",
			property: "case_name",
		});
	});
});

describe("the case change tools", () => {
	it("take each flag and keep it on the change they make", () => {
		const own: OwnCaseOperation = {
			uuid: OP("own"),
			id: "patient",
			action: "own",
		};
		const ownInput = ownOperationInputSchema.parse({
			action: "own",
			name: read("name"),
			nameOnlyIfChanged: true,
			owner: read("name"),
			ownerOnlyIfChanged: true,
		});
		expect(resolveOwnCaseOperationInput(ownInput, own)).toMatchObject({
			nameOnlyIfChanged: true,
			ownerOnlyIfChanged: true,
		});
		const update = caseOperationInputSchema.parse({
			id: "visit",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			rename: read("name"),
			renameOnlyIfChanged: true,
			owner: read("name"),
			ownerOnlyIfChanged: true,
			writes: [{ property: "age", value: read("age"), onlyIfChanged: true }],
		});
		expect(resolveCaseOperationInput(update, OP("visit"))).toMatchObject({
			renameOnlyIfChanged: true,
			ownerOnlyIfChanged: true,
			writes: [{ property: "age", onlyIfChanged: true }],
		});
		const create = caseOperationInputSchema.parse({
			id: "kid",
			action: "create",
			caseType: "kid",
			target: { kind: "new" },
			name: read("name"),
			owner: read("name"),
			ownerOnlyIfChanged: true,
		});
		expect(resolveCaseOperationInput(create, OP("kid"))).toMatchObject({
			ownerOnlyIfChanged: true,
		});
	});

	it("refuse a rename flag on a new case and any flag on a close", () => {
		for (const input of [
			{
				id: "kid",
				action: "create",
				caseType: "kid",
				target: { kind: "new" },
				name: read("name"),
				renameOnlyIfChanged: true,
			},
			{
				id: "gone",
				action: "close",
				caseType: "kid",
				target: { kind: "session" },
				ownerOnlyIfChanged: true,
			},
		])
			expect(caseOperationInputSchema.safeParse(input).success).toBe(false);
	});
});

/**
 * An edit of an existing change through the update tool and the shared
 * reducer: a flag the edit sets with no name or owner beside it reaches the
 * gate, which refuses it as the add tool does, and a flag whose name or
 * owner the edit clears goes with it.
 */
describe("an edit of an existing change", () => {
	const fixture = () =>
		placementFixture("followup", {
			operations: () => [own({ name: read("name") })],
		});

	it("leaves a flag it sets with no owner to the gate, which refuses it", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(updateCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: OWN,
			operation: {
				action: "own",
				name: read("name"),
				ownerOnlyIfChanged: true,
			},
		});
		expect(
			z.object({ error: z.string() }).parse(result.result).error,
		).toContain("saves its owner only when it changed, but it saves no owner.");
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("drops the flag of an owner it clears", () => {
		const base = fixture();
		const flagged = produce(base.doc, (draft) => {
			const operation = draft.forms[base.formUuid]?.caseOperations?.[0];
			if (operation?.action !== "own")
				throw new Error("The form keeps its own case.");
			operation.owner = read("name");
			operation.ownerOnlyIfChanged = true;
		});
		expect(onlyIfChangedFindings(flagged)).toEqual([]);
		const current = flagged.forms[base.formUuid]?.caseOperations?.[0];
		if (current?.action !== "own")
			throw new Error("The form keeps its own case.");
		const { owner: _owner, ...cleared } = current;
		const plan = planCaseOperationUpdate(flagged, base.formUuid, cleared);
		if (!plan.ok) throw new Error(plan.reason);
		const next = applyToDoc(flagged, plan.mutations);
		const after = next.forms[base.formUuid]?.caseOperations?.[0];
		expect(after).not.toHaveProperty("owner");
		expect(after).not.toHaveProperty("ownerOnlyIfChanged");
		expect(onlyIfChangedFindings(next)).toEqual([]);
	});
});
