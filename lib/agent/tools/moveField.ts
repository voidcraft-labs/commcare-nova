/**
 * SA tool: `moveField` — reposition an existing field within its form.
 *
 * Emits the doc reducer's `moveField` mutation — the same one the
 * builder's drag-drop dispatches — so the field keeps its uuid and every
 * reference to it survives (a remove-and-re-add mints a new identity and
 * strands every expression pointing at the old one; this tool exists so
 * the SA never has to do that). Both the SA chat factory and the MCP
 * adapter call this through the shared `ToolExecutionContext` interface.
 *
 * Addressing mirrors `addFields`' anchor vocabulary, with one deliberate
 * upgrade: an anchor resolves ANYWHERE in the form and the destination
 * parent is the anchor's own parent, so "move X after Y" lands X beside
 * Y wherever Y nests — no separate parent bookkeeping. `parentId` covers
 * the anchor-less placements: a group/repeat to append into, or `null`
 * for the form's top level.
 *
 * The reducer warn-and-skips an invalid move (its total-function
 * convention for historical replay), which a tool must never present as
 * success — so every skip condition is pre-checked here and returned as
 * a real `{ error }`: cross-form targets are structurally unreachable
 * (every ref resolves within the addressed form), and a destination
 * inside the moved field's own subtree is rejected before dispatch. The
 * pre-checks see THIS run's doc while the guarded writer re-applies onto
 * the fresh stored doc, so the landing is additionally verified on the
 * committed doc — a peer edit that made the reducer skip mid-commit
 * surfaces as an error, never as a success over an unchanged form.
 *
 * Exit branches:
 *
 *   1. Form / field / anchor / parent not resolved (missing, ambiguous
 *      bare id, or a uuid living in another form) → `{ error }`.
 *   2. No placement given (no anchor, no `parentId`) → `{ error }`
 *      naming the three ways to say where.
 *   3. Anchor is the moved field itself, `parentId` contradicts the
 *      anchor's parent, `parentId` names a non-container, or the
 *      destination sits inside the moved field's own subtree →
 *      `{ error }`, no mutations.
 *   4. Commit-gate rejection (the move would introduce a validator
 *      finding) → `{ error }` listing the findings, nothing persisted.
 *   5. The committed doc shows the move didn't land (a concurrent edit
 *      displaced the field or its destination) → `{ error }` pointing
 *      at a re-read.
 *   6. Success → a human-readable `message` (noting a sibling-collision
 *      auto-rename when the reducer deduped the id) + a UI `summary`.
 */

import { z } from "zod";
import { orderKeyForFieldSlot } from "@/lib/doc/order/fieldSlot";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import { isContainer } from "@/lib/domain";
import {
	FIELD_REF_HINT,
	resolveFieldInForm,
	resolveFieldTarget,
} from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const moveFieldInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		fieldId: z.string().describe(`Field to move — ${FIELD_REF_HINT}`),
		beforeFieldId: z
			.string()
			.optional()
			.describe(
				"Place the moved field immediately before this field (id or uuid). The destination is the anchor's own parent, so the field lands beside it wherever it nests. Takes precedence over afterFieldId.",
			),
		afterFieldId: z
			.string()
			.optional()
			.describe(
				"Place the moved field immediately after this field (id or uuid).",
			),
		parentId: z
			.string()
			.nullable()
			.optional()
			.describe(
				"Group/repeat (id or uuid) to move the field into, appended at its end when no anchor is given. null moves it to the form's top level. Omit when an anchor is given — the anchor's parent wins.",
			),
	})
	.strict();

export type MoveFieldInput = z.infer<typeof moveFieldInputSchema>;

/** Human-readable success `message` + UI `summary`, or an error record.
 *  Named apart from the doc layer's `MoveFieldResult` (the reducer's
 *  dedup-rename metadata) — same mutation, unrelated shape. */
export type MoveFieldToolResult = MutationSuccess | { error: string };

export const moveFieldTool = {
	description:
		"Move an existing field within its form — same identity, every reference to it preserved (never remove-and-re-add a field to reposition it). Anchor it beside another field with beforeFieldId/afterFieldId (it lands in that field's parent), or pass parentId to append it into a group/repeat (null = the form's top level). A group/repeat moves with its children.",
	inputSchema: moveFieldInputSchema,
	async execute(
		input: MoveFieldInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<MoveFieldToolResult>> {
		const { moduleIndex, formIndex, fieldId, parentId } = input;
		const fail = (error: string): MutatingToolResult<MoveFieldToolResult> => ({
			kind: "mutate" as const,
			mutations: [],
			newDoc: doc,
			result: { error },
		});
		try {
			// One positional resolution covers the form too — the target's
			// `formUuid` scopes every later anchor/parent lookup.
			const target = resolveFieldTarget(doc, moduleIndex, formIndex, fieldId);
			if (!target.ok) return fail(target.error);
			const moved = target.field;
			const formUuid = target.formUuid;
			const formName =
				doc.forms[formUuid]?.name ?? `m${moduleIndex}-f${formIndex}`;

			// `beforeFieldId` wins when both anchors are given — the same
			// precedence `addFields` documents on its anchor pair.
			const anchorRef = input.beforeFieldId ?? input.afterFieldId;
			const anchorSide = input.beforeFieldId !== undefined ? "before" : "after";
			if (anchorRef === undefined && parentId === undefined) {
				return fail(
					`Nothing says where "${moved.id}" should go. Pass beforeFieldId or afterFieldId (a field it lands beside), parentId (a group or repeat to append it into), or parentId: null (append at the form's top level).`,
				);
			}

			let anchor: Field | undefined;
			if (anchorRef !== undefined) {
				const resolvedAnchor = resolveFieldInForm(doc, formUuid, anchorRef);
				if (!resolvedAnchor.ok) return fail(`Anchor: ${resolvedAnchor.error}`);
				if (resolvedAnchor.field.uuid === moved.uuid) {
					return fail(
						`"${moved.id}" can't anchor to itself — beforeFieldId/afterFieldId name the field it should land beside, not the field being moved.`,
					);
				}
				anchor = resolvedAnchor.field;
			}

			// Destination parent: the anchor's own parent when anchored, else
			// the named container, else the form root. An explicit `parentId`
			// alongside an anchor must AGREE with the anchor's real parent —
			// a contradiction means the SA's picture of the form is stale, so
			// name the actual parent instead of silently picking a side.
			let destParentUuid: Uuid;
			if (anchor) {
				destParentUuid = doc.fieldParent[anchor.uuid] ?? formUuid;
				if (parentId !== undefined) {
					const anchorParentField = doc.fields[destParentUuid];
					const anchorParentName = anchorParentField
						? `inside "${anchorParentField.id}"`
						: "at the form's top level";
					if (parentId === null) {
						if (anchorParentField !== undefined) {
							return fail(
								`Anchor "${anchor.id}" sits ${anchorParentName}, but parentId: null says the form's top level. Drop parentId — the anchor's parent wins — or anchor to a top-level field.`,
							);
						}
					} else {
						const resolvedParent = resolveFieldInForm(doc, formUuid, parentId);
						if (!resolvedParent.ok) {
							return fail(`Destination parent: ${resolvedParent.error}`);
						}
						if (resolvedParent.field.uuid !== destParentUuid) {
							return fail(
								`Anchor "${anchor.id}" sits ${anchorParentName}, not inside "${resolvedParent.field.id}". Drop parentId — the anchor's parent wins — or pick an anchor inside that container.`,
							);
						}
					}
				}
			} else if (parentId == null) {
				destParentUuid = formUuid;
			} else {
				const resolvedParent = resolveFieldInForm(doc, formUuid, parentId);
				if (!resolvedParent.ok) {
					return fail(`Destination parent: ${resolvedParent.error}`);
				}
				if (!isContainer(resolvedParent.field)) {
					return fail(
						`"${resolvedParent.field.id}" is a ${resolvedParent.field.kind} field, not a group or repeat — a field can only move into a container. To place "${moved.id}" beside it, anchor with beforeFieldId or afterFieldId instead.`,
					);
				}
				destParentUuid = resolvedParent.field.uuid;
			}

			// A container can't move into its own subtree — the splice would
			// detach the subtree from every walk, so the reducer refuses it
			// with a silent skip. Pre-check so the refusal is a real error
			// instead of a success report over an unchanged doc.
			let cursor: Uuid | undefined = destParentUuid;
			const seen = new Set<Uuid>();
			while (
				cursor !== undefined &&
				!seen.has(cursor) &&
				doc.forms[cursor] === undefined
			) {
				if (cursor === moved.uuid) {
					return fail(
						`"${moved.id}" can't move inside its own subtree — the destination sits under the moved ${moved.kind}. Pick a destination outside it.`,
					);
				}
				seen.add(cursor);
				cursor = doc.fieldParent[cursor] ?? undefined;
			}

			// The shared slot → order-key computation — the same one the
			// builder's drag dispatches through, so the SA's move and a drag
			// of the same gesture land the same key. The moved field is
			// excluded from the neighbor set so a same-parent reorder keys
			// between the OTHER siblings.
			const order = orderKeyForFieldSlot(
				doc,
				destParentUuid,
				anchor
					? anchorSide === "before"
						? { beforeUuid: anchor.uuid }
						: { afterUuid: anchor.uuid }
					: {},
				moved.uuid,
			);

			const mutations: Mutation[] = [
				{
					kind: "moveField",
					uuid: moved.uuid,
					toParentUuid: destParentUuid,
					order,
				},
			];
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`form:${moduleIndex}-${formIndex}`,
			);
			if (!commit.ok) return fail(commit.error);
			const newDoc = commit.newDoc;

			// The pre-checks above ran against THIS run's doc, but the
			// guarded writer re-applies the mutation onto the fresh stored
			// doc — a peer edit landing in between (the field deleted, the
			// destination folded inside the moved group) makes the reducer
			// warn-and-skip while the commit itself succeeds. Verify the move
			// actually landed on the committed doc, or the report would claim
			// a move over an unchanged form.
			const postField = newDoc.fields[moved.uuid];
			const landedInDest =
				newDoc.fieldOrder[destParentUuid]?.includes(moved.uuid) ?? false;
			if (!postField || !landedInDest || postField.order !== order) {
				return fail(
					`The move of "${moved.id}" didn't land: a collaborator's edit changed the form while it was in flight (the field or its destination was moved or removed). Re-read the form with getForm and re-issue against its current shape.`,
				);
			}

			// A cross-parent move can rename the field to keep sibling ids
			// unique at the new level (the reducer's dedup) — read the id off
			// the committed doc and report it, or the SA keeps addressing a
			// name that no longer exists.
			const finalId = postField?.id ?? moved.id;
			const renameNote =
				finalId !== moved.id
					? ` Renamed to "${finalId}" to keep sibling ids unique at its new level.`
					: "";
			const destField = doc.fields[destParentUuid];
			const placement = anchor
				? `${anchorSide} "${anchor.id}"`
				: destField
					? `to the end of "${destField.id}"`
					: "to the end of the form's top level";
			const label = postField && "label" in postField ? postField.label : "";
			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: {
					message: `Moved "${moved.id}" ${placement} in "${formName}".${renameNote}`,
					summary: {
						location: formName,
						subject: label || finalId,
					} satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
