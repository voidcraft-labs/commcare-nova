/**
 * The `holdPlacements` reducer: writes each entry's held slot, in order, and
 * computes nothing. A case operation's hold is its `placement`, an own
 * close's is `Form.ownClosePlacement`, a query repeat's is the repeat's
 * `placement`, a menu's kind is `Module.heldKind`; `null` deletes the key. Target admission
 * (`mutationTargetAdmission.ts`) refuses an entry whose target is missing,
 * so a target the reducer cannot find is a stale replay and is left alone.
 */

import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { ownRecordValue } from "@/lib/domain";

type HoldPlacementsMutation = Extract<Mutation, { kind: "holdPlacements" }>;

export function applyHoldPlacements(
	draft: Draft<BlueprintDoc>,
	mutation: HoldPlacementsMutation,
): void {
	for (const hold of mutation.holds) {
		switch (hold.target) {
			case "case-operation": {
				const form = ownRecordValue(draft.forms, hold.formUuid);
				const operation = form?.caseOperations?.find(
					(op) => op.uuid === hold.operationUuid,
				);
				if (operation === undefined) break;
				if (hold.placement === null) delete operation.placement;
				else operation.placement = hold.placement;
				break;
			}
			case "own-close": {
				const form = ownRecordValue(draft.forms, hold.formUuid);
				if (form === undefined) break;
				if (hold.placement === null) delete form.ownClosePlacement;
				else form.ownClosePlacement = hold.placement;
				break;
			}
			case "query-repeat": {
				const field = ownRecordValue(draft.fields, hold.fieldUuid);
				if (
					field === undefined ||
					field.kind !== "repeat" ||
					field.repeat_mode !== "query_bound"
				)
					break;
				if (hold.placement === null) delete field.placement;
				else field.placement = hold.placement;
				break;
			}
			case "module-kind": {
				const module = ownRecordValue(draft.modules, hold.moduleUuid);
				if (module === undefined) break;
				if (hold.placement === null) delete module.heldKind;
				else module.heldKind = hold.placement;
				break;
			}
		}
	}
}
