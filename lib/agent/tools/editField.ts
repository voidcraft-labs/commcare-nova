/**
 * SA tool: `editField` — update properties on an existing field.
 *
 * The most complex of the field-edit tools: a single call can carry a
 * kind conversion, an id rename, AND a scalar-property patch. Each of
 * those three concerns produces its own mutation batch with its own
 * stage tag (`convert:M-F`, `rename:M-F`, `edit:M-F`) so the log UI and
 * replay derivations see each lifecycle step distinctly. Both the SA
 * chat factory and the MCP adapter call this through the shared
 * `ToolExecutionContext` interface.
 *
 * Batches execute sequentially, each `await ctx.recordMutations`-ed
 * before the next computes — later batches read from the post-previous
 * `workingDoc` so, for example, a scalar patch applied to a just-
 * converted field targets the new kind's schema. Running mutations are
 * accumulated into a single `mutations` array the wrapper uses only as a
 * non-empty sentinel: the per-batch persistence already happened, so the
 * SA wrapper's "advance closure on non-empty mutations" check still
 * works uniformly across every mutating tool.
 *
 * Five exit branches:
 *
 *   1. Field not found at the given triple → `{ error }`, no mutations.
 *   2. Illegal kind conversion (target not in the source kind's
 *      `convertTargets`) → `{ error }`, no mutations.
 *   3. Conversion rejected by the reducer (reconcile returned a shape
 *      the target kind's schema rejects) → `{ error }`, partial
 *      mutations already persisted.
 *   4. Rename left the field not found (shouldn't happen in practice) →
 *      `{ error }`.
 *   5. Success → human-readable summary string referencing the final
 *      id + changes.
 */

import { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	FieldKind,
	FieldPatchFor,
	Uuid,
} from "@/lib/domain";
import { getConvertibleTypes } from "@/lib/domain";
import {
	renameFieldMutations,
	resolveFieldByIndex,
	updateFieldMutations,
} from "../blueprintHelpers";
import { unescapeXPath } from "../contentProcessing";
import type { ToolExecutionContext } from "../toolExecutionContext";
import {
	editFieldUpdatesSchema,
	type wideEditUpdatesSchema,
} from "../toolSchemas";
import { applyToDoc, type MutatingToolResult } from "./common";

export const editFieldInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		fieldId: z.string().describe("Field id to update"),
		updates: editFieldUpdatesSchema,
	})
	.strict();

export type EditFieldInput = z.infer<typeof editFieldInputSchema>;

/** Either a human-readable summary string or an error record. */
export type EditFieldResult = string | { error: string };

/**
 * Coerce the scalar-patch portion of an `editField` call into the
 * reducer's field-patch shape. `id` and `kind` changes land via
 * dedicated mutations (`renameField`, `convertField`) earlier in the
 * tool body, so neither appears on this shape.
 *
 * Every clearable key in the edit schema is `.nullable().optional()`:
 *   - absent   → leave current value alone (key omitted from output)
 *   - `null`   → clear the property — emitted as `null`, NOT `undefined`.
 *                The `updateField` reducer deletes the key on a `null`
 *                value, and `null` (unlike `undefined`) survives Firestore,
 *                so the clear round-trips through the event log.
 *   - a value  → set the property (key present with the value)
 *
 * Unlike the add-path where empty string is a required-sentinel meaning
 * absent, the edit path reserves `null` for "clear" so the SA has an
 * unambiguous way to remove a property a user explicitly unset.
 */
/**
 * The WIDE edit-patch shape minus identity/discriminant. The per-kind edit
 * union tool input narrows this per arm; the mapper reads against the wide
 * shape so it touches any declared key without narrowing on `kind`.
 */
type EditUpdatesPatch = Omit<
	z.infer<typeof wideEditUpdatesSchema>,
	"id" | "kind"
>;

function editPatchToFieldPatch(
	updates: EditUpdatesPatch,
): FieldPatchFor<FieldKind> {
	const patch: Record<string, unknown> = {};
	// Plain scalars: SA passes a new value, `null` to clear, or omits to
	// leave unchanged. A `null` is preserved as `null` (the reducer deletes
	// the key on it). The XPath-valued scalars (`relevant`, `calculate`,
	// `default_value`, `required`) get HTML-entity unescape on the way
	// through — same treatment `applyDefaults` applies on the add path, so
	// the same SA payload produces the same stored entity through both tools.
	const xpathScalarKeys = new Set([
		"relevant",
		"calculate",
		"default_value",
		"required",
	]);
	const scalarKeys = [
		"label",
		"hint",
		// `help` is plain text (tap-to-expand longer-form guidance), so
		// it rides the plain-scalar path — no XPath unescape, unlike
		// `relevant` / `calculate` / `default_value` / `required`. The
		// media companion `help_media` is set through the dedicated
		// media tools, never via this text patch.
		"help",
		"required",
		"relevant",
		"calculate",
		"default_value",
		"case_property_on",
	] as const;
	for (const key of scalarKeys) {
		const value = updates[key];
		if (value === undefined) continue;
		if (typeof value === "string" && xpathScalarKeys.has(key)) {
			patch[key] = unescapeXPath(value);
		} else {
			// A string sets the property; `null` clears it (preserved as
			// `null` so the clear survives serialization).
			patch[key] = value;
		}
	}
	if (updates.options !== undefined) {
		patch.options = updates.options;
	}
	// Nested `validate: { expr, msg? }` config. SA passes:
	//   - object → replace; flatten back to schema's `validate` +
	//     `validate_msg` keys (msg unset → `null`, which clears it).
	//     `expr` is XPath, so unescape on the way through.
	//   - null → clear both keys (emitted as `null`).
	//   - undefined (omitted) → leave unchanged.
	if (updates.validate !== undefined) {
		if (updates.validate === null) {
			patch.validate = null;
			patch.validate_msg = null;
		} else {
			patch.validate = unescapeXPath(updates.validate.expr);
			patch.validate_msg = updates.validate.msg ?? null;
		}
	}
	// Nested `repeat: { mode, count?, ids_query? }` config. The patch
	// always overwrites all three flat repeat keys when `repeat` is
	// present: the new mode determines which mode-specific field is
	// valid, and the unused field gets `null` so the reducer clears it.
	// Mode is required inside the nested object so we always have a value
	// to write. `count` and `ids_query` are XPath expressions —
	// empty-string is treated as "not set" (matching the add path's
	// truthy-check) and unescaped when present.
	if (updates.repeat !== undefined) {
		patch.repeat_mode = updates.repeat.mode;
		patch.repeat_count =
			updates.repeat.count && updates.repeat.count.length > 0
				? unescapeXPath(updates.repeat.count)
				: null;
		patch.data_source =
			updates.repeat.ids_query && updates.repeat.ids_query.length > 0
				? { ids_query: unescapeXPath(updates.repeat.ids_query) }
				: null;
	}
	return patch as FieldPatchFor<FieldKind>;
}

export const editFieldTool = {
	description:
		"Update properties on an existing field. Only include properties you want to change. Use null to clear a property. Renaming the id automatically propagates XPath and column references — for case properties, propagates across all forms in the module.",
	inputSchema: editFieldInputSchema,
	async execute(
		input: EditFieldInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<EditFieldResult>> {
		const { moduleIndex, formIndex, fieldId, updates } = input;
		try {
			const resolved = resolveFieldByIndex(
				doc,
				moduleIndex,
				formIndex,
				fieldId,
			);
			if (!resolved) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Field "${fieldId}" not found in m${moduleIndex}-f${formIndex}`,
					},
				};
			}

			const { id: newId, kind: newKind, ...fieldUpdates } = updates;

			// Working doc walks forward through each batch so the next step
			// sees prior changes. The per-batch `recordMutations` call owns
			// persistence — `allMutations` is purely the wrapper's advance
			// sentinel at the end.
			let workingDoc = doc;
			const allMutations: Mutation[] = [];
			const fieldUuid: Uuid = resolved.field.uuid;

			// Kind change → `convertField` mutation (not `updateField`). The
			// updateField reducer parses the merged patch against
			// `fieldSchema` and silently no-ops when a kind change introduces
			// required keys the target kind demands (e.g. `options` on
			// `single_select`). Routing through convertField makes the intent
			// explicit + surfaces a clear error when the conversion isn't
			// allowed by the source kind's `convertTargets` list.
			if (newKind && newKind !== resolved.field.kind) {
				const fromKind = resolved.field.kind;
				const allowed = getConvertibleTypes(fromKind);
				if (!allowed.includes(newKind)) {
					// The passed `kind` is neither the field's actual kind nor a
					// legal conversion target. Name the ACTUAL kind so the agent
					// can correct in one turn — most often it meant to edit in
					// place and passed the wrong kind, so lead with the right one,
					// then compose the convert hint to read naturally whether or
					// not this kind has any conversion targets.
					const convertHint =
						allowed.length > 0
							? ` To convert it to a different kind, pass one of: ${allowed.join(", ")}.`
							: ` A "${fromKind}" field can't be converted to another kind.`;
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: `Field "${fieldId}" is a "${fromKind}" field, but you passed kind="${newKind}". To edit it in place, pass kind="${fromKind}".${convertHint}`,
						},
					};
				}
				const convertMuts: Mutation[] = [
					{ kind: "convertField", uuid: fieldUuid, toKind: newKind },
				];

				// Apply locally first so we can verify the reducer accepted
				// the conversion before persisting the event. A silent no-op
				// from the reducer (reconcile produces a shape the target
				// kind's schema rejects) would otherwise write a misleading
				// `convert:M-F` event to the log and the SA wrapper would
				// advance `doc = newDoc` against unchanged state. Mirrors
				// the rename + scalar-patch sections' order: apply → verify
				// → persist.
				const afterConvert = applyToDoc(workingDoc, convertMuts);
				const postConvertField = afterConvert.fields[fieldUuid];
				if (!postConvertField || postConvertField.kind !== newKind) {
					return {
						kind: "mutate" as const,
						mutations: allMutations,
						newDoc: workingDoc,
						result: {
							error: `convertField ${fromKind} → ${newKind} for "${fieldId}" rejected by the reducer: the target kind's schema requires a key the source doesn't carry. Add the missing key first (e.g. \`options\` for select kinds), then retry.`,
						},
					};
				}

				await ctx.recordMutations(
					convertMuts,
					afterConvert,
					`convert:${moduleIndex}-${formIndex}`,
				);
				workingDoc = afterConvert;
				allMutations.push(...convertMuts);
			}

			// Id rename next as its own emitted batch. The `renameField`
			// reducer handles the full cascade on its own — form-local path /
			// hashtag rewrites, cross-form `#case/` hashtag rewrites scoped
			// to modules with matching caseType, peer-field renames, and case
			// list / detail column renames. The client runs the SAME reducer
			// against `applyMany`, so the cascade reproduces on the client
			// without needing a full blueprint snapshot.
			if (newId && newId !== fieldId) {
				const renameMuts = renameFieldMutations(workingDoc, fieldUuid, newId);
				if (renameMuts.length > 0) {
					workingDoc = applyToDoc(workingDoc, renameMuts);
					await ctx.recordMutations(
						renameMuts,
						workingDoc,
						`rename:${moduleIndex}-${formIndex}`,
					);
					allMutations.push(...renameMuts);
				}
			}

			// Re-resolve the field record after rename — the uuid is stable,
			// but we want the most recent `field` snapshot from `workingDoc`.
			const finalId = newId ?? fieldId;
			const afterRename = resolveFieldByIndex(
				workingDoc,
				moduleIndex,
				formIndex,
				finalId,
			);
			if (!afterRename) {
				return {
					kind: "mutate" as const,
					mutations: allMutations,
					newDoc: workingDoc,
					result: { error: `Field "${finalId}" not found after rename` },
				};
			}

			// Remaining scalar-patch keys as a final batch. Convert + rename
			// already landed; this covers only the leftovers. The reducer
			// still gates against shape violations via `fieldSchema.safeParse`,
			// so anything slipping through here that doesn't fit the
			// (possibly just-converted) kind is logged and no-ops safely.
			if (Object.keys(fieldUpdates).length > 0) {
				// `fieldUpdates` is one validated per-kind union arm's rest; TS
				// infers its conditionally-present keys as `unknown`, so bridge
				// to the wide patch shape (sound — the arm is a structural
				// subset).
				const patch = editPatchToFieldPatch(fieldUpdates as EditUpdatesPatch);
				if (Object.keys(patch).length > 0) {
					// `afterRename.field.kind` is the kind after any
					// just-applied conversion — pass it as `targetKind` so
					// the mutation discriminates against the post-convert
					// shape, not the pre-convert kind from `resolved.field`.
					const updateMuts = updateFieldMutations(
						workingDoc,
						afterRename.field.uuid,
						afterRename.field.kind,
						patch,
					);
					if (updateMuts.length > 0) {
						workingDoc = applyToDoc(workingDoc, updateMuts);
						await ctx.recordMutations(
							updateMuts,
							workingDoc,
							`edit:${moduleIndex}-${formIndex}`,
						);
						allMutations.push(...updateMuts);
					}
				}
			}

			const postField = workingDoc.fields[afterRename.field.uuid];
			// `kind` is always present (it's the edit union's discriminator), so
			// only list it as a change when it was an actual conversion.
			const changedFields = Object.keys(updates)
				.filter((k) => k !== "kind" || newKind !== resolved.field.kind)
				.join(", ");
			const renameNote =
				newId && newId !== fieldId ? ` (renamed from "${fieldId}")` : "";
			// `afterRename` already carries the form's uuid — read the display
			// name directly rather than re-traversing `moduleOrder` →
			// `formOrder` to get back to the same uuid.
			const formName =
				workingDoc.forms[afterRename.formUuid]?.name ??
				`m${moduleIndex}-f${formIndex}`;
			const label = postField && "label" in postField ? postField.label : "";
			const kind = postField?.kind ?? "unknown";
			return {
				kind: "mutate" as const,
				mutations: allMutations,
				newDoc: workingDoc,
				result: `Successfully updated "${finalId}"${renameNote} in "${formName}". Changed: ${changedFields}. Current label: "${label}", kind: ${kind}.`,
			};
		} catch (err) {
			return {
				kind: "mutate" as const,
				mutations: [],
				newDoc: doc,
				result: { error: err instanceof Error ? err.message : String(err) },
			};
		}
	},
};
