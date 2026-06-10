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
 * shared `ToolExecutionContext` interface. Four legal exit branches
 * all land on the `MutatingToolResult` shape:
 *
 *   1. Index resolution miss (module / form) → `{ error }`, no
 *      mutations.
 *   2. Identifier guard rejection (any field id illegal / reserved /
 *      over-long / sibling-conflicting per the shared verdicts in
 *      `lib/doc/identifierVerdicts.ts`) → `{ error }` naming EVERY
 *      failing item, no mutations, nothing persisted.
 *   3. Runtime error in the pipeline → `{ error }`, no mutations.
 *   4. Success → a human-readable `message` (+ a UI `summary`); the stage
 *      tag drives lifecycle derivation on the chat client.
 */

import { z } from "zod";
import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import { fieldIdVerdict } from "@/lib/doc/identifierVerdicts";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { asUuid, isContainer } from "@/lib/domain";
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
				// Only a container can be a parent — a `parentId` naming a leaf
				// field falls through to form-level (matching the per-field path
				// below). Nesting under a leaf would make every batch field
				// invisible to the emitter.
				if (existing && isContainer(existing.field)) {
					batchInsertParent = existing.field.uuid;
				}
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
			// refers to a CONTAINER added earlier in this same batch, we find
			// it in `mintedByBareId` (which records only containers) before
			// falling back to the doc-wide lookup.
			const mintedByBareId = new Map<string, Uuid>();
			const mutations: Mutation[] = [];
			const skipped: Array<{ id: string; reason: string }> = [];
			// Identifier-guard state. Every assembled field's id runs through
			// the shared verdict (`lib/doc/identifierVerdicts.ts`) BEFORE any
			// mutation persists; a single bad id fails the whole call, and the
			// error lists EVERY failing item so the SA fixes them in one
			// re-issue. `pendingByParent` carries the ids earlier batch items
			// claimed per parent (they aren't in `doc` yet), so two new
			// siblings can't land with the same id.
			const rejected: Array<{ id: string; reason: string }> = [];
			const pendingByParent = new Map<Uuid, Set<string>>();

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
						if (existing && isContainer(existing.field)) {
							parentUuid = existing.field.uuid;
						}
						// A non-existent parentId, or one naming a non-container
						// (a leaf field), falls through to form-level insert.
						// Never nest under a leaf: the reducer would create a
						// child order under it and the emitter — which only
						// recurses into containers — would silently drop the
						// field.
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

				// Pre-dispatch identifier guard: XML-name legality, the
				// reserved `__nova_` prefix, the case-property length cap, and
				// sibling-id uniqueness against the doc AND this batch's
				// earlier items. A rejected field claims nothing — it never
				// joins the pending scope or the minted-parent lookup.
				const pending = pendingByParent.get(parentUuid);
				const verdict = fieldIdVerdict({
					doc,
					parentUuid,
					proposedId: field.id,
					pendingSiblingIds: pending,
				});
				if (!verdict.ok) {
					rejected.push({ id: field.id, reason: verdict.message });
					continue;
				}
				if (pending) pending.add(field.id);
				else pendingByParent.set(parentUuid, new Set([field.id]));

				// Only containers can parent a later field in this batch;
				// recording only them keeps the minted-parent lookup from
				// resolving to a leaf.
				if (isContainer(field)) mintedByBareId.set(field.id, fieldUuid);
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

			// Any identifier rejection fails the WHOLE call before anything
			// persists — partial batches would leave the SA guessing which
			// fields landed. The error names every failing item so one
			// corrected re-issue suffices.
			if (rejected.length > 0) {
				const lines = rejected
					.map((r) => `- "${r.id}": ${r.reason}`)
					.join("\n");
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `No fields were added to "${form.name}" — ${rejected.length} of ${fields.length} field id(s) can't be used:\n${lines}\nFix the listed id(s) and re-issue the call.`,
					},
				};
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
