/** Shared SA/MCP authoring for organization shape and app-scoped places. */

import { z } from "zod";
import {
	addLocationPropertyMutations,
	addOrganizationLevelMutations,
	removeLocationPropertyMutations,
	removeOrganizationLevelPlan,
} from "@/lib/doc/organizationMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	levelAddressBookSchema,
	levelCaseFlowSchema,
	locationPropertiesOf,
	locationPropertySchema,
	orderedLocationProperties,
	orderedOrganizationLevels,
	organizationLevelSchema,
	organizationLevelsOf,
	ownRecordValue,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import {
	createLocationInputSchema,
	organizationRevisionSchema,
	updateLocationInputSchema,
} from "@/lib/organization/schema";
import {
	createLocation,
	describeArchiveImpact,
	moveLocation,
	readOrganization,
	setLocationArchived,
	updateLocation,
} from "@/lib/organization/service";
import type { OrganizationScope } from "@/lib/organization/types";
import type { ToolExecutionContext } from "../toolExecutionContext";
import {
	applyToDoc,
	guardedMutate,
	type MutatingToolResult,
	type ReadToolResult,
	toToolErrorResult,
} from "./common";

type MutationResult =
	| { message: string; summary?: { subject?: string } }
	| { error: string };
type AddResult =
	| { message: string; uuids: Uuid[]; summary: { count: number } }
	| { error: string };

function scope(ctx: ToolExecutionContext): OrganizationScope {
	return {
		appId: ctx.appId,
		projectId: ctx.projectId,
		actorUserId: ctx.userId,
		// Informational only. Every writer re-authorizes the fresh membership
		// under the app lock instead of trusting this snapshot.
		role: "tool",
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: "The organization change failed.";
}

async function commit(
	ctx: ToolExecutionContext,
	doc: BlueprintDoc,
	mutations: Mutation[],
	stage: string,
	message: string,
	subject?: string,
): Promise<MutatingToolResult<MutationResult>> {
	const outcome = await guardedMutate(ctx, doc, mutations, stage);
	if (!outcome.ok) {
		return {
			kind: "mutate",
			mutations: [],
			newDoc: doc,
			result: { error: outcome.error },
		};
	}
	return {
		kind: "mutate",
		mutations: outcome.mutations,
		newDoc: outcome.newDoc,
		result: {
			message,
			...(subject === undefined ? {} : { summary: { subject } }),
		},
	};
}

const levelCreateSchema = organizationLevelSchema.omit({ uuid: true });
const propertyCreateSchema = locationPropertySchema.omit({ uuid: true });

export const getOrganizationInputSchema = z.object({}).strict();
export const addOrganizationLevelsInputSchema = z
	.object({ levels: z.array(levelCreateSchema).min(1).max(50) })
	.strict();
export const updateOrganizationLevelInputSchema = z
	.object({
		uuid: uuidSchema,
		name: levelCreateSchema.shape.name.optional(),
		description: z.string().nullable().optional(),
		parentLevelUuid: uuidSchema.nullable().optional(),
		caseFlow: levelCaseFlowSchema.optional(),
		addressBook: levelAddressBookSchema.optional(),
	})
	.strict();
export const removeOrganizationLevelInputSchema = z
	.object({ uuid: uuidSchema })
	.strict();
export const addLocationPropertiesInputSchema = z
	.object({ properties: z.array(propertyCreateSchema).min(1).max(100) })
	.strict();
export const updateLocationPropertyInputSchema = z
	.object({
		uuid: uuidSchema,
		slug: propertyCreateSchema.shape.slug.optional(),
		label: propertyCreateSchema.shape.label.optional(),
		required: z.boolean().nullable().optional(),
		choices: z.array(z.string().min(1)).min(1).nullable().optional(),
		levelUuids: z.array(uuidSchema).min(1).nullable().optional(),
	})
	.strict();
export const removeLocationPropertyInputSchema = z
	.object({ uuid: uuidSchema })
	.strict();
export const createLocationToolInputSchema = createLocationInputSchema.extend({
	expectedRevision: organizationRevisionSchema.optional(),
});
export const updateLocationToolInputSchema = updateLocationInputSchema.extend({
	locationUuid: uuidSchema,
	expectedRevision: organizationRevisionSchema.optional(),
});
export const moveLocationToolInputSchema = z
	.object({
		locationUuid: uuidSchema,
		parentUuid: uuidSchema.nullable(),
		afterSiblingUuid: uuidSchema.optional(),
		expectedRevision: organizationRevisionSchema.optional(),
	})
	.strict();
export const setLocationArchivedToolInputSchema = z
	.object({
		locationUuid: uuidSchema,
		archived: z.boolean(),
		expectedRevision: organizationRevisionSchema.optional(),
	})
	.strict();

export const getOrganizationTool = {
	description:
		"Read organization levels, place-information fields, the current revision, and all places (including archived) with stable uuids.",
	inputSchema: getOrganizationInputSchema,
	async execute(
		_input: z.infer<typeof getOrganizationInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<ReadToolResult<unknown>> {
		try {
			const snapshot = await readOrganization(scope(ctx));
			return {
				kind: "read",
				data: {
					levels: orderedOrganizationLevels(doc),
					placeInformation: orderedLocationProperties(doc),
					...snapshot,
				},
			};
		} catch (error) {
			return { kind: "read", data: { error: errorMessage(error) } };
		}
	},
};

export const addOrganizationLevelsTool = {
	description:
		"Add organization levels. Codes are create-once wire identities; use returned uuids for parents, place creation, settings, and owner expressions.",
	inputSchema: addOrganizationLevelsInputSchema,
	async execute(
		input: z.infer<typeof addOrganizationLevelsInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddResult>> {
		try {
			const uuids = input.levels.map(() => asUuid(crypto.randomUUID()));
			let cursor = doc;
			const mutations: Mutation[] = [];
			for (const [index, level] of input.levels.entries()) {
				const next = addOrganizationLevelMutations(cursor, uuids[index], level);
				mutations.push(...next);
				cursor = applyToDoc(cursor, next);
			}
			const outcome = await guardedMutate(
				ctx,
				doc,
				mutations,
				"organization:levels:add",
			);
			if (!outcome.ok) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: { error: outcome.error },
				};
			}
			return {
				kind: "mutate",
				mutations: outcome.mutations,
				newDoc: outcome.newDoc,
				result: {
					message: `Added ${uuids.length} organization ${uuids.length === 1 ? "level" : "levels"}.`,
					uuids,
					summary: { count: uuids.length },
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const updateOrganizationLevelTool = {
	description:
		"Update an organization level by uuid. Its code is intentionally immutable; omitted fields stay unchanged and null clears optional description or parent.",
	inputSchema: updateOrganizationLevelInputSchema,
	async execute(
		input: z.infer<typeof updateOrganizationLevelInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	) {
		try {
			const current = ownRecordValue(organizationLevelsOf(doc), input.uuid);
			if (current === undefined)
				return toToolErrorResult(
					new Error("Organization level not found."),
					doc,
				);
			const { uuid, ...patch } = input;
			return await commit(
				ctx,
				doc,
				[{ kind: "updateOrganizationLevel", uuid, patch }],
				"organization:level:update",
				`Updated organization level "${current.name}".`,
				current.name,
			);
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const removeOrganizationLevelTool = {
	description:
		"Remove an unused organization level by uuid. Refuses while places, child levels, settings, or owner expressions still depend on it.",
	inputSchema: removeOrganizationLevelInputSchema,
	async execute(
		input: z.infer<typeof removeOrganizationLevelInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	) {
		try {
			const current = ownRecordValue(organizationLevelsOf(doc), input.uuid);
			if (current === undefined)
				return toToolErrorResult(
					new Error("Organization level not found."),
					doc,
				);
			const plan = removeOrganizationLevelPlan(doc, input.uuid);
			if (!plan.ok) return toToolErrorResult(new Error(plan.userMessage), doc);
			return await commit(
				ctx,
				doc,
				plan.mutations,
				"organization:level:remove",
				`Removed organization level "${current.name}".`,
				current.name,
			);
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const addLocationPropertiesTool = {
	description:
		"Add app-wide place-information fields. Values are stored on places by the returned stable property uuids, so slug renames do not rewrite rows.",
	inputSchema: addLocationPropertiesInputSchema,
	async execute(
		input: z.infer<typeof addLocationPropertiesInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddResult>> {
		try {
			const uuids = input.properties.map(() => asUuid(crypto.randomUUID()));
			let cursor = doc;
			const mutations: Mutation[] = [];
			for (const [index, property] of input.properties.entries()) {
				const next = addLocationPropertyMutations(
					cursor,
					uuids[index],
					property,
				);
				mutations.push(...next);
				cursor = applyToDoc(cursor, next);
			}
			const outcome = await guardedMutate(
				ctx,
				doc,
				mutations,
				"organization:placeInformation:add",
			);
			if (!outcome.ok)
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: { error: outcome.error },
				};
			return {
				kind: "mutate",
				mutations: outcome.mutations,
				newDoc: outcome.newDoc,
				result: {
					message: `Added ${uuids.length} place-information ${uuids.length === 1 ? "field" : "fields"}.`,
					uuids,
					summary: { count: uuids.length },
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const updateLocationPropertyTool = {
	description:
		"Update one place-information field by stable uuid. Omit to keep; null clears optional constraints.",
	inputSchema: updateLocationPropertyInputSchema,
	async execute(
		input: z.infer<typeof updateLocationPropertyInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	) {
		try {
			const current = ownRecordValue(locationPropertiesOf(doc), input.uuid);
			if (current === undefined)
				return toToolErrorResult(
					new Error("Place-information field not found."),
					doc,
				);
			const { uuid, ...patch } = input;
			return await commit(
				ctx,
				doc,
				[{ kind: "updateLocationProperty", uuid, patch }],
				"organization:placeInformation:update",
				`Updated place information "${current.label}".`,
				current.label,
			);
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const removeLocationPropertyTool = {
	description:
		"Remove one place-information field by uuid and atomically shed its saved values from every place.",
	inputSchema: removeLocationPropertyInputSchema,
	async execute(
		input: z.infer<typeof removeLocationPropertyInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	) {
		try {
			const current = ownRecordValue(locationPropertiesOf(doc), input.uuid);
			if (current === undefined)
				return toToolErrorResult(
					new Error("Place-information field not found."),
					doc,
				);
			return await commit(
				ctx,
				doc,
				removeLocationPropertyMutations(input.uuid),
				"organization:placeInformation:remove",
				`Removed place information "${current.label}".`,
				current.label,
			);
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

function rowResult<T>(
	run: () => Promise<T>,
): Promise<ReadToolResult<T | { error: string }>> {
	return run().then(
		(data) => ({ kind: "read" as const, data }),
		(error) => ({
			kind: "read" as const,
			data: { error: errorMessage(error) },
		}),
	);
}

export const createLocationTool = {
	description:
		"Create one place after its level is saved. Omit siteCode to derive a create-once code from the name.",
	inputSchema: createLocationToolInputSchema,
	async execute(
		input: z.infer<typeof createLocationToolInputSchema>,
		ctx: ToolExecutionContext,
		_doc: BlueprintDoc,
	) {
		const { expectedRevision, ...location } = input;
		return rowResult(() =>
			createLocation(scope(ctx), location, expectedRevision),
		);
	},
};

export const updateLocationTool = {
	description:
		"Update one place by uuid. Site codes are create-once and cannot be changed.",
	inputSchema: updateLocationToolInputSchema,
	async execute(
		input: z.infer<typeof updateLocationToolInputSchema>,
		ctx: ToolExecutionContext,
		_doc: BlueprintDoc,
	) {
		const { locationUuid, expectedRevision, ...patch } = input;
		return rowResult(() =>
			updateLocation(scope(ctx), locationUuid, patch, expectedRevision),
		);
	},
};

export const moveLocationTool = {
	description:
		"Move one place within the organization tree, optionally positioning it after a sibling.",
	inputSchema: moveLocationToolInputSchema,
	async execute(
		input: z.infer<typeof moveLocationToolInputSchema>,
		ctx: ToolExecutionContext,
		_doc: BlueprintDoc,
	) {
		return rowResult(() =>
			moveLocation(
				scope(ctx),
				input.locationUuid,
				{
					parentId: input.parentUuid,
					...(input.afterSiblingUuid === undefined
						? {}
						: { afterSiblingId: input.afterSiblingUuid }),
				},
				input.expectedRevision,
			),
		);
	},
};

export const setLocationArchivedTool = {
	description:
		"Archive or unarchive a place. Archiving affects its subtree, reports owned cases, and atomically removes persona assignments; it never reassigns case owners.",
	inputSchema: setLocationArchivedToolInputSchema,
	async execute(
		input: z.infer<typeof setLocationArchivedToolInputSchema>,
		ctx: ToolExecutionContext,
		_doc: BlueprintDoc,
	) {
		return rowResult(async () => ({
			impact: input.archived
				? await describeArchiveImpact(scope(ctx), input.locationUuid)
				: undefined,
			result: await setLocationArchived(
				scope(ctx),
				input.locationUuid,
				input.archived,
				input.expectedRevision,
			),
		}));
	},
};
