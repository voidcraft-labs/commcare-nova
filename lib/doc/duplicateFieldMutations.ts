import { v4 as uuidv4 } from "uuid";
import type { FormNodeRef } from "@/lib/domain/expression/types";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import { suffixUntilFree } from "@/lib/domain/idSlug";
/**
 * Duplicating a field, planned as ordinary adds.
 *
 * A duplicate is a clone of a subtree, and every clone needs a fresh identity.
 * Minting those identities HERE, at the gesture, is what keeps the reducers
 * deterministic: a mutation that minted identity on the way past would produce
 * a different document on every apply, so it could never be persisted, replayed,
 * or folded onto a peer's state, and every boundary handling a batch would need
 * a special case saying so.
 *
 * The reducer gets the same `addField` mutations any other creation uses, so
 * the batch is an ordinary batch: it replays to the same document, it persists,
 * it undoes by removing what it added, and no boundary needs to know it was a
 * duplicate.
 */

import {
	findContainingForm,
	findFieldParent,
	walkFormFieldUuids,
} from "@/lib/doc/mutations/helpers";
import { HELD_FIELD_KEYS, type HeldFieldKey } from "@/lib/domain/fields";
import { submissionLayout } from "@/lib/domain/submissionLayout";
import { asUuid, type BlueprintDoc, type Mutation, type Uuid } from "./types";

/** One field's clone, in the order the adds must land. */
interface ClonedField {
	readonly parentUuid: Uuid;
	readonly field: BlueprintDoc["fields"][Uuid];
}

/**
 * The batch that duplicates `uuid` — one `addField` per cloned field, parents
 * before children, the root clone landing directly after its source.
 *
 * Returns the batch together with the root clone's minted uuid, which is what
 * the caller needs to select the new field. Empty when the field or its parent
 * is missing: the gesture addressed something that is no longer there.
 */
export function duplicateFieldMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
): { readonly mutations: Mutation[]; readonly cloneUuid: Uuid } | undefined {
	const source = doc.fields[uuid];
	if (source === undefined) return undefined;
	// Resolved from `fieldOrder` rather than the derived `fieldParent` index:
	// a planner may be handed a doc from any source, and the membership arrays
	// are the thing that is always present.
	const parentUuid = findFieldParent(doc, uuid)?.parentUuid;
	if (parentUuid === undefined) return undefined;

	const cloned: ClonedField[] = [];
	const clonedIds = new Map<Uuid, Uuid>();
	const cloneInto = (sourceUuid: Uuid, intoParent: Uuid): Uuid | undefined => {
		const field = doc.fields[sourceUuid];
		if (field === undefined) return undefined;
		const cloneUuid = asUuid(uuidv4());
		const copy = structuredClone(field);
		copy.uuid = cloneUuid;
		// A held identity belongs to the source the publish carried; the
		// clone is new and starts unheld (`HELD_FIELD_KEYS`).
		for (const key of HELD_FIELD_KEYS)
			delete (copy as Partial<Record<HeldFieldKey, unknown>>)[key];
		clonedIds.set(sourceUuid, cloneUuid);
		cloned.push({ parentUuid: intoParent, field: copy });
		for (const childUuid of doc.fieldOrder[sourceUuid] ?? []) {
			cloneInto(childUuid, cloneUuid);
		}
		return cloneUuid;
	};

	const cloneUuid = cloneInto(uuid, parentUuid);
	if (cloneUuid === undefined) return undefined;

	for (const { field } of cloned) {
		if (
			(field.kind === "single_select" || field.kind === "multi_select") &&
			field.optionsSource.kind !== "inline" &&
			field.optionsSource.filter
		) {
			walkExpressionTerms(field.optionsSource.filter, (term) => {
				if (term.kind === "field")
					term.uuid = clonedIds.get(term.uuid) ?? term.uuid;
			});
		}
	}

	// A duplicate stands beside its source on screen, and each copied answer
	// stands where its source's does: a placement naming a group inside the
	// copy names the copy of that group. A copied answer that lands among
	// values outside the copy (the root's group's, or a named group's) takes
	// an ID free among them.
	const form = findContainingForm(doc, uuid);
	if (form === undefined) return undefined;
	const layout = submissionLayout(form, doc.fields, doc.fieldOrder);
	const taken = new Map<Uuid, Set<string>>();
	const takenIn = (parent: Uuid): Set<string> => {
		let ids = taken.get(parent);
		if (ids === undefined) {
			ids = new Set(
				(layout.children.get(parent) ?? []).flatMap((sibling) => {
					const id = doc.fields[sibling]?.id;
					return id === undefined ? [] : [id];
				}),
			);
			taken.set(parent, ids);
		}
		return ids;
	};
	for (const [index, { field }] of cloned.entries()) {
		const named = field.submissionPlacement?.parent;
		const rebased = named === undefined ? undefined : clonedIds.get(named);
		if (rebased !== undefined) {
			field.submissionPlacement = { parent: rebased };
			continue;
		}
		const lands = named ?? (index === 0 ? parentUuid : undefined);
		if (lands === undefined) continue;
		const ids = takenIn(lands);
		const desired = field.id;
		for (let suffix = 2; ids.has(field.id); suffix++)
			field.id = `${desired}_${suffix}`;
		ids.add(field.id);
	}

	// Each app question also names a form-wide Android action definition.
	// Rebind references to copied questions and give copied definitions free
	// names even when their immediate parents have changed.
	const actions = cloned.filter(
		({ field }) =>
			field.kind === "text" && field.androidApp?.kind === "open-app",
	);
	const actionIds = new Set<string>();
	if (actions.length) {
		for (const member of walkFormFieldUuids(doc, form)) {
			const field = doc.fields[member];
			if (field?.kind === "text" && field.androidApp?.kind === "open-app")
				actionIds.add(field.id);
		}
	}
	const clonedId = (id: Uuid) => clonedIds.get(id) ?? id;
	const retarget = (node: FormNodeRef) => {
		if (node.kind === "field") node.uuid = clonedId(node.uuid);
		else if ("repeat" in node) node.repeat = clonedId(node.repeat);
	};
	for (const { field, parentUuid: into } of cloned) {
		const app = "androidApp" in field ? field.androidApp : undefined;
		if (!app) continue;
		if (app.kind === "use-question") {
			app.question = clonedId(app.question);
			continue;
		}
		const taken = new Set(actionIds);
		for (const sibling of doc.fieldOrder[into] ?? []) {
			const existing = doc.fields[sibling];
			if (existing) taken.add(existing.id);
		}
		for (const sibling of cloned) {
			if (sibling.parentUuid === into && sibling.field !== field)
				taken.add(sibling.field.id);
		}
		field.id = suffixUntilFree(field.id, taken);
		actionIds.add(field.id);
		for (const result of app.receive)
			result.question = clonedId(result.question);
		for (const parameter of app.send) {
			walkExpressionTerms(parameter.value, (term) => {
				if (term.kind === "field") term.uuid = clonedId(term.uuid);
				if (term.kind === "capture-link") term.field = clonedId(term.field);
				if (term.kind === "repeat-row") term.repeat = clonedId(term.repeat);
				if (term.kind === "form-node") retarget(term.node);
				if ("filters" in term)
					for (const filter of term.filters ?? []) retarget(filter.step);
			});
		}
	}

	const adds: Mutation[] = cloned.map((entry, index) => ({
		kind: "addField",
		parentUuid: entry.parentUuid,
		field: entry.field,
		...(index === 0 && { after: uuid }),
	}));
	return { cloneUuid, mutations: adds };
}
