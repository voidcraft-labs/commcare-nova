import { type Draft, isDraft, original } from "immer";
import { spliceAfter, spliceEntryAfter } from "@/lib/doc/mutations/sequence";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import {
	CASE_SCALAR_PROPERTY_NAMES,
	caseDataTypeForFieldKind,
	type Field,
	fieldCaseWrite,
	fieldKindDeclaresKey,
	fieldSchema,
	getConvertibleTypes,
	isContainer,
	pickFieldKeysForKind,
	proseText,
	reconcileFieldForKind,
} from "@/lib/domain";
import {
	cascadeDeleteField,
	findContainingForm,
	findFieldParent,
} from "./helpers";

/**
 * Field mutations:
 *   - addField, updateField: simple entity-level edits
 *   - removeField: cascade delete subtree
 *   - moveField: same-form reorder/reparent with identity unchanged
 *   - convertField: kind conversion
 */
export function applyFieldMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{
			kind:
				| "addField"
				| "removeField"
				| "moveField"
				| "updateField"
				| "convertField"
				| "setFieldMedia"
				| "addOption"
				| "updateOption"
				| "removeOption"
				| "moveOption";
		}
	>,
): void {
	switch (mut.kind) {
		case "addField": {
			// Parent must be a form or a group/repeat that already has an
			// order entry (groups/repeats are added via addField + an
			// empty order slot, so we also allow parents that are registered
			// fields).
			const parentExists =
				draft.forms[mut.parentUuid] !== undefined ||
				draft.fields[mut.parentUuid] !== undefined;
			if (!parentExists) return;
			// Cloned: `updateField` edits the stored field in place, and the payload
			// must not be the object it edits — a second apply of the same batch
			// would be assigning to a frozen produced state.
			const field = structuredClone(mut.field);
			// `after` absent appends, `null` puts it first — the two are distinct
			// so "add at the top" survives the wire, where JSON drops `undefined`.
			draft.fieldOrder[mut.parentUuid] = spliceAfter(
				draft.fieldOrder[mut.parentUuid] ?? [],
				field.uuid,
				mut.after,
			);
			draft.fields[field.uuid] = field;
			// If the new field is a container, pre-seed its order slot so
			// child insertions have a valid parent to target immediately.
			if (isContainer(field)) {
				draft.fieldOrder[field.uuid] ??= [];
			}
			// A landed case-property writer declares its property — sync
			// the catalog (see `ensureCatalogProperty`).
			ensureCatalogProperty(draft as unknown as BlueprintDoc, field);
			return;
		}
		case "updateField": {
			const field = draft.fields[mut.uuid];
			if (!field) return;
			const previousField = isDraft(field) ? (original(field) ?? field) : field;
			// Identity + kind guard. `mut.targetKind` is the kind the caller
			// constructed the patch against. If the field's actual kind has
			// drifted (e.g. a `convertField` ran between mutation construction
			// and dispatch in a parallel batch), the patch's allowed keys no
			// longer match the field — skip the stale mutation rather than
			// merging keys that don't apply to the current kind.
			if (field.kind !== mut.targetKind) {
				console.warn(
					`updateField: skipped a stale patch for ${mut.uuid}, the patch was built for a "${mut.targetKind}" field, but the field is now a "${field.kind}". The field probably converted kind between when this update was queued and when it ran. Re-read the field, rebuild the patch, and try again.`,
				);
				return;
			}
			// Construct the complete prospective entity without mutating the
			// draft. A patch `null` clears an optional slot; required `id` is
			// non-nullable in the mutation schema.
			const spread: Record<string, unknown> = { ...field };
			for (const [key, value] of Object.entries(mut.patch)) {
				if (value === null) {
					delete spread[key];
				} else {
					spread[key] = value;
				}
			}
			// Filter the result through `pickFieldKeysForKind` before
			// parsing. The type-level discriminator on `targetKind` catches
			// cross-kind patches at compile time, but the repeat kind has an
			// inner `repeat_mode` discriminator the per-kind partial schema
			// can't guard: a patch that switches `count_bound →
			// user_controlled` leaves the previous mode's `repeat_count` key
			// behind, and the strict per-variant schema would reject it. The
			// filter dispatches on the merged result's `repeat_mode` so a
			// mode-switch picks up the destination variant's key set,
			// dropping the stale slot. For non-repeat kinds the filter is
			// a tight no-op (the picked key set covers every key the merge
			// can carry) — defense-in-depth without a meaningful cost.
			const merged = pickFieldKeysForKind(spread, mut.targetKind);
			const result = fieldSchema.safeParse(merged);
			if (!result.success) {
				// A patch that fails the schema is a programmer error — log
				// with the exact issues so the offending call site is easy
				// to locate, then skip the update rather than throwing from
				// inside an Immer reducer (a throw would propagate up through
				// `store.applyMany()` and crash the surrounding render).
				console.warn(
					`updateField: a patch for ${mut.uuid} (kind=${field.kind}) didn't fit the field's schema and was skipped. The merged shape failed validation. Check that every patch value is the right type for its key.`,
					{ patch: mut.patch, issues: result.error.issues },
				);
				return;
			}
			// Zod returns a deep clone. Restore every unpatched slot from the
			// already-valid previous field so Immer's structural-sharing contract
			// remains precise: an update to caseWrite must not make calculate,
			// label, options, or any other untouched nested value look edited to
			// per-field subscribers. Destination-mode filtering above still wins:
			// keys that disappeared from the parsed result are never restored.
			const nextField = result.data as Field;
			const nextRecord = nextField as unknown as Record<string, unknown>;
			const previousRecord = previousField as unknown as Record<
				string,
				unknown
			>;
			const patchedKeys = new Set(Object.keys(mut.patch));
			for (const key of Object.keys(nextRecord)) {
				if (!patchedKeys.has(key) && Object.hasOwn(previousRecord, key)) {
					nextRecord[key] = previousRecord[key];
				}
			}

			// Install only after the complete prospective field has passed its
			// strict schema. UUID-backed field references need no rewrite: their
			// text projection immediately resolves through this field's new id.
			// `applyMutations` has already applied the batch's complete
			// simultaneous case-property relation to every batch-start carrier;
			// this scalar install must never launch a second sequential cascade.
			draft.fields[mut.uuid] = nextField;

			// Every landed non-empty writer pair is registered. Clears and
			// retargets deliberately never prune the old catalog entry.
			ensureCatalogProperty(draft as unknown as BlueprintDoc, nextField);
			return;
		}
		case "removeField": {
			if (draft.fields[mut.uuid] === undefined) return;
			const parent = findFieldParent(
				draft as unknown as BlueprintDoc,
				mut.uuid,
			);
			if (parent) {
				const order = draft.fieldOrder[parent.parentUuid];
				if (order) {
					order.splice(parent.index, 1);
					draft.fieldOrder[parent.parentUuid] = order;
				}
			}
			cascadeDeleteField(draft as unknown as BlueprintDoc, mut.uuid);
			return;
		}
		case "moveField": {
			const field = draft.fields[mut.uuid];
			if (!field) return;
			// A same-parent move is a pure reorder. A cross-parent move needs
			// the complete destination, subtree, and same-form checks below.
			const currentParent = findFieldParent(
				draft as unknown as BlueprintDoc,
				mut.uuid,
			);
			if (currentParent?.parentUuid === mut.toParentUuid) {
				draft.fieldOrder[mut.toParentUuid] = spliceAfter(
					draft.fieldOrder[mut.toParentUuid] ?? [],
					mut.uuid,
					mut.after,
				);
				return;
			}
			const destIsForm = draft.forms[mut.toParentUuid] !== undefined;
			const destField = draft.fields[mut.toParentUuid];
			const destIsContainer = destField !== undefined && isContainer(destField);
			if (!destIsForm && !destIsContainer) return;

			if (!destIsForm) {
				let insideMovedSubtree = false;
				let cursor: Uuid | undefined = mut.toParentUuid;
				const seen = new Set<Uuid>();
				while (cursor !== undefined && !seen.has(cursor)) {
					if (cursor === mut.uuid) {
						insideMovedSubtree = true;
						break;
					}
					seen.add(cursor);
					const ancestor = findFieldParent(
						draft as unknown as BlueprintDoc,
						cursor,
					);
					cursor =
						ancestor !== undefined &&
						draft.forms[ancestor.parentUuid] === undefined
							? ancestor.parentUuid
							: undefined;
				}
				if (insideMovedSubtree) {
					console.warn(
						`moveField: skipped moving "${field.id}", the destination container is the field itself or one of its own descendants, and a field can't move inside its own subtree. Pick a destination outside the moved ${field.kind}.`,
						{ uuid: mut.uuid, toParentUuid: mut.toParentUuid },
					);
					return;
				}
			}

			const sourceFormUuid = findContainingForm(
				draft as unknown as BlueprintDoc,
				mut.uuid,
			);
			const destFormUuid = destIsForm
				? mut.toParentUuid
				: findContainingForm(
						draft as unknown as BlueprintDoc,
						mut.toParentUuid,
					);
			if (
				sourceFormUuid === undefined ||
				destFormUuid === undefined ||
				sourceFormUuid !== destFormUuid
			) {
				console.warn(
					`moveField: skipped moving "${field.id}", the move couldn't be confirmed to stay within one form (the destination is in a different form, or one end isn't reachable from any form). A field can't move between forms because its references can't follow it across the form boundary; remove the field and recreate it in the other form instead.`,
					{ uuid: mut.uuid, toParentUuid: mut.toParentUuid },
				);
				return;
			}

			const sourceParent = findFieldParent(
				draft as unknown as BlueprintDoc,
				mut.uuid,
			);
			if (sourceParent) {
				const srcOrder = draft.fieldOrder[sourceParent.parentUuid];
				if (srcOrder) {
					srcOrder.splice(sourceParent.index, 1);
					draft.fieldOrder[sourceParent.parentUuid] = srcOrder;
				}
			}

			draft.fieldOrder[mut.toParentUuid] = spliceAfter(
				draft.fieldOrder[mut.toParentUuid] ?? [],
				mut.uuid,
				mut.after,
			);
			return;
		}
		case "convertField": {
			const field = draft.fields[mut.uuid];
			if (!field) return;
			// No-op if the kind is already the target (treat as idempotent).
			if (field.kind === mut.toKind) return;
			// Convertibility gate — the UI gates on this list too, but the
			// reducer is the authoritative second layer. Without it, the
			// `fieldSchema.safeParse` inside `reconcileFieldForKind` will
			// happily accept structurally destructive swaps that Zod cannot
			// detect:
			//   - container → leaf: a group with children becomes a text
			//     entity, leaving `fieldOrder[uuid]` populated with orphan
			//     descendants that walkers + navigation still see.
			//   - leaf → container: a text entity becomes a group with no
			//     `fieldOrder` entry, breaking the "every container has an
			//     order slot" invariant enforced everywhere else.
			// The convertTargets list in each kind's FieldKindMetadata is the
			// single source of truth for which swaps are semantically valid.
			const allowed = getConvertibleTypes(field.kind);
			if (!allowed.includes(mut.toKind)) {
				// `console.warn`, not the structured logger — reducers bundle
				// client-side, where the logger's production path throws (see
				// the moveField guard note).
				console.warn(
					`convertField: skipped converting "${field.id}", a "${field.kind}" field can't convert to "${mut.toKind}".${allowed.length > 0 ? ` Valid targets: ${allowed.join(", ")}.` : ""}`,
					{ uuid: mut.uuid, validTargets: allowed },
				);
				return;
			}
			const reconciled = reconcileFieldForKind(
				field,
				mut.toKind,
				mut.optionsSource !== undefined
					? { optionsSource: mut.optionsSource }
					: undefined,
			);
			if (!reconciled) {
				// Reachable on one real path: a conversion into a select kind
				// (options `.min(2)` required) whose mutation carries no — or
				// too few — seed options from a source kind with no options of
				// its own (text → single_select). The batch-building layers
				// (the SA tool, the builder gesture) always attach the seed, so
				// hitting this is a caller bug; every other kind pair in a
				// `convertTargets` list reconciles by construction. Throwing
				// inside an Immer reducer would propagate up through
				// `store.applyMany()` and crash the surrounding render —
				// warning + no-op keeps the app alive while making the anomaly
				// visible in dev tools.
				console.warn(
					`convertField: couldn't reconcile "${field.id}" from "${field.kind}" to "${mut.toKind}", the converted shape failed the field schema, so the field was left unchanged.`,
					{ uuid: mut.uuid, field },
				);
				return;
			}
			draft.fields[mut.uuid] = reconciled;
			// The destination kind may derive a different catalog
			// `data_type` for a surviving `caseWrite` binding; a
			// pair already declared is left untouched (declared wins —
			// the kind/declaration agreement rule owns mismatches).
			ensureCatalogProperty(draft as unknown as BlueprintDoc, reconciled);
			return;
		}
		case "setFieldMedia": {
			// Set or clear one message slot's media bundle. The mutation
			// carries an explicit `media: Media | null` (null survives JSON
			// where `{ key: undefined }` would not), so both set and clear
			// cross the SSE wire intact. The slot name maps to the
			// `<slot>_media` field key.
			const field = draft.fields[mut.fieldUuid];
			if (!field) return;
			const mediaKey = `${mut.slot}_media` as const;
			// Guard slot-vs-kind against the schema key set (not `key in field`
			// — an unset optional slot is absent as an own property even on a
			// supporting kind). A slot the kind doesn't declare is skipped
			// rather than written as a stray key the strict field schema would
			// later reject. The SA tool rejects this up front; the reducer
			// guard is the backstop for any other emitter.
			if (!fieldKindDeclaresKey(field.kind, mediaKey)) {
				console.warn(
					`setFieldMedia: skipped setting ${mut.slot} media on "${field.id}", a "${field.kind}" field has no ${mediaKey} slot.`,
					{ uuid: mut.fieldUuid, slot: mut.slot },
				);
				return;
			}
			// A clear removes the own property completely (the slot is
			// `.optional()`, never stored as `null` or `undefined`). Cast through
			// a record view: the four `<slot>_media` keys live on different
			// arms of the discriminated `Field` union with no single common
			// parent, so a structural write is the cleanest way to set one.
			const record = field as Record<string, unknown>;
			if (mut.media === null) {
				delete record[mediaKey];
			} else {
				record[mediaKey] = mut.media;
			}
			return;
		}
		case "addOption":
		case "updateOption":
		case "removeOption":
		case "moveOption":
			applyOptionMutation(draft, mut);
			return;
	}
}

/**
 * Granular select-option mutations. The `options` array IS the sequence,
 * keyed by per-option `uuid` for addressing, so two
 * members editing different options merge.
 *
 * These reducers mutate the inline `field.optionsSource.options` IN PLACE and
 * DELIBERATELY do not
 * re-parse the field through `fieldSchema` (which carries `options.min(2)`):
 * a `removeOption` dropping below two options must reach the commit gate as a
 * sub-2 candidate so `SELECT_TOO_FEW_OPTIONS` can reject it — a re-parse here
 * would warn-skip the reducer and the gate would see no change. `update`
 * A content `update` cannot clobber a concurrent `moveOption`: place is the
 * array position, which an update never touches.
 */
function applyOptionMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{ kind: "addOption" | "updateOption" | "removeOption" | "moveOption" }
	>,
): void {
	const field = draft.fields[mut.fieldUuid];
	if (
		!field ||
		!("optionsSource" in field) ||
		field.optionsSource.kind !== "inline"
	) {
		return;
	}
	const options = field.optionsSource.options;
	switch (mut.kind) {
		case "addOption": {
			// Idempotent on uuid (a re-applied add is a no-op).
			if (options.some((o) => o.uuid === mut.option.uuid)) return;
			field.optionsSource.options = spliceEntryAfter(
				options,
				structuredClone(mut.option),
				mut.after,
			) as typeof field.optionsSource.options;
			return;
		}
		case "updateOption": {
			const idx = options.findIndex((o) => o.uuid === mut.uuid);
			if (idx === -1) return;
			// Replace content in place. The option keeps its position because
			// position is the index it already occupies, so there is nothing to
			// carry across — a content edit cannot clobber a concurrent move.
			options[idx] = { ...mut.option, uuid: mut.uuid };
			return;
		}
		case "removeOption": {
			const idx = options.findIndex((o) => o.uuid === mut.uuid);
			if (idx !== -1) options.splice(idx, 1);
			return;
		}
		case "moveOption": {
			// The `options` array IS the sequence, so the move reorders it. An
			// option a peer removed cannot be moved back into it.
			const opt = options.find((o) => o.uuid === mut.uuid);
			if (opt === undefined) return;
			field.optionsSource.options = spliceEntryAfter(
				options,
				opt,
				mut.after,
			) as typeof field.optionsSource.options;
			return;
		}
	}
}

/**
 * Catalog sync at source: register a field's explicit
 * `(caseWrite.caseType, caseWrite.property)` pair in the case-type catalog iff
 * absent.
 *
 * The catalog (`doc.caseTypes[].properties`) is the authoritative
 * admission set for `#<type>/<prop>` references — the deep validator,
 * inline linter, chip hydrator, and autocomplete all read it via
 * `reachableCaseTypes`. A field that writes to a case property IS a
 * declaration of that property, so every reducer arm that lands a
 * field with (or changes a field to have) a non-empty
 * `caseWrite` calls this — `addField`, `updateField`, and `convertField`.
 * Reducer-side so server, client, and event-log
 * replay derive byte-identical catalogs from the same mutation.
 *
 * Admission rules, matching the validator's model:
 *   - A declared entry is never touched — no duplicate, no
 *     `data_type` / `label` overwrite. Writer/declaration mismatches
 *     stay visible to the `FIELD_KIND_PROPERTY_TYPE_MISMATCH` rule.
 *   - An absent case TYPE is NOT created here — declaration is an explicit
 *     act (the authoring chokepoint prepends a `declareCaseType` for any
 *     `caseWrite`-setting surface). A field left writing to an
 *     undeclared type is what the
 *     commit gate's `CASE_WRITE_UNKNOWN_TYPE` rejects — keeping the
 *     creation explicit is what lets two members concurrently add different
 *     properties to one type and merge (a reducer that re-minted the type on
 *     every writer would clobber a concurrent declaration). Ancestry
 *     (`parent_type` / `relationship`) is likewise a declaration-level act
 *     (`setCaseTypeMeta`) — never invented here.
 *   - New entries carry the kind-derived `data_type` from the locked
 *     domain table (`caseDataTypeForFieldKind`); kinds that don't pin
 *     a value type (`hidden`) yield an untyped entry, read as `text`
 *     everywhere via the `effectiveDataType` convention. `label`
 *     defaults to the property name, the same shape `augmentCaseType`
 *     gives writer-derived entries.
 *   - Removal/clear never prunes — declared properties outlive their
 *     writers by design.
 */
function ensureCatalogProperty(doc: BlueprintDoc, field: Field): void {
	const write = fieldCaseWrite(field);
	if (write === undefined) return;
	// Fixed case-row scalars are implicit on every case type. A writer never
	// synthesizes their optional catalog metadata/order entries.
	if (CASE_SCALAR_PROPERTY_NAMES.has(write.property)) return;
	// Append only to an EXISTING declared type — never create the type here.
	const ct = doc.caseTypes?.find((c) => c.name === write.caseType);
	if (!ct) return;
	if (ct.properties.some((p) => p.name === write.property)) return;
	const dataType = caseDataTypeForFieldKind(field.kind);
	ct.properties.push({
		name: write.property,
		label: proseText(write.property),
		...(dataType !== undefined && { data_type: dataType }),
	});
}
