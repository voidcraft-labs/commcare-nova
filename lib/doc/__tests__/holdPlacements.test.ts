/**
 * `holdPlacements`, the one mutation that writes a held placement: through
 * the production admission and reducer, it sets, replaces and clears each
 * target's slot, and refuses a target that is not there. The plausible
 * failures are a clear that leaves the key behind (`null` must delete it, so
 * the document holds absence and never a stored `null`), a hold that lands on
 * the wrong operation or on a repeat that is not a query repeat, and a
 * mutation that names one target twice so one entry silently loses (a
 * later mutation of the batch may hold it again, and its hold is kept).
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import {
	type Mutation,
	mutationSchema,
	type PlacementHoldEntry,
} from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	holdFixture,
	OWN,
	operationHold,
	ownCloseAt,
	ownCloseHold,
	queryRepeatHold,
	saveToCase,
	U,
	UPDATE,
	VISITS,
} from "./placementHoldFixture";

function apply(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	return prepareMutationCandidate(doc, admitMutationBatch(mutations));
}

function hold(...holds: PlacementHoldEntry[]): Mutation {
	return { kind: "holdPlacements", holds };
}

function moduleKindHold(
	moduleUuid: Uuid,
	placement: "advanced" | null,
): PlacementHoldEntry {
	return { target: "module-kind", moduleUuid, placement };
}

describe("holdPlacements", () => {
	it("sets, replaces and clears each target's held slot", () => {
		const { doc, formUuid } = holdFixture();
		const set = apply(doc, [
			hold(
				operationHold(formUuid, UPDATE, saveToCase("nova_operations", "upd")),
				operationHold(formUuid, OWN, { kind: "basic", slot: "own" }),
				ownCloseHold(formUuid, ownCloseAt("nova_close")),
				queryRepeatHold(VISITS, "model-iteration"),
			),
		]);
		expect(set.targetAdmissionIssue).toBeUndefined();
		const setForm = set.nextDoc.forms[formUuid];
		const setOperation = (uuid: string) =>
			setForm.caseOperations?.find((op) => op.uuid === uuid);
		expect(setOperation(UPDATE)?.placement).toEqual(
			saveToCase("nova_operations", "upd"),
		);
		expect(setOperation(OWN)?.placement).toEqual({
			kind: "basic",
			slot: "own",
		});
		expect(setForm.ownClosePlacement).toEqual(ownCloseAt("nova_close"));
		expect(set.nextDoc.fields[VISITS]).toMatchObject({
			placement: "model-iteration",
		});

		const replaced = apply(set.nextDoc, [
			hold(
				operationHold(formUuid, UPDATE, saveToCase("published", "upd")),
				ownCloseHold(formUuid, ownCloseAt("published_close")),
				queryRepeatHold(VISITS, "count"),
			),
		]);
		const replacedForm = replaced.nextDoc.forms[formUuid];
		expect(
			replacedForm.caseOperations?.find((op) => op.uuid === UPDATE)?.placement,
		).toEqual(saveToCase("published", "upd"));
		// The own arm's hold was not named, so it stays.
		expect(
			replacedForm.caseOperations?.find((op) => op.uuid === OWN)?.placement,
		).toEqual({ kind: "basic", slot: "own" });
		expect(replacedForm.ownClosePlacement).toEqual(
			ownCloseAt("published_close"),
		);
		expect(replaced.nextDoc.fields[VISITS]).toMatchObject({
			placement: "count",
		});

		const cleared = apply(replaced.nextDoc, [
			hold(
				operationHold(formUuid, UPDATE, null),
				operationHold(formUuid, OWN, null),
				ownCloseHold(formUuid, null),
				queryRepeatHold(VISITS, null),
			),
		]);
		const clearedForm = cleared.nextDoc.forms[formUuid];
		for (const operation of clearedForm.caseOperations ?? [])
			expect(Object.hasOwn(operation, "placement")).toBe(false);
		expect(Object.hasOwn(clearedForm, "ownClosePlacement")).toBe(false);
		expect(Object.hasOwn(cleared.nextDoc.fields[VISITS], "placement")).toBe(
			false,
		);
		// Clearing returns the document to its unheld bytes.
		expect(cleared.nextDoc.forms[formUuid]).toEqual(doc.forms[formUuid]);
		expect(cleared.nextDoc.fields[VISITS]).toEqual(doc.fields[VISITS]);
	});

	it("refuses a hold whose form, operation or field is missing", () => {
		const { doc, formUuid } = holdFixture();
		const missing = testUuid("missing");
		for (const entry of [
			operationHold(missing, UPDATE, saveToCase("upd")),
			operationHold(formUuid, missing, saveToCase("upd")),
			ownCloseHold(missing, ownCloseAt("close")),
			queryRepeatHold(missing, "count"),
		]) {
			const prepared = apply(doc, [hold(entry)]);
			expect(prepared.targetAdmissionIssue).toBe(true);
			expect(prepared.nextDoc).toBe(doc);
		}
	});

	it("refuses a hold on an operation removed earlier in the batch", () => {
		const { doc, formUuid } = holdFixture();
		const prepared = apply(doc, [
			{
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationChange: { operation: "remove", uuid: UPDATE },
			},
			hold(operationHold(formUuid, UPDATE, saveToCase("upd"))),
		]);
		expect(prepared.targetAdmissionIssue).toBe(true);
	});

	it("refuses a query repeat target that is not a query repeat", () => {
		const { doc } = holdFixture();
		// `kids` is a repeat the person adds rows to; `name` is a text question.
		for (const fieldUuid of [U("kids"), U("name")]) {
			const prepared = apply(doc, [hold(queryRepeatHold(fieldUuid, "count"))]);
			expect(prepared.targetAdmissionIssue).toBe(true);
		}
		// A repeat that stops following its query earlier in the batch is no
		// longer a target.
		const modeChanged = apply(doc, [
			{
				kind: "updateField",
				uuid: VISITS,
				targetKind: "repeat",
				patch: { repeat_mode: "user_controlled" },
			} as Mutation,
			hold(queryRepeatHold(VISITS, "count")),
		]);
		expect(modeChanged.targetAdmissionIssue).toBe(true);
	});

	it("refuses one target named twice in one mutation", () => {
		const { formUuid } = holdFixture();
		const parsed = mutationSchema.safeParse(
			hold(
				operationHold(formUuid, UPDATE, saveToCase("a")),
				operationHold(formUuid, UPDATE, saveToCase("b")),
			),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues.map((issue) => issue.path)).toContainEqual([
			"holds",
			1,
		]);
		expect(() =>
			admitMutationBatch([
				hold(
					queryRepeatHold(VISITS, "count"),
					queryRepeatHold(VISITS, "model-iteration"),
				),
			]),
		).toThrow();
	});

	it("sets and clears a menu's held kind", () => {
		const { doc } = holdFixture();
		const moduleUuid = doc.moduleOrder[0];
		const set = apply(doc, [hold(moduleKindHold(moduleUuid, "advanced"))]);
		expect(set.targetAdmissionIssue).toBeUndefined();
		expect(set.nextDoc.modules[moduleUuid]?.heldKind).toBe("advanced");
		// The menu's kind is read first, ahead of its forms' holds.
		expect([...readPlacementHolds(set.nextDoc).keys()]).toEqual([
			`module-kind:${moduleUuid}`,
		]);

		const cleared = apply(set.nextDoc, [
			hold(moduleKindHold(moduleUuid, null)),
		]);
		expect(Object.hasOwn(cleared.nextDoc.modules[moduleUuid], "heldKind")).toBe(
			false,
		);
		expect(cleared.nextDoc.modules[moduleUuid]).toEqual(
			doc.modules[moduleUuid],
		);
	});

	it("refuses a menu's held kind on a menu that is not there, or a kind that is not advanced", () => {
		const { doc } = holdFixture();
		const missing = apply(doc, [
			hold(moduleKindHold(testUuid("missing"), "advanced")),
		]);
		expect(missing.targetAdmissionIssue).toBe(true);
		expect(missing.nextDoc).toBe(doc);
		// A menu removed earlier in the batch is no longer a target.
		const moduleUuid = doc.moduleOrder[doc.moduleOrder.length - 1];
		const removed = apply(doc, [
			{ kind: "removeModule", uuid: moduleUuid },
			hold(moduleKindHold(moduleUuid, "advanced")),
		]);
		expect(removed.targetAdmissionIssue).toBe(true);
		expect(
			mutationSchema.safeParse({
				kind: "holdPlacements",
				holds: [
					{
						target: "module-kind",
						moduleUuid: doc.moduleOrder[0],
						placement: "basic",
					},
				],
			}).success,
		).toBe(false);
	});

	it("keeps the later hold where two mutations of one batch hold one target", () => {
		// Private work concatenates its steps into one batch, and a later step
		// can take back the move an earlier one made.
		const { doc, formUuid } = holdFixture();
		const prepared = apply(doc, [
			hold(ownCloseHold(formUuid, ownCloseAt("a"))),
			hold(ownCloseHold(formUuid, ownCloseAt("b"))),
		]);
		expect(prepared.targetAdmissionIssue).toBeUndefined();
		expect(prepared.nextDoc.forms[formUuid]?.ownClosePlacement).toEqual(
			ownCloseAt("b"),
		);
	});
});
