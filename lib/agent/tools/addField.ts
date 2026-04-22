/**
 * SA tool: `addField` — insert a single new field into an existing form.
 *
 * Finer-grained sibling of `addFields`: accepts one field payload with
 * optional `beforeFieldId` / `afterFieldId` / `parentId` anchors so the
 * SA can target a specific insertion slot. Both the SA chat factory and
 * the MCP adapter call this through the shared `ToolExecutionContext`
 * interface.
 *
 * Three exit branches all land on the `MutatingToolResult` shape:
 *
 *   1. Form index out of range → `{ error }`, no mutations.
 *   2. The payload fails `flatFieldToField` assembly (missing required
 *      property for the declared kind) → `{ error }`, no mutations.
 *   3. Success → a human-readable summary string tagged `form:M-F`.
 *
 * `parentId` resolution is best-effort: an id that doesn't exist or
 * names a non-container falls through to form-level insertion rather
 * than erroring — mirrors the lenient contract of the bulk `addFields`
 * tool so the SA's mental model stays consistent across both surfaces.
 */

import { z } from "zod";
import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { asUuid, isContainer } from "@/lib/domain";
import {
	addFieldMutations,
	findFieldByBareId,
	resolveFormUuid,
} from "../blueprintHelpers";
import { flatFieldToField } from "../contentProcessing";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { addFieldSchema } from "../toolSchemas";
import { applyToDoc, type MutatingToolResult } from "./common";

export const addFieldInputSchema = z.object({
	moduleIndex: z.number().describe("0-based module index"),
	formIndex: z.number().describe("0-based form index"),
	field: addFieldSchema,
	afterFieldId: z
		.string()
		.optional()
		.describe("Insert after this field ID. Omit to append at end."),
	beforeFieldId: z
		.string()
		.optional()
		.describe(
			"Insert before this field ID. Takes precedence over afterFieldId.",
		),
	parentId: z
		.string()
		.optional()
		.describe("ID of a group/repeat to nest inside"),
});

export type AddFieldInput = z.infer<typeof addFieldInputSchema>;

/**
 * Either a human-readable success string (the SA reads it back to the
 * user without re-querying the doc) or an error record naming the
 * specific failure. Matches the LLM-facing return the SA wrapper has
 * always exposed — byte-identical call sites across the two surfaces.
 */
export type AddFieldResult = string | { error: string };

export const addFieldTool = {
	name: "addField" as const,
	description:
		"Add a new field to an existing form. Use beforeFieldId or afterFieldId to control position; omit both to append at end.",
	inputSchema: addFieldInputSchema,
	async execute(
		input: AddFieldInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddFieldResult>> {
		const {
			moduleIndex,
			formIndex,
			field: fieldInput,
			afterFieldId,
			beforeFieldId,
			parentId,
		} = input;
		try {
			const formUuid = resolveFormUuid(doc, moduleIndex, formIndex);
			if (!formUuid) {
				return {
					mutations: [],
					newDoc: doc,
					result: { error: `Form m${moduleIndex}-f${formIndex} not found` },
				};
			}

			// Resolve parent uuid: the form itself by default, or an existing
			// container field when `parentId` names one. A non-existent or
			// non-container `parentId` falls through to form-level insert —
			// keeps the contract identical to `addFields`.
			let parentUuid: Uuid = formUuid;
			if (parentId) {
				const resolvedParent = findFieldByBareId(doc, formUuid, parentId);
				if (resolvedParent?.field && isContainer(resolvedParent.field)) {
					parentUuid = resolvedParent.field.uuid;
				}
			}

			// Resolve the insertion index. `addFieldMutations` takes a numeric
			// slot; derive it from the anchor field's position in the parent's
			// current child order. `beforeFieldId` wins over `afterFieldId`
			// when both are present — matches the tool schema's description.
			const order = doc.fieldOrder[parentUuid] ?? [];
			let insertIndex = order.length; // default: append
			if (beforeFieldId) {
				const target = order.findIndex(
					(u) => doc.fields[u]?.id === beforeFieldId,
				);
				if (target !== -1) insertIndex = target;
			} else if (afterFieldId) {
				const target = order.findIndex(
					(u) => doc.fields[u]?.id === afterFieldId,
				);
				if (target !== -1) insertIndex = target + 1;
			}

			// Mint a uuid and assemble the domain `Field` shape. The flat SA
			// input carries sentinel-padded optionals; `flatFieldToField`
			// strips them and parses against the kind's schema — a failure
			// here means the declared kind requires a key the payload didn't
			// carry (e.g. `options` on a select kind, or a non-empty label on
			// a visible kind).
			const uuid = asUuid(crypto.randomUUID());
			const field = flatFieldToField(fieldInput, uuid);
			if (!field) {
				return {
					mutations: [],
					newDoc: doc,
					result: {
						error: `Field "${fieldInput.id}" (kind=${fieldInput.kind}) failed schema validation — likely a missing required property for the kind (e.g. options on a select, or a non-empty label on a visible kind).`,
					},
				};
			}
			const mutations = addFieldMutations(doc, {
				parentUuid,
				field,
				index: insertIndex,
			});
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`form:${moduleIndex}-${formIndex}`,
			);

			// Count against the post-mutation doc so the summary reflects the
			// true field count after this insert lands.
			const formName = newDoc.forms[formUuid]?.name ?? "";
			const totalCount = countFieldsUnder(newDoc, formUuid);
			const posDesc = beforeFieldId
				? `before "${beforeFieldId}"`
				: afterFieldId
					? `after "${afterFieldId}"`
					: "at end";
			const parentDesc = parentId ? ` inside group "${parentId}"` : "";
			return {
				mutations,
				newDoc,
				result: `Successfully added field "${fieldInput.id}" (${fieldInput.label ?? ""}) to "${formName}" ${posDesc}${parentDesc}. Form now has ${totalCount} field${totalCount === 1 ? "" : "s"}.`,
			};
		} catch (err) {
			return {
				mutations: [],
				newDoc: doc,
				result: { error: err instanceof Error ? err.message : String(err) },
			};
		}
	},
};
