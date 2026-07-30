/**
 * SA tool: `addFields` — bulk-add fields to an existing form.
 *
 * The SA emits a list of fields, each a per-kind union arm (the kind picks
 * which properties exist — see `toolSchemaGenerator.ts`). This tool runs
 * each through the three-step pipeline in `contentProcessing.ts` —
 * `stripEmpty` → `applyDefaults` → `flatFieldToField` — mints uuids,
 * resolves construction-local parent handles (including parents added earlier in the
 * same batch), and emits one mutation batch tagged `form:M-F`.
 *
 * Appends to existing fields by default (the SA relies on that contract
 * when it splits a large add across multiple calls); an optional
 * `beforeFieldUuid` / `afterFieldUuid` anchor instead inserts the batch's
 * top-level fields as a contiguous block at that position (fields nested
 * under their own `parentId` are unaffected). This is the only field-add
 * tool — one field is just a length-1 `fields` array.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Five legal exit branches
 * all land on the `MutatingToolResult` shape:
 *
 *   1. UUID address miss (module / form) → `{ error }`, no
 *      mutations.
 *   2. Identifier guard rejection (any field id illegal / reserved /
 *      over-long / sibling-conflicting per the shared verdicts in
 *      `lib/doc/identifierVerdicts.ts`) → `{ error }` naming EVERY
 *      failing item, no mutations, nothing persisted.
 *   3. Commit-gate rejection (`guardedMutate` — the batch would
 *      introduce a validator finding) → `{ error }` listing each
 *      finding, nothing persisted.
 *   4. Runtime error in the pipeline → `{ error }`, no mutations.
 *   5. Success → a human-readable `message` (+ a UI `summary`); the stage
 *      tag drives lifecycle derivation on the chat client.
 */

import { z } from "zod";
import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc, uuidSchema } from "@/lib/domain";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { addFieldsItemSchema } from "../toolSchemas";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import {
	formAddressSchema,
	resolveFormAddress,
} from "./shared/entityAddresses";
import {
	assembleFieldMutations,
	describeRejectedFieldIds,
} from "./shared/fieldAssembly";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const addFieldsInputSchema = formAddressSchema
	.extend({
		fields: z.array(addFieldsItemSchema),
		parentUuid: uuidSchema
			.optional()
			.describe(
				"Stable uuid of an existing group/repeat to receive the batch. A field item's parentId is only a construction-local handle for a container created earlier in this same call.",
			),
		// Optional insertion anchor for the batch's top-level block. The
		// fields that land in the batch's insertion parent (the form root, or
		// the batch `parentUuid`) are inserted as a contiguous block at the
		// anchor; fields carrying their own `parentId` nest under it and are
		// unaffected. Omit both to append at the end (the common case during
		// a build).
		afterFieldUuid: uuidSchema
			.optional()
			.describe(
				"Insert the batch's top-level fields after this existing sibling uuid. Omit to append at the end.",
			),
		beforeFieldUuid: uuidSchema
			.optional()
			.describe(
				"Insert the batch's top-level fields before this existing sibling uuid. Takes precedence over afterFieldUuid.",
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
		"Add fields to an existing form by UUID (a single field is a length-1 array). Appends by default; beforeFieldUuid/afterFieldUuid position the batch. parentUuid names an existing container; an item parentId may only name a container created earlier in this same call.",
	inputSchema: addFieldsInputSchema,
	async execute(
		input: AddFieldsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddFieldsResult>> {
		const {
			moduleUuid,
			formUuid,
			fields,
			parentUuid,
			afterFieldUuid,
			beforeFieldUuid,
		} = input;
		try {
			const resolved = resolveFormAddress(doc, { moduleUuid, formUuid });
			if (!resolved.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: resolved.error,
					},
				};
			}
			const { form } = resolved;

			// The shared assembly pipeline: sentinel strip → defaults → uuid
			// mint → domain Field → identifier verdict, with in-batch
			// container parents and the optional insertion anchor resolved
			// against this form. The tool item's inferred type IS `FlatField`
			// (one flat kind-gated shape), so items flow in with no bridge.
			const assembly = assembleFieldMutations({
				doc,
				formUuid,
				items: fields,
				...(parentUuid !== undefined && {
					batchParentUuid: asUuid(parentUuid),
				}),
				anchor: {
					...(beforeFieldUuid !== undefined && {
						beforeFieldUuid: asUuid(beforeFieldUuid),
					}),
					...(afterFieldUuid !== undefined && {
						afterFieldUuid: asUuid(afterFieldUuid),
					}),
				},
			});

			// Any identifier rejection fails the WHOLE call before anything
			// persists — partial batches would leave the SA guessing which
			// fields landed. The error names every failing item so one
			// corrected re-issue suffices.
			if (!assembly.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: describeRejectedFieldIds(
							form.name,
							fields.length,
							assembly.rejected,
						),
					},
				};
			}
			const { mutations, skipped } = assembly;

			// Compute the post-mutation doc once and persist via the shared
			// context. The client applies via `applyMany` — no wire snapshot
			// needed; the mutations ARE the update. The `form:M-F` stage tag
			// establishes the cumulative Build milestone on the chat client.
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`form:${formUuid}`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: commit.error },
				};
			}
			const newDoc = commit.newDoc;

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
			return toToolErrorResult(err, doc);
		}
	},
};
