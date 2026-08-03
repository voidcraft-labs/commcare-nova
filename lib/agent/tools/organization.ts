/** Shared SA/MCP authoring for organization shape and app-scoped places. */

import { z } from "zod";
import {
	AppProjectChangedError,
	CommitReauthError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";
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
	archiveImpactSchema,
	createLocationInputSchema,
	organizationRevisionSchema,
	updateLocationInputSchema,
} from "@/lib/organization/schema";
import {
	createLocation,
	describeArchiveImpact,
	moveLocation,
	readOrganizationAuthoringSnapshot,
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
		changeSource: {
			kind: ctx.chatRunHolder === undefined ? "mcp" : "chat",
			runId: ctx.runId,
		},
		...(ctx.chatRunHolder === undefined
			? {}
			: { chatRunHolder: ctx.chatRunHolder }),
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

const levelCreateSchema = organizationLevelSchema.omit({ uuid: true }).extend({
	/** Optional predeclared identity lets one atomic call add a parent and
	 * children that reference it. Omitted identities remain server-minted. */
	uuid: z.preprocess(
		(value) => (value === null ? undefined : value),
		uuidSchema.optional(),
	),
	description: organizationLevelSchema.shape.description.nullable(),
	parentLevelUuid: uuidSchema.nullable().optional(),
});
const propertyCreateSchema = locationPropertySchema
	.omit({ uuid: true })
	.extend({
		required: locationPropertySchema.shape.required.nullable(),
		choices: locationPropertySchema.shape.choices.nullable(),
		levelUuids: locationPropertySchema.shape.levelUuids.nullable(),
	});

const ORGANIZATION_PAGE_SIZE = 25;
const ORGANIZATION_PAGE_MAX = 50;
const organizationCursorPayloadSchema = z
	.object({
		revision: organizationRevisionSchema,
		blueprintSeq: z.number().int().nonnegative(),
		offset: z.number().int().nonnegative(),
		query: z.string().max(255).nullable(),
		includeValues: z.boolean(),
	})
	.strict();

function encodeOrganizationCursor(
	payload: z.infer<typeof organizationCursorPayloadSchema>,
): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeOrganizationCursor(
	cursor: string,
): z.infer<typeof organizationCursorPayloadSchema> {
	try {
		return organizationCursorPayloadSchema.parse(
			JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
		);
	} catch {
		throw new Error(
			"That organization cursor is invalid. Restart the read without a cursor.",
		);
	}
}

export const getOrganizationInputSchema = z
	.object({
		query: z.string().trim().max(255).nullable().optional(),
		/** Opaque snapshot-bound cursor returned by the preceding page. */
		cursor: z.string().max(1024).nullable().optional(),
		limit: z
			.number()
			.int()
			.min(1)
			.max(ORGANIZATION_PAGE_MAX)
			.default(ORGANIZATION_PAGE_SIZE),
		/** Saved custom values can be large; request them only when needed. */
		includeValues: z.boolean().nullable().optional(),
	})
	.strict();
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
	.strict()
	.refine((input) => Object.keys(input).length > 1, {
		message: "Change at least one organization-level setting.",
	});
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
		choices: locationPropertySchema.shape.choices.nullable(),
		levelUuids: locationPropertySchema.shape.levelUuids.nullable().optional(),
	})
	.strict()
	.refine((input) => Object.keys(input).length > 1, {
		message: "Change at least one place-information setting.",
	});
export const removeLocationPropertyInputSchema = z
	.object({ uuid: uuidSchema })
	.strict();
export const createLocationToolInputSchema = createLocationInputSchema.extend({
	expectedRevision: organizationRevisionSchema,
});
export const updateLocationToolInputSchema = updateLocationInputSchema
	.safeExtend({
		locationUuid: uuidSchema,
		expectedRevision: organizationRevisionSchema,
	})
	.refine(
		(input) =>
			Object.keys(input).some(
				(key) => key !== "locationUuid" && key !== "expectedRevision",
			),
		{ message: "Change at least one place field." },
	);
export const moveLocationToolInputSchema = z
	.object({
		locationUuid: uuidSchema,
		parentUuid: uuidSchema.nullable(),
		/** null means first; omitted means append. */
		afterSiblingUuid: uuidSchema.nullable().optional(),
		expectedRevision: organizationRevisionSchema,
	})
	.strict();
export const setLocationArchivedToolInputSchema = z
	.object({
		locationUuid: uuidSchema,
		archived: z.boolean(),
		expectedRevision: organizationRevisionSchema,
		/** Archive is two-step: omit/false to read impact, then true with the
		 * exact returned payload to commit. Unarchive does not need it. */
		confirm: z.boolean().optional(),
		confirmedImpact: archiveImpactSchema.optional(),
	})
	.strict()
	.superRefine((input, ctx) => {
		if (
			input.archived &&
			input.confirm === true &&
			input.confirmedImpact === undefined
		) {
			ctx.addIssue({
				code: "custom",
				path: ["confirmedImpact"],
				message:
					"Confirming an archive requires the exact impact payload returned by its preflight.",
			});
		}
	});

export const getOrganizationTool = {
	description:
		"Read organization levels, place-information fields, the current revision, and places (including archived) with stable uuids. One bounded cursor pages across all three collections, so accumulate each collection until page.complete is true; if a page says restart, begin again without a cursor. Request includeValues only when saved custom values are needed.",
	inputSchema: getOrganizationInputSchema,
	async execute(
		input: z.infer<typeof getOrganizationInputSchema>,
		ctx: ToolExecutionContext,
		_doc: BlueprintDoc,
	): Promise<ReadToolResult<unknown>> {
		try {
			const authoring = await readOrganizationAuthoringSnapshot(scope(ctx));
			const snapshot = authoring.organization;
			const cursor =
				input.cursor === undefined || input.cursor === null
					? undefined
					: decodeOrganizationCursor(input.cursor);
			if (
				cursor !== undefined &&
				(cursor.revision !== snapshot.revision ||
					cursor.blueprintSeq !== authoring.blueprintSeq)
			) {
				return {
					kind: "read",
					data: {
						error:
							"The organization changed between pages. Restart without a cursor to read one complete snapshot.",
						restart: true,
						revision: snapshot.revision,
					},
				};
			}
			const requestedQuery = input.query?.trim() || null;
			const requestedIncludeValues = input.includeValues ?? undefined;
			if (
				cursor !== undefined &&
				((input.query !== undefined && requestedQuery !== cursor.query) ||
					(requestedIncludeValues !== undefined &&
						requestedIncludeValues !== cursor.includeValues))
			) {
				return {
					kind: "read",
					data: {
						error:
							"A paged organization read must keep the same query and value projection. Restart without a cursor to change them.",
						restart: true,
					},
				};
			}
			const query = cursor?.query ?? requestedQuery;
			const includeValues =
				cursor?.includeValues ?? requestedIncludeValues ?? false;
			const needle = query?.toLocaleLowerCase();
			const matching =
				needle === undefined || needle === ""
					? snapshot.locations
					: snapshot.locations.filter((location) =>
							[location.name, location.siteCode, location.externalId]
								.filter((value): value is string => value !== null)
								.some((value) => value.toLocaleLowerCase().includes(needle)),
						);
			const start = cursor?.offset ?? 0;
			const pageEnd = start + input.limit;
			const allLevels = orderedOrganizationLevels(authoring.blueprint);
			const allPlaceInformation = orderedLocationProperties(
				authoring.blueprint,
			);
			// One cursor covers one logical stream. Each response therefore carries
			// at most `limit` total entities, rather than independently taking a full
			// page from levels, fields, and places. Shape comes first so a caller can
			// interpret the location rows that follow.
			const levelStart = Math.min(start, allLevels.length);
			const levelEnd = Math.min(pageEnd, allLevels.length);
			const levels = allLevels.slice(levelStart, levelEnd);
			const afterLevelsStart = Math.max(0, start - allLevels.length);
			const afterLevelsEnd = Math.max(0, pageEnd - allLevels.length);
			const placeInformationStart = Math.min(
				afterLevelsStart,
				allPlaceInformation.length,
			);
			const placeInformationEnd = Math.min(
				afterLevelsEnd,
				allPlaceInformation.length,
			);
			const placeInformation = allPlaceInformation.slice(
				placeInformationStart,
				placeInformationEnd,
			);
			const shapeCount = allLevels.length + allPlaceInformation.length;
			const locationStart = Math.min(
				Math.max(0, start - shapeCount),
				matching.length,
			);
			const locationEnd = Math.min(
				Math.max(0, pageEnd - shapeCount),
				matching.length,
			);
			const locations = matching
				.slice(locationStart, locationEnd)
				.map((location) => {
					if (includeValues) return location;
					const { values: _values, ...projection } = location;
					return projection;
				});
			const totalItems = shapeCount + matching.length;
			const returned =
				levels.length + placeInformation.length + locations.length;
			const complete = pageEnd >= totalItems;
			return {
				kind: "read",
				data: {
					levels,
					placeInformation,
					blueprintSeq: authoring.blueprintSeq,
					revision: snapshot.revision,
					locations,
					page: {
						returned,
						locationsReturned: locations.length,
						matching: matching.length,
						total: snapshot.locations.length,
						levelsReturned: levels.length,
						levelsTotal: allLevels.length,
						placeInformationReturned: placeInformation.length,
						placeInformationTotal: allPlaceInformation.length,
						complete,
						nextCursor: !complete
							? encodeOrganizationCursor({
									revision: snapshot.revision,
									blueprintSeq: authoring.blueprintSeq,
									offset: pageEnd,
									query,
									includeValues,
								})
							: null,
					},
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
			const uuids = input.levels.map(
				(level) => level.uuid ?? asUuid(crypto.randomUUID()),
			);
			const knownLevels = new Set(Object.keys(organizationLevelsOf(doc)));
			let cursor = doc;
			const mutations: Mutation[] = [];
			for (const [index, level] of input.levels.entries()) {
				if (
					level.parentLevelUuid !== null &&
					level.parentLevelUuid !== undefined &&
					!knownLevels.has(level.parentLevelUuid)
				) {
					return toToolErrorResult(
						new Error(
							"Add a parent organization level before any child that names it in the same call.",
						),
						doc,
					);
				}
				const {
					uuid: _uuid,
					description,
					parentLevelUuid,
					...required
				} = level;
				const body = {
					...required,
					...(description === null || description === undefined
						? {}
						: { description }),
					...(parentLevelUuid === null || parentLevelUuid === undefined
						? {}
						: { parentLevelUuid }),
				};
				const next = addOrganizationLevelMutations(cursor, uuids[index], body);
				mutations.push(...next);
				cursor = applyToDoc(cursor, next);
				knownLevels.add(uuids[index]);
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
				const normalized = {
					slug: property.slug,
					label: property.label,
					...(property.required === null || property.required === undefined
						? {}
						: { required: property.required }),
					...(property.choices === null || property.choices === undefined
						? {}
						: { choices: property.choices }),
					...(property.levelUuids === null || property.levelUuids === undefined
						? {}
						: { levelUuids: property.levelUuids }),
				};
				const next = addLocationPropertyMutations(
					cursor,
					uuids[index],
					normalized,
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
		(error) => {
			// Losing the exact chat generation is terminal. Turning it into an
			// ordinary read result would let a stale SA keep spending and possibly
			// report success after its successor took over.
			if (
				error instanceof AppProjectChangedError ||
				error instanceof CommitReauthError ||
				error instanceof RunHolderLostError
			) {
				throw error;
			}
			return {
				kind: "read" as const,
				data: { error: errorMessage(error) },
			};
		},
	);
}

export const createLocationTool = {
	description:
		"Create one root place after its level is saved, optionally with a bounded structurally nested descendants tree committed atomically. Use descendants when an active reverse-hop owner rule requires a destination below the new root; nesting declares parentage and the compact result mirrors it with final UUIDs. Pass the exact current expectedRevision from getOrganization or the preceding place write, and chain the returned revision before another create. Omit siteCode to derive a create-once code from the name.",
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
		"Archive or unarchive a place. Archiving is two-step: first call with archived=true and confirm omitted/false to receive a bounded impact plus an exact confirmation token; after the user agrees, call with confirm=true and that unchanged confirmedImpact. A blocked preflight must not be confirmed. It never reassigns case owners.",
	inputSchema: setLocationArchivedToolInputSchema,
	async execute(
		input: z.infer<typeof setLocationArchivedToolInputSchema>,
		ctx: ToolExecutionContext,
		_doc: BlueprintDoc,
	) {
		try {
			if (input.archived && input.confirm !== true) {
				const impact = await describeArchiveImpact(
					scope(ctx),
					input.locationUuid,
				);
				return {
					kind: "read" as const,
					data: {
						confirmationRequired: impact.blockingOwnerRuleFormCount === 0,
						blocked: impact.blockingOwnerRuleFormCount > 0,
						message:
							impact.blockingOwnerRuleFormCount > 0
								? "This archive is blocked by fixed case-owner rules. Change the listed forms before requesting confirmation again."
								: "Review this bounded archive impact with the user, then repeat the call with confirm=true and the unchanged confirmedImpact payload.",
						impact,
					},
				};
			}
			const result = await setLocationArchived(
				scope(ctx),
				input.locationUuid,
				input.archived,
				input.expectedRevision,
				input.confirmedImpact,
			);
			if (result.blueprintChange !== undefined) {
				const { blueprintChange, ...organization } = result;
				return {
					kind: "mutate" as const,
					mutations: blueprintChange.mutations,
					newDoc: blueprintChange.committedDoc,
					result: {
						message: `Archived ${result.archivedCount} ${result.archivedCount === 1 ? "place" : "places"} and updated ${result.unassignedPersonaCount} persona ${result.unassignedPersonaCount === 1 ? "assignment" : "assignments"}.`,
						...organization,
					},
				};
			}
			return {
				kind: "read" as const,
				data: result,
			};
		} catch (error) {
			if (
				error instanceof AppProjectChangedError ||
				error instanceof CommitReauthError ||
				error instanceof RunHolderLostError
			) {
				throw error;
			}
			return {
				kind: "read" as const,
				data: { error: errorMessage(error) },
			};
		}
	},
};
