/**
 * Derive the validation scope a mutation batch needs — which entities a
 * scoped `runValidation` must re-walk so the gate's introduced-error diff
 * (`gate.ts::evaluateCommit`) sees every finding the batch can change.
 *
 * The contract is SOUNDNESS, not minimality: the scope must cover every
 * module/form whose findings can differ between `prevDoc` and the batch's
 * result. Where a kind's effects can cross its containing entity in ways a
 * widened scope can't bound (deleting a form another form links to,
 * re-scoping what a form's references resolve to), the kind maps to
 * `"full"`. An over-broad scope costs a slower run; an under-broad scope
 * would let the gate go STALE — accept a batch that introduced an error it
 * never re-validated. Slowness is the only acceptable failure direction.
 *
 * The per-kind switch is exhaustive over the `Mutation` union — adding a
 * mutation kind without deciding its scope here is a COMPILE error. The
 * runtime `default` arm (unreachable per the types) returns `"full"` for
 * the same reason: an unrecognized kind from a stale payload degrades to a
 * full run, never to staleness.
 *
 * Case-property writes force a FULL run: any mutation that changes the
 * app's case-property writer set or the case-type catalog — landing,
 * removing, renaming, re-kinding, or re-targeting a field with a
 * non-empty `case_property_on` (the reducers sync the catalog on each:
 * `fields.ts::ensureCatalogProperty`, `cascadeCasePropertyRename`) — maps
 * to `"full"`. No entity-keyed widening can bound who READS that state:
 *
 *   - the rename cascade renames peer fields app-wide by their
 *     `(id, case_property_on)` pair — a child-case writer routinely
 *     lives in a module of a DIFFERENT caseType, and the cascade
 *     rewrites that module's forms (and can mint a sibling collision
 *     there);
 *   - module rules resolve properties on OTHER case types through
 *     relation walks (`searchInputModeMatchesPropertyType` et al. via
 *     `checkRelationPath`; predicate-AST `PropertyRef` leaves
 *     self-encode foreign destination types), so a writer or catalog
 *     change for type T flips findings in modules of ANY type whose
 *     configs walk to T — including error-code flips like
 *     UNKNOWN_PROPERTY → MODE_PROPERTY_TYPE_MISMATCH when a gained
 *     catalog entry types a previously unknown property;
 *   - the deep validator admits `#<type>/<prop>` refs through the
 *     ancestor chain, so forms in descendant-type modules read a
 *     renamed/removed property's catalog state too.
 *
 * Widening to "every module of the written caseType" does not cover any
 * of these (each reader's own caseType differs from the written type),
 * so don't reintroduce it — slowness over staleness decides.
 */

import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import type { ValidationScope } from "./index";

/** Read `case_property_on` off any Field variant (kinds without the slot → undefined). */
function casePropertyOn(field: Field): string | undefined {
	const value = (field as unknown as Record<string, unknown>).case_property_on;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Mutable accumulator for the derivation. `full` short-circuits everything
 * else; the overlay maps track entities ADDED earlier in the same batch so
 * later mutations targeting them still resolve (`prevDoc` alone can't —
 * the batch hasn't been applied).
 */
interface ScopeAccumulator {
	full: boolean;
	readonly moduleUuids: Set<Uuid>;
	readonly formUuids: Set<Uuid>;
	/** formUuid → moduleUuid for forms added earlier in this batch. */
	readonly addedForms: Map<Uuid, Uuid>;
	/** fieldUuid → parentUuid (form or container) for fields added earlier in this batch. */
	readonly addedFieldParents: Map<Uuid, Uuid>;
	/** fieldUuid → field payload for fields added earlier in this batch. */
	readonly addedFields: Map<Uuid, Field>;
}

/**
 * Resolve the form that contains `uuid` (itself a form uuid, or a field /
 * container uuid anywhere under one), consulting prevDoc plus the batch
 * overlay. `undefined` = unresolvable (degenerate mutation — the reducer
 * would warn-and-skip it; the caller degrades to a full run).
 */
function containingForm(
	doc: BlueprintDoc,
	acc: ScopeAccumulator,
	uuid: Uuid,
): Uuid | undefined {
	let current: Uuid | undefined = uuid;
	// Bounded walk — fieldParent chains are tree-shaped, but a corrupt doc
	// must terminate rather than spin.
	for (let hops = 0; current !== undefined && hops < 10_000; hops++) {
		if (doc.forms[current] !== undefined || acc.addedForms.has(current)) {
			return current;
		}
		const next: Uuid | undefined =
			acc.addedFieldParents.get(current) ??
			doc.fieldParent[current] ??
			undefined;
		if (next === current) return undefined;
		current = next;
	}
	return undefined;
}

/** Look a field up in prevDoc or the batch overlay. */
function resolveField(
	doc: BlueprintDoc,
	acc: ScopeAccumulator,
	uuid: Uuid,
): Field | undefined {
	return doc.fields[uuid] ?? acc.addedFields.get(uuid);
}

/**
 * Whether `uuid`'s subtree in prevDoc writes ANY case property — the field
 * itself plus, for containers, every descendant, since a
 * remove/move/duplicate carries the whole subtree with it. A `true` maps
 * the mutation to `"full"` (see the header: writer-set changes reach
 * readers no entity-keyed widening can bound).
 */
function subtreeWritesCaseProperty(
	doc: BlueprintDoc,
	acc: ScopeAccumulator,
	uuid: Uuid,
): boolean {
	const stack: Uuid[] = [uuid];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) break;
		const field = resolveField(doc, acc, current);
		if (field && casePropertyOn(field) !== undefined) return true;
		const children = doc.fieldOrder[current];
		if (children) stack.push(...children);
	}
	return false;
}

/**
 * Whether `patch` touches `key` — the key is present AND its value differs
 * from the entity's current one. An in-memory clear travels as an explicit
 * `undefined`-valued key (see `lib/doc/CLAUDE.md`), so presence is tested
 * with `Object.hasOwn`, never truthiness.
 */
function patchTouches(
	patch: Record<string, unknown>,
	key: string,
	currentValue: unknown,
): boolean {
	return Object.hasOwn(patch, key) && patch[key] !== currentValue;
}

/**
 * Scope a mutation that targets a field (or a field-adjacent slot) to its
 * containing form. Form resolution only — each arm owns its own
 * case-property decision (a media-slot edit on a case-bound field never
 * touches the writer set; a remove of the same field does).
 */
function scopeFieldTarget(
	doc: BlueprintDoc,
	acc: ScopeAccumulator,
	fieldUuid: Uuid,
): void {
	const form = containingForm(doc, acc, fieldUuid);
	if (form === undefined) {
		acc.full = true;
		return;
	}
	acc.formUuids.add(form);
}

/**
 * Derive the scope for one persisted mutation batch against the doc it
 * will apply to. Returns `"full"` when any mutation in the batch demands
 * it; otherwise the union of the per-mutation scopes.
 */
export function scopeOfMutations(
	prevDoc: BlueprintDoc,
	mutations: readonly Mutation[],
): ValidationScope | "full" {
	const acc: ScopeAccumulator = {
		full: false,
		moduleUuids: new Set(),
		formUuids: new Set(),
		addedForms: new Map(),
		addedFieldParents: new Map(),
		addedFields: new Map(),
	};

	for (const mut of mutations) {
		// Overlay bookkeeping runs for every mutation (even once `full` is
		// set) so later resolutions in the same batch stay correct; the
		// scope writes themselves are harmless after `full`.
		switch (mut.kind) {
			// ── Module mutations ───────────────────────────────────────
			case "addModule":
				acc.moduleUuids.add(mut.module.uuid);
				break;
			case "removeModule":
				// Other forms may link to this module or its forms, and its
				// forms' case-property writers vanish app-wide.
				acc.full = true;
				break;
			case "moveModule":
				// Pure reorder of `moduleOrder` — no module/form finding
				// reads module position (the one order-sensitive rule,
				// duplicate module names, is an always-run app rule whose
				// identity is name-keyed). App rules alone cover it.
				break;
			case "renameModule":
				acc.moduleUuids.add(mut.uuid);
				break;
			case "updateModule": {
				const mod = prevDoc.modules[mut.uuid];
				if (
					mod === undefined ||
					patchTouches(mut.patch, "caseType", mod.caseType)
				) {
					// A module case-type change re-scopes every reference its
					// forms resolve and which writers count for which case
					// lists — cross-entity reach a widened scope can't bound.
					acc.full = true;
				} else {
					acc.moduleUuids.add(mut.uuid);
				}
				break;
			}
			case "setModuleMedia":
				acc.moduleUuids.add(mut.uuid);
				break;

			// ── Form mutations ─────────────────────────────────────────
			case "addForm":
				// The containing module: module rules read form count + types
				// (a new form can newly violate `CASE_LIST_ONLY_HAS_FORMS`),
				// and module scope covers the new form's own walk.
				acc.moduleUuids.add(mut.moduleUuid);
				acc.addedForms.set(mut.form.uuid, mut.moduleUuid);
				break;
			case "removeForm":
				// Any form anywhere may link to it; its fields' case-property
				// writes vanish app-wide.
				acc.full = true;
				break;
			case "moveForm":
				// Re-parents the form under a module whose case type may
				// differ — re-scopes the form's case derivation AND both
				// modules' rule inputs.
				acc.full = true;
				break;
			case "renameForm":
				acc.formUuids.add(mut.uuid);
				break;
			case "updateForm": {
				const form = prevDoc.forms[mut.uuid];
				if (form === undefined || patchTouches(mut.patch, "type", form.type)) {
					// A form-type flip changes which of its fields' writes are
					// real (a survey's `case_property_on` is inert) — writer
					// effects reach case lists app-wide.
					acc.full = true;
				} else {
					acc.formUuids.add(mut.uuid);
				}
				break;
			}
			case "setFormMedia":
				acc.formUuids.add(mut.uuid);
				break;

			// ── Field mutations ────────────────────────────────────────
			case "addField": {
				const form = containingForm(prevDoc, acc, mut.parentUuid);
				if (form === undefined) {
					acc.full = true;
				} else {
					acc.formUuids.add(form);
					// A landed writer declares its property (catalog gain) —
					// writer-set reach, full (see header).
					if (casePropertyOn(mut.field)) acc.full = true;
				}
				acc.addedFieldParents.set(mut.field.uuid, mut.parentUuid);
				acc.addedFields.set(mut.field.uuid, mut.field);
				break;
			}
			case "removeField":
			case "duplicateField":
				scopeFieldTarget(prevDoc, acc, mut.uuid);
				// Removing a writer (or cloning one — the clone's dedup rename
				// can mint a NEW property + catalog entry) changes the writer
				// set the case-property readers consume.
				if (subtreeWritesCaseProperty(prevDoc, acc, mut.uuid)) {
					acc.full = true;
				}
				break;
			case "moveField": {
				// Both ends: the source form loses the subtree, the target
				// form gains it.
				scopeFieldTarget(prevDoc, acc, mut.uuid);
				const targetForm = containingForm(prevDoc, acc, mut.toParentUuid);
				if (targetForm === undefined) {
					acc.full = true;
				} else {
					acc.formUuids.add(targetForm);
				}
				// A cross-level move dedup-renames on sibling collision — for a
				// case-property writer that renames the PROPERTY (new catalog
				// entry, new writer pair), so the subtree carrying any writer
				// degrades to full.
				if (subtreeWritesCaseProperty(prevDoc, acc, mut.uuid)) {
					acc.full = true;
				}
				break;
			}
			case "renameField":
			case "convertField": {
				scopeFieldTarget(prevDoc, acc, mut.uuid);
				// Renaming a case-bound field renames the case PROPERTY
				// (peer cascade + catalog rename); converting one changes the
				// writer's data type. Container renames stay form-local:
				// descendants keep their ids, so the writer set is untouched.
				const field = resolveField(prevDoc, acc, mut.uuid);
				if (field && casePropertyOn(field) !== undefined) {
					acc.full = true;
				}
				break;
			}
			case "updateField": {
				const patch = mut.patch as Record<string, unknown>;
				scopeFieldTarget(prevDoc, acc, mut.uuid);
				// Full iff the patch changes the field's WRITER PAIR
				// (case type, property name) while either side of the change
				// is case-bound: re-targeting `case_property_on` (set, change,
				// or `null`/empty clear) or renaming `id` on a bound field.
				// Patches that leave the pair alone (labels, expressions,
				// options) can only flip form-local findings.
				const field = resolveField(prevDoc, acc, mut.uuid);
				const prevType = field ? casePropertyOn(field) : undefined;
				const rawNext = patch.case_property_on;
				const nextType = Object.hasOwn(patch, "case_property_on")
					? typeof rawNext === "string" && rawNext.length > 0
						? rawNext
						: undefined
					: prevType;
				const pairChanges =
					nextType !== prevType ||
					(field !== undefined && patchTouches(patch, "id", field.id));
				if ((prevType !== undefined || nextType !== undefined) && pairChanges) {
					acc.full = true;
				}
				break;
			}
			case "setFieldMedia":
				// Media slots never touch the writer set — form scope, even on
				// a case-bound field (the media rules are scope-exempt anyway).
				scopeFieldTarget(prevDoc, acc, mut.fieldUuid);
				break;

			// ── App-level mutations ────────────────────────────────────
			case "setAppName":
			case "setConnectType":
			case "setAppLogo":
			case "setCaseTypes":
				// App-level state feeds rules across every entity
				// (`connectType` gates the per-form Connect rules; the
				// catalog feeds every case-reference admission set).
				acc.full = true;
				break;

			default: {
				// Exhaustiveness tripwire: a NEW mutation kind makes `mut`
				// non-never here and this fails to compile — forcing a scope
				// decision for it. At runtime (an unrecognized kind off a
				// stale payload) the batch degrades to a full run: slower,
				// never stale.
				const _exhaustive: never = mut;
				void _exhaustive;
				acc.full = true;
				break;
			}
		}
	}

	if (acc.full) return "full";
	return { moduleUuids: acc.moduleUuids, formUuids: acc.formUuids };
}
