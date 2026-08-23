/**
 * SA tool: `moveModule` — reorder or reparent one module in the app's menu.
 *
 * Creation order is not navigation order: a build that lands modules in
 * dependency order (a child case type's viewer before the parent that
 * registers it) still owes the user a menu in the order they read the
 * workflow. This tool emits the doc reducer's `moveModule` mutation — the
 * same one the builder's menu drag dispatches — so the module keeps its
 * uuid and every reference to it survives.
 *
 * Placement is an ANCHOR, never a position: `after` names a destination
 * sibling and `null` means first. Omitting `parentModuleUuid` preserves the
 * current parent for historical and concurrent narrow reorders; present null
 * makes the module top-level, and a UUID reparents under that top-level menu.
 *
 * Exit branches:
 *
 *   1. The module or the anchor is not in the app, or the anchor is the
 *      moved module itself → `{ error }` naming the current modules.
 *   2. Commit-gate rejection (including a peer removing the anchor between
 *      this snapshot and the write, which sequence admission refuses) →
 *      `{ error }` listing the findings, nothing persisted.
 *   3. The committed doc no longer holds the module (a peer removed it
 *      mid-flight) → `{ error }` pointing at a re-read.
 *   4. Success → a human-readable `message` + a UI `summary`, both derived
 *      from the COMMITTED order rather than the requested one.
 */

import type { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
import {
	childModuleUuids,
	moduleParent,
	moduleSiblingUuids,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import {
	moduleAddressSchema,
	resolveModuleAddress,
} from "./shared/entityAddresses";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const moveModuleInputSchema = moduleAddressSchema
	.extend({
		after: uuidSchema
			.nullable()
			.describe(
				"UUID of the sibling this module should now follow, or null to make it first in its destination menu.",
			),
		parentModuleUuid: uuidSchema
			.nullable()
			.optional()
			.describe(
				"Destination parent menu UUID. Omit to reorder inside the current menu, pass null to make the module top-level, or pass a top-level module UUID to move it into that menu.",
			),
	})
	.strict();

export type MoveModuleInput = z.infer<typeof moveModuleInputSchema>;

export interface MoveModuleSuccess extends MutationSuccess {
	/** The module this one follows on the COMMITTED order, or null when it
	 *  is now first. */
	readonly after: Uuid | null;
	readonly parentModuleUuid: Uuid | null;
	readonly childModuleUuids: readonly Uuid[];
	readonly moduleOrder: readonly Uuid[];
}

export type MoveModuleResult = MoveModuleSuccess | { readonly error: string };

export const moveModuleTool = {
	description:
		"Reorder or reparent one module by stable UUID. `after` names a destination sibling or null for first. Omit parentModuleUuid to keep the current menu, pass null for top-level, or pass a top-level module UUID for a child placement.",
	inputSchema: moveModuleInputSchema,
	async execute(
		input: MoveModuleInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MoveModuleResult>> {
		const doc = ctx.snapshot.doc;
		const fail = (error: string): MutatingToolResult<MoveModuleResult> => ({
			kind: "mutate" as const,
			mutations: [],
			result: { error },
		});
		/** The app's modules in menu order, as "name" (uuid) — what an anchor
		 *  may name, stated so a refusal is actionable in one read. */
		const currentMenu = (): string =>
			doc.moduleOrder
				.map((uuid) => `"${doc.modules[uuid]?.name ?? uuid}" (${uuid})`)
				.join(", ");
		try {
			const target = resolveModuleAddress(doc, input);
			if (!target.ok) return fail(target.error);
			const moved = target.module;
			const currentParent = moduleParent(doc, target.moduleUuid);
			if (currentParent === undefined) {
				return fail(
					`The current menu placement for "${moved.name}" could not be read. Re-read the app and try again.`,
				);
			}
			const destinationParent =
				input.parentModuleUuid === undefined
					? currentParent
					: input.parentModuleUuid;

			if (destinationParent === target.moduleUuid) {
				return fail(`"${moved.name}" can't contain itself.`);
			}
			if (destinationParent !== null) {
				const parent = doc.modules[destinationParent];
				if (parent === undefined) {
					return fail(
						`No module with UUID "${destinationParent}" is in this app, so it can't be the destination menu.`,
					);
				}
				if (parent.parentModuleUuid !== undefined) {
					return fail(
						`"${parent.name}" is already inside another menu. Nova supports one submenu tier, so only a top-level module can contain "${moved.name}".`,
					);
				}
				if (childModuleUuids(doc, target.moduleUuid).length > 0) {
					return fail(
						`"${moved.name}" contains child menus, so it must stay top-level. Move or remove its children first.`,
					);
				}
			}

			if (input.after !== null) {
				if (input.after === target.moduleUuid) {
					return fail(
						`"${moved.name}" can't follow itself — "after" names the module it should land behind, not the module being moved. Pass null to make it first.`,
					);
				}
				if (doc.modules[input.after] === undefined) {
					return fail(
						`No module with UUID "${input.after}" is in this app, so "${moved.name}" has nothing to follow. The menu is currently ${currentMenu()}. Pass one of those UUIDs, or null to make "${moved.name}" first.`,
					);
				}
				if (!moduleSiblingUuids(doc, destinationParent).includes(input.after)) {
					return fail(
						`"${doc.modules[input.after]?.name ?? input.after}" is not a sibling in the destination menu. "after" must name a module with the same destination parent.`,
					);
				}
			}

			const mutations: Mutation[] = [
				{
					kind: "moveModule",
					uuid: target.moduleUuid,
					after: input.after,
					...(input.parentModuleUuid !== undefined && {
						parentModuleUuid: input.parentModuleUuid,
					}),
				},
			];
			const commit = await guardedMutate(ctx, mutations, "modules");
			if (!commit.ok) return fail(commit.error);

			// The checks above ran against THIS invocation's doc; the write lands
			// on the fresh stored doc, where a peer may have removed the module
			// (the reducer's replay-safe no-op). Report the COMMITTED order, so a
			// move that did not land is an error rather than a claim over an
			// unchanged menu.
			const committedOrder = commit.newDoc.moduleOrder;
			const at = committedOrder.indexOf(target.moduleUuid);
			if (at < 0) {
				return fail(
					`The move of "${moved.name}" didn't land: a collaborator removed the module while it was in flight. Re-read the app and re-issue against its current menu.`,
				);
			}
			const committedParent = moduleParent(commit.newDoc, target.moduleUuid);
			if (committedParent === undefined) {
				return fail(
					`The move of "${moved.name}" didn't land: its committed menu placement could not be read. Re-read the app and try again.`,
				);
			}
			const committedSiblings = moduleSiblingUuids(
				commit.newDoc,
				committedParent,
			);
			const siblingIndex = committedSiblings.indexOf(target.moduleUuid);
			const committedAfter =
				siblingIndex <= 0
					? null
					: (committedSiblings[siblingIndex - 1] ?? null);
			let placement: string;
			if (committedAfter === null) {
				placement =
					committedParent === null
						? "to the top of the menu"
						: `to the start of "${commit.newDoc.modules[committedParent]?.name ?? committedParent}"`;
			} else {
				placement = `after "${commit.newDoc.modules[committedAfter]?.name ?? committedAfter}"`;
			}
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message: `Moved module "${moved.name}" ${placement}.`,
					after: committedAfter,
					parentModuleUuid: committedParent,
					childModuleUuids: childModuleUuids(commit.newDoc, target.moduleUuid),
					moduleOrder: committedOrder,
					summary: { subject: moved.name } satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
