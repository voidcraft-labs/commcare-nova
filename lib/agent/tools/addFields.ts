/**
 * SA tool: `addFields` — bulk-add fields to an existing form.
 *
 * The SA emits a list of fields, each a per-kind union arm (the kind picks
 * which properties exist — see `toolSchemaGenerator.ts`). This tool runs
 * each through the three-step pipeline in `contentProcessing.ts` —
 * `stripEmpty` → `applyDefaults` → `flatFieldToField` — mints uuids,
 * resolves semantic parent ids (including parents added earlier in the
 * same batch), and emits one mutation batch tagged `form:M-F`.
 *
 * Appends to existing fields by default (the SA relies on that contract
 * when it splits a large add across multiple calls); an optional
 * `beforeFieldId` / `afterFieldId` anchor instead inserts the batch's
 * top-level fields as a contiguous block at that position (fields nested
 * under their own `parentId` are unaffected). This is the only field-add
 * tool — one field is just a length-1 `fields` array.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Three legal exit branches
 * all land on the `MutatingToolResult` shape:
 *
 *   1. Index resolution miss (module / form) → `{ error }`, no
 *      mutations.
 *   2. Runtime error in the pipeline → `{ error }`, no mutations.
 *   3. Success → a human-readable `message` (+ a UI `summary`); the stage
 *      tag drives lifecycle derivation on the chat client.
 */

import { z } from "zod";
import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { findFieldByBareId, resolveFormContext } from "../blueprintHelpers";
import {
	applyDefaults,
	type FlatField,
	flatFieldToField,
	stripEmpty,
} from "../contentProcessing";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { addFieldsItemSchema } from "../toolSchemas";
import { applyToDoc, type MutatingToolResult } from "./common";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const addFieldsInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		fields: z.array(addFieldsItemSchema),
		// Default parent for the whole batch: the id of a group/repeat to
		// nest every field under. A field's OWN `parentId` overrides this.
		parentId: z
			.string()
			.optional()
			.describe(
				"Default parent for the batch: id of a group/repeat to nest every field under. A field's own parentId overrides this. Omit to add at the form's top level.",
			),
		// Optional insertion anchor for the batch's top-level block. The
		// fields that land in the batch's insertion parent (the form root, or
		// the batch `parentId`) are inserted as a contiguous block at the
		// anchor; fields carrying their own `parentId` nest under it and are
		// unaffected. Omit both to append at the end (the common case during
		// a build).
		afterFieldId: z
			.string()
			.optional()
			.describe(
				"Insert the batch's top-level fields after this existing field id. Omit to append at the end.",
			),
		beforeFieldId: z
			.string()
			.optional()
			.describe(
				"Insert the batch's top-level fields before this existing field id. Takes precedence over afterFieldId.",
			),
	})
	.strict();

export type AddFieldsInput = z.infer<typeof addFieldsInputSchema>;

/**
 * Success carries a verbose human-readable `message` the SA reads back
 * without re-querying the doc — field count delta, added ids, and any
 * skipped-during-assembly entries — plus a UI-only `summary` for the chat
 * transcript; failure is an error record.
 */
export type AddFieldsResult = MutationSuccess | { error: string };

export const addFieldsTool = {
	description:
		"Add one or more fields to an existing form in a single call (one field is just a length-1 `fields` array). Appends to existing fields by default (does not replace); pass beforeFieldId/afterFieldId to insert the batch's top-level fields at a specific position instead. Pass a top-level parentId to nest the whole batch under a group/repeat, or set parentId on individual fields to place them precisely (a field's own parentId wins). Groups added in one batch can be referenced as parentId in later batches.",
	inputSchema: addFieldsInputSchema,
	async execute(
		input: AddFieldsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddFieldsResult>> {
		const {
			moduleIndex,
			formIndex,
			fields,
			parentId: batchParentId,
			afterFieldId,
			beforeFieldId,
		} = input;
		try {
			// Shared positional resolver — fails closed with a single error
			// message when either index is out of range. Tool-specific
			// wording stays at the call site so the SA sees "Form m0-f2 not
			// found" rather than the helper's generic "form not found".
			const resolved = resolveFormContext(doc, moduleIndex, formIndex);
			if (!resolved) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Form m${moduleIndex}-f${formIndex} not found`,
					},
				};
			}
			const { formUuid, form } = resolved;

			// Resolve the batch's insertion parent — the form root, or the
			// batch-level `parentId` when it names an existing field (mirrors
			// the per-field fallback in the loop, which resolves an unset
			// per-item parentId to this same batch default). When an anchor
			// (`beforeFieldId` / `afterFieldId`) is given, find the index in
			// that parent's CURRENT order where the batch's top-level block
			// should start; `topLevelNextIndex` then walks forward as each
			// top-level field is placed, so the inserted fields land
			// contiguously in batch order. A field carrying its OWN parentId
			// nests under that parent and never consumes an anchor slot.
			let batchInsertParent: Uuid = formUuid;
			if (batchParentId) {
				const existing = findFieldByBareId(doc, formUuid, batchParentId);
				if (existing) batchInsertParent = existing.field.uuid;
			}
			let topLevelNextIndex: number | undefined;
			if (beforeFieldId || afterFieldId) {
				const order = doc.fieldOrder[batchInsertParent] ?? [];
				if (beforeFieldId) {
					const i = order.findIndex((u) => doc.fields[u]?.id === beforeFieldId);
					if (i !== -1) topLevelNextIndex = i;
				} else if (afterFieldId) {
					const i = order.findIndex((u) => doc.fields[u]?.id === afterFieldId);
					if (i !== -1) topLevelNextIndex = i + 1;
				}
			}

			// Process incoming flat SA-format fields: strip sentinels, apply
			// case-property defaults from the data model, then mint a uuid
			// and assemble the domain `Field` shape. The SA emits flat items
			// with semantic `parentId` — resolve each to a uuid by id lookup
			// within the form's existing + newly-added fields. If the SA
			// refers to a parent added earlier in this same batch, we find
			// it in `mintedByBareId` before falling back to the doc-wide
			// lookup.
			const mintedByBareId = new Map<string, Uuid>();
			const mutations: Mutation[] = [];
			const skipped: Array<{ id: string; reason: string }> = [];

			for (const raw of fields) {
				// `raw` is a per-kind union arm (the tool input is a
				// `discriminatedUnion("kind", …)`). TS infers a union arm's
				// conditionally-present keys as `unknown`, so it isn't directly
				// assignable to the wide `FlatField` the pipeline operates on —
				// but the arm IS a validated structural subset of `FlatField`,
				// so the bridge cast is sound. `stripEmpty` then narrows
				// `parentId?: string | null` (sentinel-empty-string → null), and
				// `applyDefaults` preserves that narrowing.
				const processed = applyDefaults(
					stripEmpty(raw as FlatField),
					doc.caseTypes,
				);

				// Resolve parentUuid: the field's OWN `parentId` wins; if it
				// didn't set one, fall back to the batch-level `parentId`; if
				// neither is set, the field lands at the form's top level.
				// `stripEmpty` normalizes an unset per-item parentId to `null`,
				// so `?? batchParentId` correctly applies the batch default.
				let parentUuid: Uuid = formUuid;
				const parentId = processed.parentId ?? batchParentId;
				if (parentId && typeof parentId === "string") {
					const minted = mintedByBareId.get(parentId);
					if (minted) {
						parentUuid = minted;
					} else {
						const existing = findFieldByBareId(doc, formUuid, parentId);
						if (existing) parentUuid = existing.field.uuid;
						// If we can't resolve, fall through to form-level
						// insert — better to land somewhere than to fail.
					}
				}

				const fieldUuid = asUuid(crypto.randomUUID());
				const assembled = flatFieldToField(processed, fieldUuid);
				if (!assembled.ok) {
					// The payload didn't assemble into a valid Field for its kind.
					// Carry the specific reason into the skip note (below) so the
					// SA sees WHY each field was skipped, not just that it was.
					// `raw.id` is the Zod-parsed original (always a string), so no
					// fallback is needed.
					skipped.push({ id: raw.id, reason: assembled.reason });
					continue;
				}
				const field = assembled.field;
				mintedByBareId.set(field.id, fieldUuid);
				// Top-level batch fields honor the anchor (a contiguous block at
				// the resolved index, walking forward per field); everything else
				// — fields nested under their own parentId, or any field when no
				// anchor was given — appends.
				if (
					topLevelNextIndex !== undefined &&
					parentUuid === batchInsertParent
				) {
					mutations.push({
						kind: "addField",
						parentUuid,
						field,
						index: topLevelNextIndex,
					});
					topLevelNextIndex += 1;
				} else {
					mutations.push({ kind: "addField", parentUuid, field });
				}
			}

			// Compute the post-mutation doc once and persist via the shared
			// context. The client applies via `applyMany` — no wire snapshot
			// needed; the mutations ARE the update. The `form:M-F` stage tag
			// drives lifecycle derivation on the chat client (forms phase).
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`form:${moduleIndex}-${formIndex}`,
			);

			// The human-readable summary uses the post-mutation doc's field
			// count so the SA's message reflects reality after the batch
			// lands. `countFieldsUnder` walks children transitively, so
			// containers added in this batch contribute their own count too.
			const totalCount = countFieldsUnder(newDoc, formUuid);
			const addedIds = mutations
				.filter(
					(m): m is Extract<Mutation, { kind: "addField" }> =>
						m.kind === "addField",
				)
				.map((m) => m.field.id)
				.join(", ");
			const skippedNote =
				skipped.length > 0
					? ` Skipped ${skipped.length} field(s): ${skipped
							.map((s) => `${s.id} (${s.reason})`)
							.join("; ")}.`
					: "";
			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: {
					message: `Successfully added ${mutations.length} field${mutations.length === 1 ? "" : "s"} to "${form.name}": ${addedIds}. Form now has ${totalCount} total field${totalCount === 1 ? "" : "s"}.${skippedNote}`,
					// Bulk add — no single subject; the count drives the action
					// ("Added 3 fields") and the form breadcrumb names the container.
					// `mutations.length` is the count actually added (skipped items
					// aren't in it), matching the message's own count.
					summary: {
						location: form.name,
						count: mutations.length,
					} satisfies ToolCallSummary,
				},
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
