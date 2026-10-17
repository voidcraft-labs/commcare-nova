/**
 * Which Connect block ids a document holds: the one reading every surface
 * that asks "is this Connect id taken?" shares, the validator, the emitter's
 * name planner and the agent tools alike.
 *
 * A Connect block id is unique across the app (it keys the block on
 * Connect's side), and it is also the name of the block's wrapper in its
 * form's data root, beside the form's root questions.
 */

import type { BlueprintDoc } from "./blueprint";
import type { ConnectConfig } from "./forms";
import type { Uuid } from "./uuid";

/** The four Connect blocks a form can hold. */
export type ConnectBlockKind =
	| "learn_module"
	| "assessment"
	| "deliver_unit"
	| "task";

/** Every block a Connect config holds, with its kind, in wire block order. */
export function connectBlocks(
	config: ConnectConfig,
): readonly { readonly kind: ConnectBlockKind; readonly id: string }[] {
	const blocks: { kind: ConnectBlockKind; id: string }[] = [];
	if ("learn_module" in config && config.learn_module)
		blocks.push({ kind: "learn_module", id: config.learn_module.id });
	if ("assessment" in config && config.assessment)
		blocks.push({ kind: "assessment", id: config.assessment.id });
	if ("deliver_unit" in config && config.deliver_unit)
		blocks.push({ kind: "deliver_unit", id: config.deliver_unit.id });
	if ("task" in config && config.task)
		blocks.push({ kind: "task", id: config.task.id });
	return blocks;
}

/** The Connect block ids a form's data root holds: none while the app has
 * no Connect mode, since no block is written then. */
export function formConnectIds(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ReadonlySet<string> {
	const connect = doc.forms[formUuid]?.connect;
	if (connect === undefined || doc.connectType === null) return new Set();
	return new Set(connectBlocks(connect).map((block) => block.id));
}

/** Every Connect block id of the app, on every form, whatever its kind,
 * optionally leaving out one form's (the form an edit is replacing). */
export function appConnectIds(
	doc: BlueprintDoc,
	exceptFormUuid?: Uuid,
): Set<string> {
	const ids = new Set<string>();
	for (const [formUuid, form] of Object.entries(doc.forms)) {
		if (formUuid === exceptFormUuid || form?.connect === undefined) continue;
		for (const block of connectBlocks(form.connect)) ids.add(block.id);
	}
	return ids;
}

/** The ids of a form's root fields, whose elements sit beside its Connect
 * blocks' wrappers in the form's data root. */
export function formRootFieldIds(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Set<string> {
	const ids = new Set<string>();
	for (const uuid of doc.fieldOrder[formUuid] ?? []) {
		const id = doc.fields[uuid]?.id;
		if (id !== undefined) ids.add(id);
	}
	return ids;
}

/** The ids taken at a form's data root: its root fields' ids and its
 * Connect block ids, which share that one namespace. A root question and a
 * Connect block named alike would be two elements of one name. */
export function formRootTakenIds(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Set<string> {
	return new Set([
		...formConnectIds(doc, formUuid),
		...formRootFieldIds(doc, formUuid),
	]);
}
