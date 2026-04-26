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
import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import { fieldRegistry } from "@/lib/domain";
import {
	renameFieldMutations,
	resolveFieldByIndex,
	updateFieldMutations,
} from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { editFieldUpdatesSchema } from "../toolSchemas";
import { applyToDoc, type MutatingToolResult } from "./common";

export const editFieldInputSchema = z.object({
	moduleIndex: z.number().describe("0-based module index"),
	formIndex: z.number().describe("0-based form index"),
	fieldId: z.string().describe("Field id to update"),
	updates: editFieldUpdatesSchema,
});

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
 *   - `null`   → clear the property (key present with `undefined`;
 *                Immer's Object.assign drops it)
 *   - a value  → set the property (key present with the value)
 *
 * Uniform `?? undefined` coercion covers all three cases. Unlike the
 * add-path where empty string is a required-sentinel meaning absent,
 * the edit path reserves `null` for "clear" so the SA has an
 * unambiguous way to remove a property a user explicitly unset.
 */
function editPatchToFieldPatch(
	updates: Omit<z.infer<typeof editFieldUpdatesSchema>, "id" | "kind">,
): Partial<Omit<Field, "uuid">> {
	const patch: Record<string, unknown> = {};
	const scalarKeys = [
		"label",
		"hint",
		"required",
		"validate",
		"validate_msg",
		"relevant",
		"calculate",
		"default_value",
		"case_property",
	] as const;
	for (const key of scalarKeys) {
		const value = updates[key];
		if (value === undefined) continue;
		patch[key] = value ?? undefined;
	}
	if (updates.options !== undefined) {
		patch.options = updates.options ?? undefined;
	}
	return patch as Partial<Omit<Field, "uuid">>;
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
				const allowed = fieldRegistry[fromKind].convertTargets;
				if (!allowed.includes(newKind)) {
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: `Cannot convert ${fromKind} to ${newKind}. Valid targets: ${allowed.length > 0 ? allowed.join(", ") : "(none)"}.`,
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
				const patch = editPatchToFieldPatch(fieldUpdates);
				if (Object.keys(patch).length > 0) {
					const updateMuts = updateFieldMutations(
						workingDoc,
						afterRename.field.uuid,
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
			const changedFields = Object.keys(updates).join(", ");
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
