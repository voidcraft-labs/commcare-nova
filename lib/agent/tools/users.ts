/**
 * Shared SA/MCP tools for worker information, roles, and personas.
 *
 * The wire takes stable UUID handles; user-data values arrive as an array of
 * `{ userPropertyUuid, value }` entries and bridge to the domain's
 * UUID-keyed record here. This keeps JSON schemas closed and makes property
 * renames irrelevant to stored values. Update-only optional slots use the
 * standard contract: omitted keeps the slot, `null` clears it.
 */

import { z } from "zod";
import { bySortKey } from "@/lib/doc/order/compare";
import type { Mutation } from "@/lib/doc/types";
import {
	addPersonaMutations,
	addUserPropertyMutations,
	addUserTypeMutations,
	removePersonaMutations,
	removeUserPropertyMutations,
	removeUserTypePlan,
} from "@/lib/doc/userMutations";
import {
	asUuid,
	type BlueprintDoc,
	type Persona,
	personasOf,
	USER_PROPERTY_LABEL_MAX_LENGTH,
	USER_PROPERTY_SLUG_MAX_LENGTH,
	USER_PROPERTY_SLUG_PATTERN,
	type UserDataValues,
	type UserProperty,
	type UserType,
	type Uuid,
	userPropertiesOf,
	userTypesOf,
	uuidSchema,
} from "@/lib/domain";
import type { ToolExecutionContext } from "../toolExecutionContext";
import {
	applyToDoc,
	guardedMutate,
	type MutatingToolResult,
	type ReadToolResult,
	toToolErrorResult,
} from "./common";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

const valuesInputSchema = z
	.array(
		z
			.object({
				userPropertyUuid: uuidSchema.describe(
					"Stable uuid of the worker-information property.",
				),
				value: z.string().describe("Value this role or persona carries."),
			})
			.strict(),
	)
	.min(1)
	.superRefine((entries, ctx) => {
		const seen = new Set<string>();
		for (const [index, entry] of entries.entries()) {
			if (seen.has(entry.userPropertyUuid)) {
				ctx.addIssue({
					code: "custom",
					path: [index, "userPropertyUuid"],
					message: "Each worker-information property may appear only once.",
				});
			}
			seen.add(entry.userPropertyUuid);
		}
	});

type ValuesInput = z.infer<typeof valuesInputSchema>;

function valuesRecord(
	entries: ValuesInput | undefined,
): UserDataValues | undefined {
	if (entries === undefined) return undefined;
	return Object.fromEntries(
		entries.map((entry) => [entry.userPropertyUuid, entry.value]),
	);
}

function updatedValues(
	entries: ValuesInput | null | undefined,
): UserDataValues | null | undefined {
	return entries === null ? null : valuesRecord(entries);
}

const userPropertyCreateSchema = z
	.object({
		slug: z
			.string()
			.min(1)
			.max(USER_PROPERTY_SLUG_MAX_LENGTH)
			.regex(USER_PROPERTY_SLUG_PATTERN)
			.describe(
				"Saved name expressions read. The commit gate checks reserved names.",
			),
		label: z
			.string()
			.min(1)
			.max(USER_PROPERTY_LABEL_MAX_LENGTH)
			.describe("Name authors and administrators see."),
		required: z.boolean().nullable().optional(),
		choices: z.array(z.string().min(1)).min(1).nullable().optional(),
	})
	.strict();

const userTypeCreateSchema = z
	.object({
		name: z.string().min(1),
		description: z.string().min(1).nullable().optional(),
		values: valuesInputSchema.nullable().optional(),
	})
	.strict();

const personaCreateSchema = z
	.object({
		name: z.string().min(1),
		description: z.string().min(1).nullable().optional(),
		userTypeUuid: uuidSchema.nullable().optional(),
		values: valuesInputSchema.nullable().optional(),
	})
	.strict();

export const addUserPropertiesInputSchema = z
	.object({
		properties: z.array(userPropertyCreateSchema).min(1).max(100),
	})
	.strict();

export const updateUserPropertyInputSchema = z
	.object({
		uuid: uuidSchema,
		slug: userPropertyCreateSchema.shape.slug.optional(),
		label: userPropertyCreateSchema.shape.label.optional(),
		required: z.boolean().nullable().optional(),
		choices: z.array(z.string().min(1)).min(1).nullable().optional(),
	})
	.strict();

export const removeUserPropertyInputSchema = z
	.object({ uuid: uuidSchema })
	.strict();

export const addUserTypesInputSchema = z
	.object({ userTypes: z.array(userTypeCreateSchema).min(1).max(100) })
	.strict();

export const updateUserTypeInputSchema = z
	.object({
		uuid: uuidSchema,
		name: z.string().min(1).optional(),
		description: z.string().min(1).nullable().optional(),
		values: valuesInputSchema.nullable().optional(),
	})
	.strict();

export const removeUserTypeInputSchema = z
	.object({ uuid: uuidSchema })
	.strict();

export const addPersonasInputSchema = z
	.object({ personas: z.array(personaCreateSchema).min(1).max(100) })
	.strict();

export const updatePersonaInputSchema = z
	.object({
		uuid: uuidSchema,
		name: z.string().min(1).optional(),
		description: z.string().min(1).nullable().optional(),
		userTypeUuid: uuidSchema.nullable().optional(),
		values: valuesInputSchema.nullable().optional(),
	})
	.strict();

export const removePersonaInputSchema = z.object({ uuid: uuidSchema }).strict();
export const getUsersInputSchema = z.object({}).strict();

type MutationResult = MutationSuccess | { error: string };
type AddMutationResult =
	| (MutationSuccess & { uuids: Uuid[] })
	| { error: string };

function missing(kind: string, uuid: string): { error: string } {
	return {
		error: `${kind} "${uuid}" no longer exists. Read the current users and try again.`,
	};
}

async function commit(
	ctx: ToolExecutionContext,
	doc: BlueprintDoc,
	mutations: Mutation[],
	stage: string,
	message: string,
	summary: ToolCallSummary,
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
		mutations,
		newDoc: outcome.newDoc,
		result: { message, summary },
	};
}

export const addUserPropertiesTool = {
	description:
		"Add one or more worker-information properties. Returns stable uuids for role and persona values.",
	inputSchema: addUserPropertiesInputSchema,
	async execute(
		input: z.infer<typeof addUserPropertiesInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddMutationResult>> {
		try {
			const uuids = input.properties.map(() => asUuid(crypto.randomUUID()));
			let cursor = doc;
			const mutations: Mutation[] = [];
			for (const [index, property] of input.properties.entries()) {
				const next = addUserPropertyMutations(cursor, uuids[index], {
					slug: property.slug,
					label: property.label,
					...(property.required != null && { required: property.required }),
					...(property.choices != null && { choices: property.choices }),
				});
				mutations.push(...next);
				cursor = applyToDoc(cursor, next);
			}
			const outcome = await guardedMutate(
				ctx,
				doc,
				mutations,
				"users:workerInformation:add",
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
				mutations,
				newDoc: outcome.newDoc,
				result: {
					message: `Added ${uuids.length} worker-information ${uuids.length === 1 ? "property" : "properties"}. Stable uuids: ${uuids.join(", ")}.`,
					uuids,
					summary: { count: uuids.length },
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const updateUserPropertyTool = {
	description:
		"Update one worker-information property by stable uuid. Omit to keep; null clears required or accepted values.",
	inputSchema: updateUserPropertyInputSchema,
	async execute(
		input: z.infer<typeof updateUserPropertyInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<MutationResult>> {
		try {
			const current = userPropertiesOf(doc)[input.uuid];
			if (current === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: missing("Worker-information property", input.uuid),
				};
			}
			const { uuid, ...patch } = input;
			if (Object.keys(patch).length === 0) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: { error: "Nothing to change." },
				};
			}
			return await commit(
				ctx,
				doc,
				[{ kind: "updateUserProperty", uuid, patch }],
				"users:workerInformation:update",
				`Updated worker information "${current.label}".`,
				{ subject: current.label },
			);
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const removeUserPropertyTool = {
	description:
		"Remove worker information by stable uuid, atomically clearing its values from every role and persona.",
	inputSchema: removeUserPropertyInputSchema,
	async execute(
		input: z.infer<typeof removeUserPropertyInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<MutationResult>> {
		try {
			const current = userPropertiesOf(doc)[input.uuid];
			if (current === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: missing("Worker-information property", input.uuid),
				};
			}
			return await commit(
				ctx,
				doc,
				removeUserPropertyMutations(doc, input.uuid),
				"users:workerInformation:remove",
				`Removed worker information "${current.label}" and its recorded role/persona values.`,
				{ subject: current.label },
			);
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const addUserTypesTool = {
	description:
		"Add one or more reusable worker roles. Value entries target worker information by stable uuid.",
	inputSchema: addUserTypesInputSchema,
	async execute(
		input: z.infer<typeof addUserTypesInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddMutationResult>> {
		try {
			const uuids = input.userTypes.map(() => asUuid(crypto.randomUUID()));
			let cursor = doc;
			const mutations: Mutation[] = [];
			for (const [index, userType] of input.userTypes.entries()) {
				const next = addUserTypeMutations(cursor, uuids[index], {
					name: userType.name,
					...(userType.description != null && {
						description: userType.description,
					}),
					...(userType.values != null && {
						values: valuesRecord(userType.values),
					}),
				});
				mutations.push(...next);
				cursor = applyToDoc(cursor, next);
			}
			const outcome = await guardedMutate(
				ctx,
				doc,
				mutations,
				"users:role:add",
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
				mutations,
				newDoc: outcome.newDoc,
				result: {
					message: `Added ${uuids.length} ${uuids.length === 1 ? "role" : "roles"}. Stable uuids: ${uuids.join(", ")}.`,
					uuids,
					summary: { count: uuids.length },
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const updateUserTypeTool = {
	description:
		"Update one role by stable uuid. Omit to keep; null clears description or all default values.",
	inputSchema: updateUserTypeInputSchema,
	async execute(
		input: z.infer<typeof updateUserTypeInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<MutationResult>> {
		try {
			const current = userTypesOf(doc)[input.uuid];
			if (current === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: missing("Role", input.uuid),
				};
			}
			const patch = {
				...(input.name !== undefined && { name: input.name }),
				...(input.description !== undefined && {
					description: input.description,
				}),
				...(input.values !== undefined && {
					values: updatedValues(input.values),
				}),
			};
			if (Object.keys(patch).length === 0) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: { error: "Nothing to change." },
				};
			}
			return await commit(
				ctx,
				doc,
				[{ kind: "updateUserType", uuid: input.uuid, patch }],
				"users:role:update",
				`Updated role "${current.name}".`,
				{ subject: current.name },
			);
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const removeUserTypeTool = {
	description:
		"Remove a role by stable uuid. Refused while any persona still uses it.",
	inputSchema: removeUserTypeInputSchema,
	async execute(
		input: z.infer<typeof removeUserTypeInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<MutationResult>> {
		try {
			const current = userTypesOf(doc)[input.uuid];
			if (current === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: missing("Role", input.uuid),
				};
			}
			const plan = removeUserTypePlan(doc, input.uuid);
			if (!plan.ok) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: { error: plan.userMessage },
				};
			}
			return await commit(
				ctx,
				doc,
				plan.mutations,
				"users:role:remove",
				`Removed role "${current.name}".`,
				{ subject: current.name },
			);
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const addPersonasTool = {
	description:
		"Add one or more named Preview workers. Roles and worker-information values use stable uuids.",
	inputSchema: addPersonasInputSchema,
	async execute(
		input: z.infer<typeof addPersonasInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddMutationResult>> {
		try {
			const uuids = input.personas.map(() => asUuid(crypto.randomUUID()));
			let cursor = doc;
			const mutations: Mutation[] = [];
			for (const [index, persona] of input.personas.entries()) {
				const next = addPersonaMutations(cursor, uuids[index], {
					name: persona.name,
					...(persona.description != null && {
						description: persona.description,
					}),
					...(persona.userTypeUuid != null && {
						userTypeUuid: persona.userTypeUuid,
					}),
					...(persona.values != null && {
						values: valuesRecord(persona.values),
					}),
				});
				mutations.push(...next);
				cursor = applyToDoc(cursor, next);
			}
			const outcome = await guardedMutate(
				ctx,
				doc,
				mutations,
				"users:persona:add",
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
				mutations,
				newDoc: outcome.newDoc,
				result: {
					message: `Added ${uuids.length} ${uuids.length === 1 ? "persona" : "personas"}. Stable uuids: ${uuids.join(", ")}.`,
					uuids,
					summary: { count: uuids.length },
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const updatePersonaTool = {
	description:
		"Update one Preview persona by stable uuid. Omit to keep; null clears description, role, or all overrides.",
	inputSchema: updatePersonaInputSchema,
	async execute(
		input: z.infer<typeof updatePersonaInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<MutationResult>> {
		try {
			const current = personasOf(doc)[input.uuid];
			if (current === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: missing("Persona", input.uuid),
				};
			}
			const patch = {
				...(input.name !== undefined && { name: input.name }),
				...(input.description !== undefined && {
					description: input.description,
				}),
				...(input.userTypeUuid !== undefined && {
					userTypeUuid: input.userTypeUuid,
				}),
				...(input.values !== undefined && {
					values: updatedValues(input.values),
				}),
			};
			if (Object.keys(patch).length === 0) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: { error: "Nothing to change." },
				};
			}
			return await commit(
				ctx,
				doc,
				[{ kind: "updatePersona", uuid: input.uuid, patch }],
				"users:persona:update",
				`Updated persona "${current.name}".`,
				{ subject: current.name },
			);
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const removePersonaTool = {
	description:
		"Remove a Preview persona by stable uuid. Existing cases it owns are preserved.",
	inputSchema: removePersonaInputSchema,
	async execute(
		input: z.infer<typeof removePersonaInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<MutationResult>> {
		try {
			const current = personasOf(doc)[input.uuid];
			if (current === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: missing("Persona", input.uuid),
				};
			}
			return await commit(
				ctx,
				doc,
				removePersonaMutations(input.uuid),
				"users:persona:remove",
				`Removed persona "${current.name}". The cases it already owned were preserved.`,
				{ subject: current.name },
			);
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

function valuesOutput(
	values: UserDataValues | undefined,
	properties: Record<string, UserProperty>,
	propertyOrder: ReadonlyMap<string, number>,
) {
	return Object.entries(values ?? {})
		.sort(
			([left], [right]) =>
				(propertyOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
					(propertyOrder.get(right) ?? Number.MAX_SAFE_INTEGER) ||
				left.localeCompare(right),
		)
		.map(([userPropertyUuid, value]) => ({
			userPropertyUuid,
			slug: properties[userPropertyUuid]?.slug,
			value,
		}));
}

export const getUsersTool = {
	description:
		"Read the app's worker information, roles, and personas with stable uuids for follow-up edits.",
	inputSchema: getUsersInputSchema,
	async execute(
		_input: z.infer<typeof getUsersInputSchema>,
		_ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<
		ReadToolResult<{
			workerInformation: UserProperty[];
			roles: Array<
				Omit<UserType, "values"> & {
					values: ReturnType<typeof valuesOutput>;
				}
			>;
			personas: Array<
				Omit<Persona, "values"> & {
					values: ReturnType<typeof valuesOutput>;
				}
			>;
		}>
	> {
		const properties = userPropertiesOf(doc);
		const workerInformation = Object.values(properties).sort(bySortKey);
		const propertyOrder = new Map(
			workerInformation.map((property, index) => [property.uuid, index]),
		);
		return {
			kind: "read",
			data: {
				workerInformation,
				roles: Object.values(userTypesOf(doc))
					.sort(bySortKey)
					.map(({ values, ...role }) => ({
						...role,
						values: valuesOutput(values, properties, propertyOrder),
					})),
				personas: Object.values(personasOf(doc))
					.sort(bySortKey)
					.map(({ values, ...persona }) => ({
						...persona,
						values: valuesOutput(values, properties, propertyOrder),
					})),
			},
		};
	},
};
