/**
 * SA tool: `moveModule` — reorder one module in the app's menu.
 *
 * Creation order is not navigation order: a build that lands modules in
 * dependency order (a child case type's viewer before the parent that
 * registers it) still owes the user a menu in the order they read the
 * workflow. This tool emits the doc reducer's `moveModule` mutation — the
 * same one the builder's menu drag dispatches — so the module keeps its
 * uuid and every reference to it survives.
 *
 * Placement is an ANCHOR, never a position: `after` names the module this
 * one now follows, and `null` means first. A position is computed against
 * the sequence its author could see, so two people moving from one document
 * compute the same one; an anchor cannot be shifted by a peer's insert.
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
import { type Uuid, uuidSchema } from "@/lib/domain";
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
				"UUID of the module this one should now follow, or null to make it first in the menu.",
			),
	})
	.strict();

export type MoveModuleInput = z.infer<typeof moveModuleInputSchema>;

export interface MoveModuleSuccess extends MutationSuccess {
	/** The module this one follows on the COMMITTED order, or null when it
	 *  is now first. */
	readonly after: Uuid | null;
	readonly moduleOrder: readonly Uuid[];
}

export type MoveModuleResult = MoveModuleSuccess | { readonly error: string };

export const moveModuleTool = {
	description:
		"Move one module to a new place in the app's menu by stable UUID — same identity, every reference preserved. `after` names the module it should follow; null makes it first.",
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
			}

			const mutations: Mutation[] = [
				{ kind: "moveModule", uuid: target.moduleUuid, after: input.after },
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
			const committedAfter = at === 0 ? null : (committedOrder[at - 1] ?? null);
			const placement =
				committedAfter === null
					? "to the top of the menu"
					: `after "${commit.newDoc.modules[committedAfter]?.name ?? committedAfter}"`;
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message: `Moved module "${moved.name}" ${placement}.`,
					after: committedAfter,
					moduleOrder: committedOrder,
					summary: { subject: moved.name } satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
