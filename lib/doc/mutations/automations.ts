import type { Draft } from "immer";
import { spliceAfter } from "@/lib/doc/mutations/sequence";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	ownRecordValue,
	recordWithoutKey,
	recordWithValue,
} from "@/lib/domain";
import { assertNever } from "@/lib/utils/assertNever";

type AutomationMutation = Extract<
	Mutation,
	{
		kind:
			| "addAutomation"
			| "updateAutomation"
			| "removeAutomation"
			| "moveAutomation"
			| "editAutomationItem"
			| "setAutomationSchedule"
			| "updateAutomationSchedule";
	}
>;

interface Identified {
	readonly uuid: string;
}

type IdentifiedEdit =
	| { operation: "add"; value: Identified; after?: string | null }
	| { operation: "update"; value: Identified }
	| { operation: "remove"; uuid: string }
	| { operation: "move"; uuid: string; after: string | null };

function editIdentifiedArray<T extends Identified>(
	items: readonly T[],
	edit: IdentifiedEdit,
): T[] {
	switch (edit.operation) {
		case "add": {
			const withoutExisting = items.filter(
				(item) => item.uuid !== edit.value.uuid,
			);
			const order = spliceAfter(
				withoutExisting.map((item) => item.uuid),
				edit.value.uuid,
				edit.after,
			);
			const byUuid = new Map(
				[...withoutExisting, structuredClone(edit.value) as T].map((item) => [
					item.uuid,
					item,
				]),
			);
			return order.flatMap((uuid) => {
				const item = byUuid.get(uuid);
				return item === undefined ? [] : [item];
			});
		}
		case "update":
			return items.map((item) =>
				item.uuid === edit.value.uuid
					? (structuredClone(edit.value) as T)
					: item,
			);
		case "remove":
			return items.filter((item) => item.uuid !== edit.uuid);
		case "move": {
			const item = items.find((candidate) => candidate.uuid === edit.uuid);
			if (item === undefined) return [...items];
			const order = spliceAfter(
				items.map((candidate) => candidate.uuid),
				edit.uuid,
				edit.after,
			);
			const byUuid = new Map(
				items.map((candidate) => [candidate.uuid, candidate]),
			);
			return order.flatMap((uuid) => {
				const candidate = byUuid.get(uuid);
				return candidate === undefined ? [] : [candidate];
			});
		}
		default:
			return assertNever(edit, "editIdentifiedArray");
	}
}

function applyPatch(
	entity: Record<string, unknown> | undefined,
	patch: Record<string, unknown>,
): void {
	if (entity === undefined) return;
	for (const [key, value] of Object.entries(patch)) {
		if (value === null || value === undefined) delete entity[key];
		else entity[key] = structuredClone(value);
	}
}

function removeAutomation(draft: Draft<BlueprintDoc>, uuid: string): void {
	const remainingOrder = (draft.automationOrder ?? []).filter(
		(entry) => entry !== uuid,
	);
	if (remainingOrder.length === 0) delete draft.automationOrder;
	else draft.automationOrder = remainingOrder;
	if (ownRecordValue(draft.automations, uuid) === undefined) return;
	const remaining = recordWithoutKey(draft.automations, uuid);
	if (Object.keys(remaining).length === 0) delete draft.automations;
	else draft.automations = remaining;
}

export function applyAutomationMutation(
	draft: Draft<BlueprintDoc>,
	mut: AutomationMutation,
): void {
	switch (mut.kind) {
		case "addAutomation":
			draft.automations = recordWithValue(
				draft.automations,
				mut.automation.uuid,
				structuredClone(mut.automation),
			);
			draft.automationOrder = spliceAfter(
				draft.automationOrder,
				mut.automation.uuid,
				mut.after,
			);
			return;
		case "updateAutomation":
			applyPatch(
				ownRecordValue(draft.automations, mut.uuid) as
					| Record<string, unknown>
					| undefined,
				mut.patch,
			);
			return;
		case "removeAutomation":
			removeAutomation(draft, mut.uuid);
			return;
		case "moveAutomation":
			draft.automationOrder = spliceAfter(
				draft.automationOrder,
				mut.uuid,
				mut.after,
			);
			return;
		case "setAutomationSchedule": {
			const automation = ownRecordValue(draft.automations, mut.uuid);
			if (automation?.kind === "conditional-alert") {
				automation.schedule = structuredClone(mut.schedule);
			}
			return;
		}
		case "updateAutomationSchedule": {
			const automation = ownRecordValue(draft.automations, mut.uuid);
			if (
				automation?.kind === "conditional-alert" &&
				automation.schedule.kind === "timed"
			) {
				applyPatch(
					automation.schedule as unknown as Record<string, unknown>,
					mut.patch,
				);
			}
			return;
		}
		case "editAutomationItem": {
			const automation = ownRecordValue(draft.automations, mut.automationUuid);
			if (automation === undefined || automation.kind !== mut.targetKind)
				return;
			const edit = mut.edit;
			switch (edit.collection) {
				case "criterion":
					if (
						automation.kind === "case-update" &&
						mut.targetKind === "case-update"
					) {
						automation.criteria = editIdentifiedArray(
							automation.criteria,
							edit,
						);
					} else if (
						automation.kind === "conditional-alert" &&
						mut.targetKind === "conditional-alert"
					) {
						automation.criteria = editIdentifiedArray(
							automation.criteria,
							edit,
						);
					}
					return;
				case "setup-only-criterion":
					automation.setupOnlyCriteria = editIdentifiedArray(
						automation.setupOnlyCriteria,
						edit,
					);
					return;
				case "update":
					if (automation.kind === "case-update") {
						automation.updates = editIdentifiedArray(automation.updates, edit);
					}
					return;
				case "recipient":
					if (automation.kind === "conditional-alert") {
						automation.recipients = editIdentifiedArray(
							automation.recipients,
							edit,
						);
					}
					return;
				case "user-data-filter":
					if (automation.kind === "conditional-alert") {
						automation.userDataFilters = editIdentifiedArray(
							automation.userDataFilters,
							edit,
						);
					}
					return;
				case "immediate-event":
					if (
						automation.kind === "conditional-alert" &&
						automation.schedule.kind === "immediate"
					) {
						automation.schedule.events = editIdentifiedArray(
							automation.schedule.events,
							edit,
						);
					}
					return;
				case "timed-event":
					if (
						automation.kind === "conditional-alert" &&
						automation.schedule.kind === "timed"
					) {
						automation.schedule.events = editIdentifiedArray(
							automation.schedule.events,
							edit,
						);
					}
					return;
				default:
					assertNever(edit, "applyAutomationMutation edit");
					return;
			}
		}
		default:
			assertNever(mut, "applyAutomationMutation");
	}
}
