import { z } from "zod";
import {
	type EntryPointCommitPlan,
	planEntryPointAdd,
	planEntryPointRemove,
	planEntryPointUpdate,
} from "@/lib/doc/entryPointMutations";
import { createEntryPointRequirements } from "@/lib/doc/entryPointProjection";
import {
	asUuid,
	type EntryPointTarget,
	entryPointByUuid,
	entryPointIdSchema,
	entryPointInventory,
	entryPointTargetLabel,
	entryPointTargetSchema,
	type FormEntryPoint,
	suggestEntryPointId,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import type { MutationSuccess } from "./shared/toolCallSummary";

export const getEntryPointsInputSchema = z.strictObject({});
export const addEntryPointInputSchema = z.strictObject({
	target: entryPointTargetSchema.describe(
		"The module, case list, or form destination, addressed by its owning UUIDs.",
	),
	entryPointUuid: uuidSchema
		.optional()
		.describe(
			"Stable identity to predeclare when another operation needs it; otherwise Nova mints it.",
		),
	id: entryPointIdSchema
		.optional()
		.describe(
			"Optional stable external link ID. Omit to generate it from the destination name. Later destination renames never change it.",
		),
	ignoreDisplayConditions: z
		.literal(true)
		.nullable()
		.optional()
		.describe(
			"Form destinations only: true lets this link open content hidden by display conditions. It never grants access to a Project or case. Omit or null to respect conditions.",
		),
});
export const updateEntryPointInputSchema = z.strictObject({
	entryPointUuid: uuidSchema,
	patch: z
		.strictObject({
			id: entryPointIdSchema
				.optional()
				.describe(
					"Changing this external ID can break distributed links. Keep it unless the user intends that change.",
				),
			ignoreDisplayConditions: z
				.literal(true)
				.nullable()
				.optional()
				.describe(
					"Form destinations only. True bypasses display conditions on this entry; null restores ordinary condition checks; omission keeps the setting.",
				),
		})
		.refine(
			(patch) => Object.keys(patch).length > 0,
			"Supply at least one change.",
		),
});
export const removeEntryPointInputSchema = z.strictObject({
	entryPointUuid: uuidSchema,
});

type EntryPointMutationResult =
	| (MutationSuccess & { entryPointUuid: Uuid })
	| { error: string };

async function commitEntryPoint(
	ctx: ToolInvocationContext,
	plan: EntryPointCommitPlan,
	target: EntryPointTarget,
	entryPointUuid: Uuid,
): Promise<MutatingToolResult<EntryPointMutationResult>> {
	if (!plan.ok)
		return {
			kind: "mutate",
			mutations: [],
			result: { error: plan.reason.message },
		};
	const commit = await guardedMutate(
		ctx,
		[...plan.mutations],
		`${target.kind === "form" ? "form" : "module"}:${target.kind === "form" ? target.formUuid : target.moduleUuid}`,
	);
	if (!commit.ok)
		return { kind: "mutate", mutations: [], result: { error: commit.error } };
	const name = entryPointTargetLabel(ctx.snapshot.doc, target);
	return {
		kind: "mutate",
		mutations: commit.mutations,
		result: {
			ok: true,
			entryPointUuid,
			summary: {
				subject: name,
				...(commit.mutations.length === 0 && { noop: true as const }),
			},
		},
	};
}

export const getEntryPointsTool = {
	description:
		"Read deep links, destinations and required record selections. This does not generate or verify a deployed HQ link.",
	inputSchema: getEntryPointsInputSchema,
	async execute(
		_input: z.infer<typeof getEntryPointsInputSchema>,
		ctx: ToolInvocationContext,
	) {
		const requirements = createEntryPointRequirements(ctx.snapshot.doc);
		return {
			kind: "read" as const,
			data: {
				entryPoints: entryPointInventory(ctx.snapshot.doc).map(
					({ target, entryPoint }) => ({
						...entryPoint,
						target,
						name: entryPointTargetLabel(ctx.snapshot.doc, target),
						...requirements(target),
					}),
				),
			},
		};
	},
};

export const addEntryPointTool = {
	description:
		"Create a deep link to an eligible module, Results screen or form. Search-before-selection and no-matches registration require their ordinary launch flow.",
	inputSchema: addEntryPointInputSchema,
	async execute(
		input: z.infer<typeof addEntryPointInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<EntryPointMutationResult>> {
		try {
			const uuid = input.entryPointUuid ?? asUuid(crypto.randomUUID());
			const entryPoint: FormEntryPoint = {
				uuid,
				id: input.id ?? suggestEntryPointId(ctx.snapshot.doc, input.target),
				...(input.ignoreDisplayConditions === true && {
					ignoreDisplayConditions: true,
				}),
			};
			return await commitEntryPoint(
				ctx,
				planEntryPointAdd(ctx.snapshot.doc, input.target, entryPoint),
				input.target,
				uuid,
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const updateEntryPointTool = {
	description:
		"Update a deep link. Changing its external ID breaks distributed links; destination renames preserve them.",
	inputSchema: updateEntryPointInputSchema,
	async execute(
		input: z.infer<typeof updateEntryPointInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<EntryPointMutationResult>> {
		try {
			const item = entryPointByUuid(ctx.snapshot.doc, input.entryPointUuid);
			if (item === undefined)
				return {
					kind: "mutate",
					mutations: [],
					result: { error: "This deep link is no longer available." },
				};
			return await commitEntryPoint(
				ctx,
				planEntryPointUpdate(
					ctx.snapshot.doc,
					input.entryPointUuid,
					input.patch,
				),
				item.target,
				input.entryPointUuid,
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const removeEntryPointTool = {
	description:
		"Remove a deep link by its immutable entryPointUuid. After publishing and releasing this change, links using its external ID will no longer find this destination.",
	inputSchema: removeEntryPointInputSchema,
	async execute(
		input: z.infer<typeof removeEntryPointInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<EntryPointMutationResult>> {
		try {
			const item = entryPointByUuid(ctx.snapshot.doc, input.entryPointUuid);
			if (item === undefined)
				return {
					kind: "mutate",
					mutations: [],
					result: { error: "This deep link is no longer available." },
				};
			return await commitEntryPoint(
				ctx,
				planEntryPointRemove(ctx.snapshot.doc, input.entryPointUuid),
				item.target,
				input.entryPointUuid,
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
