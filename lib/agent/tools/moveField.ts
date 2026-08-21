/**
 * SA tool: `moveField` — reposition an existing field within its form.
 *
 * Emits the doc reducer's `moveField` mutation — the same one the
 * builder's drag-drop dispatches — so the field keeps its uuid and every
 * reference to it survives (a remove-and-re-add mints a new identity and
 * strands every expression pointing at the old one; this tool exists so
 * the SA never has to do that). Both the SA chat factory and the MCP
 * adapter call this through the shared `ToolInvocationContext` interface.
 *
 * Addressing mirrors `addFields`' anchor vocabulary, with one deliberate
 * upgrade: an anchor resolves ANYWHERE in the form and the destination
 * parent is the anchor's own parent, so "move X after Y" lands X beside
 * Y wherever Y nests — no separate parent bookkeeping. `parentUuid` covers
 * the anchor-less placements: a group, repeat, or section to append into,
 * or `null` for the form's top level.
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
 *   2. No placement given (no anchor, no `parentUuid`) → `{ error }`
 *      naming the three ways to say where.
 *   3. Anchor is the moved field itself, `parentUuid` contradicts the
 *      anchor's parent, `parentUuid` names a non-container, or the
 *      destination sits inside the moved field's own subtree →
 *      `{ error }`, no mutations.
 *   4. Commit-gate rejection (the move would introduce a validator
 *      finding) → `{ error }` listing the findings, nothing persisted.
 *   5. The committed doc shows the move didn't land (a concurrent edit
 *      displaced the field or its destination) → `{ error }` pointing
 *      at a re-read.
 *   6. Success → a human-readable `message` + a UI `summary`.
 */

import type { z } from "zod";
import { fieldSlotAfter } from "@/lib/doc/fieldSlot";
import { fieldPlacementVerdict } from "@/lib/doc/formSectionVerdicts";
import type { Mutation } from "@/lib/doc/types";
import type { Field, Uuid } from "@/lib/domain";
import { isContainer, uuidSchema } from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import {
	fieldAddressSchema,
	resolveFieldAddress,
} from "./shared/entityAddresses";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const moveFieldInputSchema = fieldAddressSchema
	.extend({
		beforeFieldUuid: uuidSchema
			.optional()
			.describe(
				"Place the moved field immediately before this field UUID. The destination is the anchor's own parent. Takes precedence over afterFieldUuid.",
			),
		afterFieldUuid: uuidSchema
			.optional()
			.describe("Place the moved field immediately after this field UUID."),
		parentUuid: uuidSchema
			.nullable()
			.optional()
			.describe(
				"UUID of the group, repeat, or section to move the field into, appended at its end when no anchor is given. null moves it to the form root. Omit when an anchor is given.",
			),
	})
	.strict();

export type MoveFieldInput = z.infer<typeof moveFieldInputSchema>;

/** Human-readable success `message` + UI `summary`, or an error record. */
export type MoveFieldToolResult = MutationSuccess | { error: string };

export const moveFieldTool = {
	description:
		"Move an existing field within its form by stable UUID — same identity, every reference preserved. Anchor with beforeFieldUuid/afterFieldUuid, or pass parentUuid to append into a group, repeat, or section (null = form root). On a form split into sections a question lands inside a section, never at the root.",
	inputSchema: moveFieldInputSchema,
	async execute(
		input: MoveFieldInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MoveFieldToolResult>> {
		const { moduleUuid, formUuid, parentUuid } = input;
		const doc = ctx.snapshot.doc;
		const fail = (error: string): MutatingToolResult<MoveFieldToolResult> => ({
			kind: "mutate" as const,
			mutations: [],
			result: { error },
		});
		try {
			// One positional resolution covers the form too — the target's
			// `formUuid` scopes every later anchor/parent lookup.
			const target = resolveFieldAddress(doc, input);
			if (!target.ok) return fail(target.error);
			const moved = target.field;
			const formName = target.form.name;
			const resolveOther = (fieldUuid: string) =>
				resolveFieldAddress(doc, { moduleUuid, formUuid, fieldUuid });

			// `beforeFieldUuid` wins when both anchors are given — the same
			// precedence `addFields` documents on its anchor pair.
			const anchorRef = input.beforeFieldUuid ?? input.afterFieldUuid;
			const anchorSide =
				input.beforeFieldUuid !== undefined ? "before" : "after";
			if (anchorRef === undefined && parentUuid === undefined) {
				return fail(
					`Nothing says where "${moved.id}" should go. Pass beforeFieldUuid or afterFieldUuid, parentUuid for a group, repeat, or section, or parentUuid: null for the form root.`,
				);
			}

			let anchor: Field | undefined;
			if (anchorRef !== undefined) {
				const resolvedAnchor = resolveOther(anchorRef);
				if (!resolvedAnchor.ok) return fail(`Anchor: ${resolvedAnchor.error}`);
				if (resolvedAnchor.field.uuid === moved.uuid) {
					return fail(
						`"${moved.id}" can't anchor to itself — beforeFieldUuid/afterFieldUuid name the field it should land beside, not the field being moved.`,
					);
				}
				anchor = resolvedAnchor.field;
			}

			// Destination parent: the anchor's own parent when anchored, else
			// the named container, else the form root. An explicit `parentUuid`
			// alongside an anchor must AGREE with the anchor's real parent —
			// a contradiction means the SA's picture of the form is stale, so
			// name the actual parent instead of silently picking a side.
			let destParentUuid: Uuid;
			if (anchor) {
				destParentUuid = doc.fieldParent[anchor.uuid] ?? formUuid;
				if (parentUuid !== undefined) {
					const anchorParentField = doc.fields[destParentUuid];
					const anchorParentName = anchorParentField
						? `inside "${anchorParentField.id}"`
						: "at the form's top level";
					if (parentUuid === null) {
						if (anchorParentField !== undefined) {
							return fail(
								`Anchor "${anchor.id}" sits ${anchorParentName}, but parentUuid: null says the form root. Drop parentUuid or anchor to a top-level field.`,
							);
						}
					} else {
						const resolvedParent = resolveOther(parentUuid);
						if (!resolvedParent.ok) {
							return fail(`Destination parent: ${resolvedParent.error}`);
						}
						if (resolvedParent.field.uuid !== destParentUuid) {
							return fail(
								`Anchor "${anchor.id}" sits ${anchorParentName}, not inside "${resolvedParent.field.id}". Drop parentUuid or pick an anchor inside that container.`,
							);
						}
					}
				}
			} else if (parentUuid == null) {
				destParentUuid = formUuid;
			} else {
				const resolvedParent = resolveOther(parentUuid);
				if (!resolvedParent.ok) {
					return fail(`Destination parent: ${resolvedParent.error}`);
				}
				if (!isContainer(resolvedParent.field)) {
					return fail(
						`"${resolvedParent.field.id}" is a ${resolvedParent.field.kind} field, not a group, repeat, or section — a field can only move into a container. To place "${moved.id}" beside it, anchor with beforeFieldUuid or afterFieldUuid instead.`,
					);
				}
				destParentUuid = resolvedParent.field.uuid;
			}

			// Sections make a form a closed state: a question never lands loose
			// at a sectioned root, a section never nests, and an add-entries
			// repeat never lands on a page. One sentence, before the gate.
			const sectionPlacement = fieldPlacementVerdict(doc, {
				uuid: moved.uuid,
				kind: moved.kind,
				toParentUuid: destParentUuid,
			});
			if (!sectionPlacement.ok) return fail(sectionPlacement.message);

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

			const collision = (doc.fieldOrder[destParentUuid] ?? [])
				.filter((uuid) => uuid !== moved.uuid)
				.map((uuid) => doc.fields[uuid])
				.find((sibling) => sibling?.id === moved.id);
			if (collision !== undefined) {
				return fail(
					`"${moved.id}" can't move there because that level already has a field with the same ID. Rename this field explicitly, then move it again.`,
				);
			}

			// The shared slot → predecessor computation is the same one the
			// builder's drag dispatches through, so the SA's move and a drag of
			// the same gesture land in the same array position. The moved field
			// is excluded from the neighbor set so a same-parent reorder anchors
			// among the other siblings.
			const after = fieldSlotAfter(
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
					after,
				},
			];
			const commit = await guardedMutate(ctx, mutations, `form:${formUuid}`);
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
			if (!postField || !landedInDest) {
				return fail(
					`The move of "${moved.id}" didn't land: a collaborator's edit changed the form while it was in flight (the field or its destination was moved or removed). Re-read the form with getForm and re-issue against its current shape.`,
				);
			}
			// The field IS in the destination, so the move landed. It can still have
			// landed somewhere other than asked: `spliceAfter` appends when the
			// anchor is gone, which is exactly what a peer removing the anchor
			// mid-flight produces. That is a different outcome from a failure —
			// the edit is committed, and calling it a failure would send the SA to
			// re-issue a move it already made.
			const landedAfter = (() => {
				const seq = newDoc.fieldOrder[destParentUuid] ?? [];
				const at = seq.indexOf(moved.uuid);
				return at <= 0 ? null : seq[at - 1];
			})();
			const displacedNote =
				landedAfter === after
					? ""
					: ` A collaborator removed the field it was meant to follow while this was in flight, so it went to the end instead — move it again if it belongs elsewhere.`;

			const destField = doc.fields[destParentUuid];
			const placement = anchor
				? `${anchorSide} "${anchor.id}"`
				: destField
					? `to the end of "${destField.id}"`
					: "to the end of the form's top level";
			const label =
				postField && "label" in postField && postField.label
					? projectProseTemplate(postField.label, newDoc).text
					: "";
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message: `Moved "${moved.id}" ${placement} in "${formName}".${displacedNote}`,
					summary: {
						location: formName,
						subject: label || moved.id,
					} satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
