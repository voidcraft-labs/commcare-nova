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
 * Appends to existing fields; does not replace. The SA relies on that
 * contract when it splits a large add across multiple calls.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Three legal exit branches
 * all land on the `MutatingToolResult` shape:
 *
 *   1. Index resolution miss (module / form) → `{ error }`, no
 *      mutations.
 *   2. Runtime error in the pipeline → `{ error }`, no mutations.
 *   3. Success → a human-readable summary string; the stage tag drives
 *      lifecycle derivation on the chat client.
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

export const addFieldsInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		fields: z.array(addFieldsItemSchema),
	})
	.strict();

export type AddFieldsInput = z.infer<typeof addFieldsInputSchema>;

/**
 * Either a success string or an error record. The success shape is a
 * verbose human-readable summary the SA can read back to the user
 * without re-querying the doc — field count delta, added ids, and any
 * skipped-during-assembly entries with their ids.
 */
export type AddFieldsResult = string | { error: string };

export const addFieldsTool = {
	description:
		"Add a batch of fields to an existing form. Appends to existing fields (does not replace). Groups added in one batch can be referenced as parentId in later batches.",
	inputSchema: addFieldsInputSchema,
	async execute(
		input: AddFieldsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddFieldsResult>> {
		const { moduleIndex, formIndex, fields } = input;
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

				// Resolve parentUuid: empty/undefined → form; otherwise find
				// the uuid of a newly-added parent or an existing field.
				let parentUuid: Uuid = formUuid;
				const parentId = processed.parentId;
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
				mutations.push({ kind: "addField", parentUuid, field });
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
				result: `Successfully added ${mutations.length} field${mutations.length === 1 ? "" : "s"} to "${form.name}": ${addedIds}. Form now has ${totalCount} total field${totalCount === 1 ? "" : "s"}.${skippedNote}`,
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
