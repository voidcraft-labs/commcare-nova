/**
 * SA tool: `addFields` — bulk-add fields to an existing form.
 *
 * The SA emits a list of fields, each a per-kind union arm (the kind picks
 * which properties exist — see `toolSchemaGenerator.ts`). This tool runs
 * each through the three-step pipeline in `contentProcessing.ts` —
 * `stripEmpty` → `applyDefaults` → `flatFieldToField` — mints uuids,
 * resolves stable parent UUIDs (including parents predeclared earlier in the
 * same batch), and emits one mutation batch tagged `form:M-F`.
 *
 * Appends to existing fields by default (the SA relies on that contract
 * when it splits a large add across multiple calls); an optional
 * `beforeFieldUuid` / `afterFieldUuid` anchor instead inserts the batch's
 * top-level fields as a contiguous block at that position (fields nested
 * under their own `parentUuid` are unaffected). This is the only field-add
 * tool — one field is just a length-1 `fields` array.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolInvocationContext` interface. Five legal exit branches
 * all land on the `MutatingToolResult` shape:
 *
 *   1. UUID address miss or parent-membership mismatch → `{ error }`, no
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
import {
	FIELD_PLACEMENT_MESSAGES,
	formIsSectioned,
	landingSectionOf,
} from "@/lib/doc/formSectionVerdicts";
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	type Field,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import { addFieldsItemSchema } from "../toolSchemas";
import type { ToolInvocationContext } from "../workspace/types";
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
	type CreatedFieldIdentity,
	describeRejectedFields,
} from "./shared/fieldAssembly";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const addFieldsInputSchema = formAddressSchema
	.extend({
		fields: z.array(addFieldsItemSchema),
		// Default parent for the whole batch. A field's own `parentUuid`
		// overrides this.
		parentUuid: uuidSchema
			.optional()
			.describe(
				"Stable UUID of an existing group/repeat to receive the batch. A field item's own parentUuid overrides this.",
			),
		// Optional insertion anchor for the batch's top-level block. The
		// fields that land in the batch's insertion parent (the form root, or
		// the batch `parentUuid`) are inserted as a contiguous block at the
		// anchor; fields carrying their own `parentUuid` nest under it and are
		// unaffected. Omit both to append at the end (the common case during
		// a build).
		afterFieldUuid: uuidSchema
			.optional()
			.describe(
				"Insert the batch's top-level fields after this existing sibling UUID. Omit to append at the end.",
			),
		beforeFieldUuid: uuidSchema
			.optional()
			.describe(
				"Insert the batch's top-level fields before this existing sibling UUID. Takes precedence over afterFieldUuid.",
			),
	})
	.strict();

export type AddFieldsInput = z.infer<typeof addFieldsInputSchema>;

/**
 * Success carries a verbose human-readable `message` the SA reads back
 * without re-querying the doc — field count delta, added ids, and any
 * complete created identities — plus a UI-only `summary` for the chat
 * transcript; failure is an error record.
 */
export type AddFieldsResult =
	| (MutationSuccess & { fields: CreatedFieldIdentity[] })
	| { error: string };

export const addFieldsTool = {
	description:
		"Add fields to an existing form (a single field is a length-1 array). Appends by default; beforeFieldUuid/afterFieldUuid position the batch. parentUuid names containers (a group, repeat, or section) by stable identity. On a form split into sections, every top-level field is a section, so a question lands inside one.",
	inputSchema: addFieldsInputSchema,
	async execute(
		input: AddFieldsInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<AddFieldsResult>> {
		const {
			moduleUuid,
			formUuid,
			fields,
			parentUuid,
			afterFieldUuid,
			beforeFieldUuid,
		} = input;
		const doc = ctx.snapshot.doc;
		try {
			const resolved = resolveFormAddress(doc, { moduleUuid, formUuid });
			if (!resolved.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
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

			// Any field-assembly or identifier rejection fails the WHOLE call
			// before anything
			// persists — partial batches would leave the SA guessing which
			// fields landed. The error names every failing item so one
			// corrected re-issue suffices.
			if (!assembly.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: describeRejectedFields(
							form.name,
							fields.length,
							assembly.rejected,
						),
					},
				};
			}
			const { mutations, created } = assembly;

			// Sections make a form a closed state; say why a landing is refused
			// in one sentence before the gate's finding list would.
			const placement = sectionPlacementRefusal(doc, formUuid, mutations);
			if (placement !== undefined) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: placement },
				};
			}

			// Compute the post-mutation doc once and persist via the shared
			// context. The client applies via `applyMany` — no wire snapshot
			// needed; the mutations ARE the update. The `form:M-F` stage tag
			// establishes the cumulative Build milestone on the chat client.
			const commit = await guardedMutate(ctx, mutations, `form:${formUuid}`);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
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
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message: `Successfully added ${created.length} field${created.length === 1 ? "" : "s"} to "${form.name}": ${addedIds}. Form now has ${totalCount} total field${totalCount === 1 ? "" : "s"}.`,
					fields: created,
					// Bulk add — no single subject; the count drives the action
					// ("Added 3 fields") and the form breadcrumb names the container.
					// The successful assembly contains every requested field.
					summary: {
						location: form.name,
						count: created.length,
					} satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};

/**
 * The section placement pre-check over an assembled batch. The verdict
 * (`fieldPlacementVerdict`) reads the document, and a batch may create the
 * very sections and groups its later items land in, so the walk here
 * resolves each item's landing through the batch's own parents first: a
 * section landing under any field (in the batch or the doc) is refused; a
 * question landing at the root of a form that is, or this batch makes,
 * sectioned is refused; an add-entries repeat landing on a page — directly
 * or through batch-created groups — is refused. The commit gate remains the
 * authority; this is the sentence the model reads instead of a finding list.
 */
function sectionPlacementRefusal(
	doc: BlueprintDoc,
	formUuid: Uuid,
	mutations: readonly Mutation[],
): string | undefined {
	const adds = mutations.filter(
		(m): m is Extract<Mutation, { kind: "addField" }> => m.kind === "addField",
	);
	const batchParent = new Map<Uuid, Uuid>();
	const batchKind = new Map<Uuid, Field["kind"]>();
	for (const m of adds) {
		batchParent.set(m.field.uuid, m.parentUuid);
		batchKind.set(m.field.uuid, m.field.kind);
	}
	const alreadySectioned = formIsSectioned(doc, formUuid);
	const addsRootSection = adds.some(
		(m) => m.field.kind === "section" && m.parentUuid === formUuid,
	);
	if (
		addsRootSection &&
		!alreadySectioned &&
		(doc.fieldOrder[formUuid]?.length ?? 0) > 0
	) {
		const form = doc.forms[formUuid];
		return `"${form?.name ?? "This form"}" isn't split into sections yet, so adding one here would leave its current questions outside it. Use setFormSections to split the form instead: it takes every top-level question's page in one call.`;
	}
	const rootHasSections = alreadySectioned || addsRootSection;
	for (const m of adds) {
		const field = m.field;
		if (field.kind === "section") {
			if (m.parentUuid !== formUuid) {
				return FIELD_PLACEMENT_MESSAGES["section-not-root"];
			}
			continue;
		}
		if (m.parentUuid === formUuid) {
			if (rootHasSections) {
				return FIELD_PLACEMENT_MESSAGES["loose-field-in-sectioned-form"];
			}
			continue;
		}
		const isUserRepeat =
			field.kind === "repeat" && field.repeat_mode === "user_controlled";
		if (!isUserRepeat) continue;
		// Walk batch-created ancestors to a parent the document knows.
		let cursor: Uuid = m.parentUuid;
		let onPage = false;
		const seen = new Set<Uuid>();
		while (batchParent.has(cursor) && !seen.has(cursor)) {
			seen.add(cursor);
			if (batchKind.get(cursor) === "section") onPage = true;
			cursor = batchParent.get(cursor) as Uuid;
		}
		if (onPage || landingSectionOf(doc, cursor) !== undefined) {
			return FIELD_PLACEMENT_MESSAGES["user-repeat-in-section"];
		}
	}
	return undefined;
}
