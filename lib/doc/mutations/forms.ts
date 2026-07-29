import type { Draft } from "immer";
import { spliceAfter } from "@/lib/doc/mutations/sequence";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { cascadeDeleteForm } from "./helpers";

/**
 * Form mutations — fine-grained only.
 *
 * `renameForm` maps to the form's `name` field (the only user-editable
 * free-form identifier on a form). The `id`-style slug doesn't exist on
 * forms; CommCare derives the form's XForm id from its position.
 *
 * Wholesale-swap semantics (e.g. replacing a form's entire field subtree)
 * are expressed by composing `updateForm + removeField × N + addField × M`
 * at the agent-stream mutation mapper — this reducer has no dedicated
 * wholesale kind and stays focused on a single fine-grained operation
 * per case.
 */
/**
 * Reorder one case operation within the form's sequence.
 *
 * `caseOperations` is the sequence, so this is `spliceAfter` over objects
 * rather than uuids. Total for the same reason every reducer is: an `after`
 * naming an operation a peer removed appends instead of throwing, because
 * historical replay must not be able to fail.
 */
function spliceOperation<T extends { uuid: string }>(
	operations: readonly T[],
	uuid: string,
	after: string | null,
): T[] {
	const moving = operations.find((op) => op.uuid === uuid);
	if (moving === undefined) return [...operations];
	const rest = operations.filter((op) => op.uuid !== uuid);
	if (after === null) return [moving, ...rest];
	const at = rest.findIndex((op) => op.uuid === after);
	if (at < 0) return [...rest, moving];
	return [...rest.slice(0, at + 1), moving, ...rest.slice(at + 1)];
}

export function applyFormMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{
			kind:
				| "addForm"
				| "removeForm"
				| "moveForm"
				| "renameForm"
				| "updateForm"
				| "setFormMedia";
		}
	>,
): void {
	switch (mut.kind) {
		case "addForm": {
			if (draft.modules[mut.moduleUuid] === undefined) return;
			const { uuid } = mut.form;
			// Cloned: `updateForm` edits the stored form in place, so the payload
			// must not be the object it edits — same reason `addModule` clones.
			draft.forms[uuid] = structuredClone(mut.form);
			draft.fieldOrder[uuid] = [];
			// The membership array IS the sequence, so the add splices.
			draft.formOrder[mut.moduleUuid] = spliceAfter(
				draft.formOrder[mut.moduleUuid] ?? [],
				uuid,
				mut.after,
			);
			return;
		}
		case "removeForm": {
			if (draft.forms[mut.uuid] === undefined) return;
			// Find which module owns this form, remove from its order.
			for (const [modUuid, formList] of Object.entries(draft.formOrder)) {
				const idx = formList.indexOf(mut.uuid);
				if (idx !== -1) {
					formList.splice(idx, 1);
					draft.formOrder[modUuid as keyof typeof draft.formOrder] = formList;
					break;
				}
			}
			cascadeDeleteForm(draft as unknown as BlueprintDoc, mut.uuid);
			return;
		}
		case "moveForm": {
			const form = draft.forms[mut.uuid];
			if (form === undefined) return;
			if (draft.modules[mut.toModuleUuid] === undefined) return;
			// A form a peer removed is not moved back into existence.
			if (draft.forms[mut.uuid] === undefined) return;
			// Leave whatever module currently holds it, then land in the target's
			// sequence at the named placement. Same-module and cross-module are one
			// path: the source removal is a no-op when the source IS the target,
			// because `spliceAfter` removes the uuid before re-inserting it.
			for (const [modUuid, formList] of Object.entries(draft.formOrder)) {
				if (modUuid === mut.toModuleUuid) continue;
				const idx = formList.indexOf(mut.uuid);
				if (idx !== -1) formList.splice(idx, 1);
			}
			draft.formOrder[mut.toModuleUuid] = spliceAfter(
				draft.formOrder[mut.toModuleUuid] ?? [],
				mut.uuid,
				mut.after,
			);
			return;
		}
		case "renameForm": {
			const form = draft.forms[mut.uuid];
			if (form) form.name = mut.newId;
			return;
		}
		case "updateForm": {
			const form = draft.forms[mut.uuid];
			if (!form) return;
			// Apply the patch key-by-key: a `null` (the wire representation of a
			// clear — JSON drops `undefined`, so a cleared optional slot crosses
			// the persistence wire as `null`) or `undefined` (an in-memory clear)
			// DELETES the slot; any other value sets it. The patch schema admits
			// `null` only on the clearable (optional) slots, so a required slot
			// can never reach here as `null`.
			const target = form as unknown as Record<string, unknown>;
			for (const [key, value] of Object.entries(mut.patch)) {
				if (value === null || value === undefined) delete target[key];
				else target[key] = value;
			}
			const operations = form.caseOperations ?? [];
			const operation = (
				uuid: NonNullable<typeof mut.caseOperationPatch>["uuid"],
			) => operations.find((candidate) => candidate.uuid === uuid);
			const applyPatch = (
				target: Record<string, unknown>,
				patch: Record<string, unknown>,
			) => {
				for (const [key, value] of Object.entries(patch)) {
					if (value === null || value === undefined) delete target[key];
					else target[key] = value;
				}
			};
			const reorderNamed = <T>(
				items: readonly T[],
				order: readonly string[],
				keyOf: (item: T) => string,
			): T[] => {
				const rank = new Map(order.map((key, index) => [key, index]));
				const result = [...items];
				const slots: number[] = [];
				const mentioned: T[] = [];
				for (const [index, item] of result.entries()) {
					if (!rank.has(keyOf(item))) continue;
					slots.push(index);
					mentioned.push(item);
				}
				mentioned.sort(
					(left, right) =>
						(rank.get(keyOf(left)) ?? 0) - (rank.get(keyOf(right)) ?? 0),
				);
				for (const [position, index] of slots.entries()) {
					const item = mentioned[position];
					if (item !== undefined) result[index] = item;
				}
				return result;
			};

			/* Existing-operation edits have one final identity-keyed payload.
			 * Scalar, member, and member-order edits each touch only their named
			 * merge unit; no whole-operation fallback accompanies them. */
			const semantic = mut.caseOperationPatch;
			if (semantic !== undefined) {
				switch (semantic.operation) {
					case "update": {
						const current = operation(semantic.uuid);
						if (current === undefined) return;
						applyPatch(
							current as unknown as Record<string, unknown>,
							semantic.patch as Record<string, unknown>,
						);
						form.caseOperations = operations;
						return;
					}
					case "add-write": {
						const current = operation(semantic.uuid);
						if (current === undefined) return;
						const writes = current.writes ?? [];
						if (
							writes.some((write) => write.property === semantic.value.property)
						) {
							return;
						}
						const index = Math.max(
							0,
							Math.min(semantic.index ?? writes.length, writes.length),
						);
						// CLONE, never alias. A mutation is a durable event that is
						// applied more than once — the saga derives a prospective doc
						// and the guarded commit re-applies the same batch onto the
						// fresh one. Splicing the payload object itself in makes it
						// part of a produced state, which Immer freezes; the next
						// apply's `update-write` then assigns to a frozen object and
						// the whole save 500s.
						writes.splice(index, 0, structuredClone(semantic.value));
						current.writes = writes;
						form.caseOperations = operations;
						return;
					}
					case "update-write": {
						const current = operation(semantic.uuid);
						const write = current?.writes?.find(
							(candidate) => candidate.property === semantic.property,
						);
						if (write === undefined) return;
						applyPatch(
							write as unknown as Record<string, unknown>,
							semantic.patch as Record<string, unknown>,
						);
						form.caseOperations = operations;
						return;
					}
					case "remove-write": {
						const current = operation(semantic.uuid);
						if (current === undefined) return;
						const writes = (current.writes ?? []).filter(
							(write) => write.property !== semantic.property,
						);
						if (writes.length === 0) delete current.writes;
						else current.writes = writes;
						form.caseOperations = operations;
						return;
					}
					case "reorder-writes": {
						const current = operation(semantic.uuid);
						if (current === undefined) return;
						const writes = current.writes ?? [];
						current.writes = reorderNamed(
							writes,
							semantic.properties,
							(write) => write.property,
						);
						form.caseOperations = operations;
						return;
					}
					case "add-link": {
						const current = operation(semantic.uuid);
						if (current === undefined) return;
						const links = current.links ?? [];
						if (
							links.some(
								(link) => link.identifier === semantic.value.identifier,
							)
						) {
							return;
						}
						const index = Math.max(
							0,
							Math.min(semantic.index ?? links.length, links.length),
						);
						// Cloned for the same reason `add-write` clones: the payload
						// must not become part of a frozen produced state that a later
						// apply of this same batch then tries to edit in place.
						links.splice(index, 0, structuredClone(semantic.value));
						current.links = links;
						form.caseOperations = operations;
						return;
					}
					case "update-link": {
						const current = operation(semantic.uuid);
						const link = current?.links?.find(
							(candidate) => candidate.identifier === semantic.identifier,
						);
						if (link === undefined) return;
						/* Every link-patch slot is required, including `target`.
						 * `target: null` is the authored unlink intent, not the
						 * persistence representation of clearing an optional slot.
						 * Assign these keys directly so a granular unlink remains a
						 * complete CaseOperationLink and composes with concurrent edits
						 * to its type or relationship. */
						for (const [key, value] of Object.entries(semantic.patch)) {
							if (value !== undefined) {
								(link as unknown as Record<string, unknown>)[key] = value;
							}
						}
						form.caseOperations = operations;
						return;
					}
					case "remove-link": {
						const current = operation(semantic.uuid);
						if (current === undefined) return;
						const links = (current.links ?? []).filter(
							(link) => link.identifier !== semantic.identifier,
						);
						if (links.length === 0) delete current.links;
						else current.links = links;
						form.caseOperations = operations;
						return;
					}
					case "reorder-links": {
						const current = operation(semantic.uuid);
						if (current === undefined) return;
						const links = current.links ?? [];
						current.links = reorderNamed(
							links,
							semantic.identifiers,
							(link) => link.identifier,
						);
						form.caseOperations = operations;
						return;
					}
					case "move": {
						const current = operation(semantic.uuid);
						if (current === undefined) return;
						// `caseOperations` IS the sequence, so the move reorders it.
						form.caseOperations = spliceOperation(
							operations,
							semantic.uuid,
							semantic.after,
						);
						return;
					}
				}
			}

			const change = mut.caseOperationChange;
			if (change === undefined) return;
			switch (change.operation) {
				case "add":
					if (
						!operations.some(
							(operation) => operation.uuid === change.value.uuid,
						)
					) {
						// CLONE, never alias. This batch is applied more than once —
						// the saga derives a prospective document and the guarded
						// commit re-applies onto the freshly loaded one — and Immer
						// freezes what `produce` returns. Pushing the payload itself
						// makes the durable event part of a frozen document, so the
						// SECOND apply's granular edits assign to a frozen object and
						// the save 500s. Worse, the first apply's later mutations write
						// THROUGH the alias into the event: the stored `add` ends up
						// carrying links and writes it never authored.
						operations.push(structuredClone(change.value));
						form.caseOperations = operations;
					}
					return;
				case "remove": {
					const index = operations.findIndex(
						(operation) => operation.uuid === change.uuid,
					);
					if (index !== -1) operations.splice(index, 1);
					if (operations.length === 0) delete form.caseOperations;
					else form.caseOperations = operations;
					return;
				}
			}
			return;
		}
		case "setFormMedia": {
			// Set or clear the form's menu media (tile `icon` + `audioLabel`).
			// Mirrors `setModuleMedia` one level down: explicit `MediaAssetId | null`
			// slots so a clear survives JSON over the SSE wire (a generic
			// `updateForm` patch would encode it as `{ key: undefined }`, which
			// `JSON.stringify` drops). Each `null` maps to `undefined` so the
			// cleared slot drops off the form.
			const form = draft.forms[mut.uuid];
			if (!form) return;
			form.icon = mut.icon ?? undefined;
			form.audioLabel = mut.audioLabel ?? undefined;
			return;
		}
	}
}
