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
 * shared `ToolExecutionContext` interface. Five legal exit branches
 * all land on the `MutatingToolResult` shape:
 *
 *   1. Index resolution miss (module / form) → `{ error }`, no
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
import type { BlueprintDoc } from "@/lib/domain";
import { resolveFormContext } from "../blueprintHelpers";
import type { FlatField } from "../contentProcessing";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { addFieldsItemSchema } from "../toolSchemas";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import {
	assembleFieldMutations,
	describeRejectedFieldIds,
} from "./shared/fieldAssembly";
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

			// The shared assembly pipeline: sentinel strip → defaults → uuid
			// mint → domain Field → identifier verdict, with in-batch
			// container parents and the optional insertion anchor resolved
			// against this form. `raw` items are per-kind union arms (the
			// tool input is a `discriminatedUnion("kind", …)`); TS infers an
			// arm's conditionally-present keys as `unknown`, so it isn't
			// directly assignable to the wide `FlatField` the pipeline
			// operates on — but each arm IS a validated structural subset of
			// `FlatField`, so the bridge cast is sound.
			const assembly = assembleFieldMutations({
				doc,
				formUuid,
				items: fields as FlatField[],
				...(batchParentId !== undefined && { batchParentId }),
				anchor: {
					...(beforeFieldId !== undefined && { beforeFieldId }),
					...(afterFieldId !== undefined && { afterFieldId }),
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
			// drives lifecycle derivation on the chat client (forms phase).
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`form:${moduleIndex}-${formIndex}`,
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
