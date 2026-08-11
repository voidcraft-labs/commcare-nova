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
import { setPersonaLocationsMutations } from "@/lib/doc/organizationMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	addPersonaMutations,
	addUserPropertyMutations,
	addUserTypeMutations,
	removePersonaMutations,
	removeUserPropertyPlan,
	removeUserTypePlan,
	updatePersonaMutations,
	updatePersonaValueMutations,
	updateUserTypeMutations,
	updateUserTypeValueMutations,
} from "@/lib/doc/userMutations";
import {
	assignedLocationUuids,
	asUuid,
	orderedPersonas,
	orderedUserProperties,
	orderedUserTypes,
	ownRecordValue,
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
import type { ToolInvocationContext } from "../workspace/types";
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
	})
	.describe(
		"Initial UUID-addressed values for a newly created role or persona.",
	);

type ValuesInput = z.infer<typeof valuesInputSchema>;

const valuePatchInputSchema = z
	.object({
		userPropertyUuid: uuidSchema.describe(
			"Stable uuid of the one worker-information property to change.",
		),
		value: z
			.string()
			.nullable()
			.describe("New value, or null to clear this one property."),
	})
	.strict()
	.optional()
	.describe(
		"One UUID-addressed value edit. Omit to leave all values unchanged; use a null value to clear only the named property.",
	);

function valuesRecord(
	entries: ValuesInput | undefined,
): UserDataValues | undefined {
	if (entries === undefined) return undefined;
	return Object.fromEntries(
		entries.map((entry) => [entry.userPropertyUuid, entry.value]),
	);
}

const acceptedValuesSchema = z
	.array(z.string().min(1))
	.min(1)
	.superRefine((choices, ctx) => {
		const seen = new Set<string>();
		for (const [index, choice] of choices.entries()) {
			if (!seen.has(choice)) {
				seen.add(choice);
				continue;
			}
			ctx.addIssue({
				code: "custom",
				path: [index],
				message: "Each accepted value may appear only once.",
			});
		}
	});

const userPropertyCreateSchema = z
	.object({
		userPropertyUuid: uuidSchema
			.optional()
			.describe(
				"Optional stable identity for this new worker-information property. Omit it to let Nova mint one.",
			),
		slug: z
			.string()
			.min(1)
			.max(USER_PROPERTY_SLUG_MAX_LENGTH)
			.regex(USER_PROPERTY_SLUG_PATTERN)
			.describe(
				"Saved name expressions read. Start with a letter or underscore; then use letters, digits, underscores, or hyphens. The commit gate also checks reserved names.",
			),
		label: z
			.string()
			.min(1)
			.max(USER_PROPERTY_LABEL_MAX_LENGTH)
			.describe("Name authors and administrators see."),
		required: z.boolean().nullable().optional(),
		choices: acceptedValuesSchema.nullable().optional(),
	})
	.strict();

const userTypeCreateSchema = z
	.object({
		userTypeUuid: uuidSchema
			.optional()
			.describe(
				"Optional stable identity for this new role. Omit it to let Nova mint one.",
			),
		name: z.string().min(1),
		description: z.string().min(1).nullable().optional(),
		values: valuesInputSchema.nullable().optional(),
	})
	.strict();

const personaLocationUuidsSchema = z
	.array(uuidSchema)
	.min(1)
	.superRefine((uuids, ctx) => {
		if (new Set(uuids).size !== uuids.length) {
			ctx.addIssue({
				code: "custom",
				message:
					"List each place once; the first place is already the primary.",
			});
		}
	});

const personaCreateSchema = z
	.object({
		personaUuid: uuidSchema
			.optional()
			.describe(
				"Optional stable identity for this new Preview persona. Omit it to let Nova mint one.",
			),
		name: z.string().min(1),
		description: z.string().min(1).nullable().optional(),
		userTypeUuid: uuidSchema.nullable().optional(),
		values: valuesInputSchema.nullable().optional(),
		locationUuids: personaLocationUuidsSchema
			.nullable()
			.optional()
			.describe(
				"Places this persona works, primary first. Use stable location uuids returned by getOrganization.",
			),
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
		choices: acceptedValuesSchema.nullable().optional(),
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
		valuePatch: valuePatchInputSchema,
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
		valuePatch: valuePatchInputSchema,
		locationUuids: personaLocationUuidsSchema
			.nullable()
			.optional()
			.describe(
				"Replace this persona's places, primary first; null clears the assignment.",
			),
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
	ctx: ToolInvocationContext,
	mutations: Mutation[],
	stage: string,
	message: string,
	summary: ToolCallSummary,
): Promise<MutatingToolResult<MutationResult>> {
	const outcome = await guardedMutate(ctx, mutations, stage);
	if (!outcome.ok) {
		return {
			kind: "mutate",
			mutations: [],
			result: { error: outcome.error },
		};
	}
	return {
		kind: "mutate",
		mutations: outcome.mutations,
		result: { message, summary },
	};
}

export const addUserPropertiesTool = {
	description:
		"Add one or more worker-information properties. Returns stable uuids for role and persona values. During an initial build, call this immediately after updateApp and before generateSchema, createModule, or any other call that authors a condition, calculation, module, or form which may reference custom worker information.",
	inputSchema: addUserPropertiesInputSchema,
	async execute(
		input: z.infer<typeof addUserPropertiesInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<AddMutationResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const uuids = input.properties.map(
				(property) => property.userPropertyUuid ?? asUuid(crypto.randomUUID()),
			);
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
				mutations,
				"users:workerInformation:add",
			);
			if (!outcome.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: outcome.error },
				};
			}
			return {
				kind: "mutate",
				mutations: outcome.mutations,
				result: {
					message: `Added ${uuids.length} worker-information ${uuids.length === 1 ? "property" : "properties"}. Stable uuids: ${uuids.join(", ")}.`,
					uuids,
					summary: { count: uuids.length },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const updateUserPropertyTool = {
	description:
		"Update one worker-information property by stable uuid. Omit to keep; null clears required or accepted values.",
	inputSchema: updateUserPropertyInputSchema,
	async execute(
		input: z.infer<typeof updateUserPropertyInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const current = ownRecordValue(userPropertiesOf(doc), input.uuid);
			if (current === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					result: missing("Worker-information property", input.uuid),
				};
			}
			const { uuid, ...patch } = input;
			if (Object.keys(patch).length === 0) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: "Nothing to change." },
				};
			}
			return await commit(
				ctx,
				[{ kind: "updateUserProperty", uuid, patch }],
				"users:workerInformation:update",
				`Updated worker information "${current.label}".`,
				{ subject: current.label },
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const removeUserPropertyTool = {
	description:
		"Remove worker information by stable uuid, atomically clearing its values from every role and persona. Refuses while any XPath, condition, or calculation references the property; update those references first.",
	inputSchema: removeUserPropertyInputSchema,
	async execute(
		input: z.infer<typeof removeUserPropertyInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const current = ownRecordValue(userPropertiesOf(doc), input.uuid);
			if (current === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					result: missing("Worker-information property", input.uuid),
				};
			}
			const plan = removeUserPropertyPlan(doc, input.uuid);
			if (!plan.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: plan.userMessage },
				};
			}
			return await commit(
				ctx,
				plan.mutations,
				"users:workerInformation:remove",
				`Removed worker information "${current.label}" and its recorded role/persona values.`,
				{ subject: current.label },
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const addUserTypesTool = {
	description:
		"Add one or more reusable worker roles. Value entries target worker information by stable uuid.",
	inputSchema: addUserTypesInputSchema,
	async execute(
		input: z.infer<typeof addUserTypesInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<AddMutationResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const uuids = input.userTypes.map(
				(userType) => userType.userTypeUuid ?? asUuid(crypto.randomUUID()),
			);
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
			const outcome = await guardedMutate(ctx, mutations, "users:role:add");
			if (!outcome.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: outcome.error },
				};
			}
			return {
				kind: "mutate",
				mutations: outcome.mutations,
				result: {
					message: `Added ${uuids.length} ${uuids.length === 1 ? "role" : "roles"}. Stable uuids: ${uuids.join(", ")}.`,
					uuids,
					summary: { count: uuids.length },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const updateUserTypeTool = {
	description:
		"Update one role by stable uuid. valuePatch changes or clears one UUID-addressed worker-information value; omission leaves every value unchanged.",
	inputSchema: updateUserTypeInputSchema,
	async execute(
		input: z.infer<typeof updateUserTypeInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const current = ownRecordValue(userTypesOf(doc), input.uuid);
			if (current === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					result: missing("Role", input.uuid),
				};
			}
			const patch = {
				...(input.name !== undefined && { name: input.name }),
				...(input.description !== undefined && {
					description: input.description,
				}),
			};
			const mutations = updateUserTypeMutations(doc, input.uuid, patch);
			if (input.valuePatch !== undefined) {
				mutations.push(
					...updateUserTypeValueMutations(
						doc,
						input.uuid,
						input.valuePatch.userPropertyUuid,
						input.valuePatch.value ?? undefined,
					),
				);
			}
			if (mutations.length === 0) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: "Nothing to change." },
				};
			}
			return await commit(
				ctx,
				mutations,
				"users:role:update",
				`Updated role "${current.name}".`,
				{ subject: current.name },
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const removeUserTypeTool = {
	description:
		"Remove a role by stable uuid. Refused while any persona still uses it.",
	inputSchema: removeUserTypeInputSchema,
	async execute(
		input: z.infer<typeof removeUserTypeInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const current = ownRecordValue(userTypesOf(doc), input.uuid);
			if (current === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					result: missing("Role", input.uuid),
				};
			}
			const plan = removeUserTypePlan(doc, input.uuid);
			if (!plan.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: plan.userMessage },
				};
			}
			return await commit(
				ctx,
				plan.mutations,
				"users:role:remove",
				`Removed role "${current.name}".`,
				{ subject: current.name },
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const addPersonasTool = {
	description:
		"Add one or more named Preview workers. Roles and worker-information values use stable uuids.",
	inputSchema: addPersonasInputSchema,
	async execute(
		input: z.infer<typeof addPersonasInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<AddMutationResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const uuids = input.personas.map(
				(persona) => persona.personaUuid ?? asUuid(crypto.randomUUID()),
			);
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
				if (persona.locationUuids !== undefined) {
					next.push(
						...setPersonaLocationsMutations(
							uuids[index],
							persona.locationUuids ?? [],
						),
					);
				}
				mutations.push(...next);
				cursor = applyToDoc(cursor, next);
			}
			const outcome = await guardedMutate(ctx, mutations, "users:persona:add");
			if (!outcome.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: outcome.error },
				};
			}
			return {
				kind: "mutate",
				mutations: outcome.mutations,
				result: {
					message: `Added ${uuids.length} ${uuids.length === 1 ? "persona" : "personas"}. Stable uuids: ${uuids.join(", ")}.`,
					uuids,
					summary: { count: uuids.length },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const updatePersonaTool = {
	description:
		"Update one Preview persona by stable uuid. valuePatch changes or clears one UUID-addressed override; omission leaves every override unchanged.",
	inputSchema: updatePersonaInputSchema,
	async execute(
		input: z.infer<typeof updatePersonaInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const current = ownRecordValue(personasOf(doc), input.uuid);
			if (current === undefined) {
				return {
					kind: "mutate",
					mutations: [],
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
			};
			const mutations = updatePersonaMutations(doc, input.uuid, patch);
			if (input.valuePatch !== undefined) {
				mutations.push(
					...updatePersonaValueMutations(
						doc,
						input.uuid,
						input.valuePatch.userPropertyUuid,
						input.valuePatch.value ?? undefined,
					),
				);
			}
			if (input.locationUuids !== undefined) {
				mutations.push(
					...setPersonaLocationsMutations(
						input.uuid,
						input.locationUuids ?? [],
					),
				);
			}
			if (mutations.length === 0) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: "Nothing to change." },
				};
			}
			return await commit(
				ctx,
				mutations,
				"users:persona:update",
				`Updated persona "${current.name}".`,
				{ subject: current.name },
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const removePersonaTool = {
	description:
		"Remove a Preview persona by stable uuid. Existing cases it owns are preserved.",
	inputSchema: removePersonaInputSchema,
	async execute(
		input: z.infer<typeof removePersonaInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const current = ownRecordValue(personasOf(doc), input.uuid);
			if (current === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					result: missing("Persona", input.uuid),
				};
			}
			return await commit(
				ctx,
				removePersonaMutations(input.uuid),
				"users:persona:remove",
				`Removed persona "${current.name}". The cases it already owned were preserved.`,
				{ subject: current.name },
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

function valuesOutput(
	values: UserDataValues | undefined,
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
			value,
		}));
}

export const getUsersTool = {
	description:
		"Read the app's worker information, roles, and personas with stable uuids for follow-up edits.",
	inputSchema: getUsersInputSchema,
	async execute(
		_input: z.infer<typeof getUsersInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<
		ReadToolResult<{
			workerInformation: UserProperty[];
			roles: Array<
				Omit<UserType, "values"> & {
					values: ReturnType<typeof valuesOutput>;
				}
			>;
			personas: Array<
				Omit<Persona, "locations" | "values"> & {
					values: ReturnType<typeof valuesOutput>;
					locationUuids?: readonly string[];
				}
			>;
		}>
	> {
		const doc = ctx.snapshot.doc;
		const _properties = userPropertiesOf(doc);
		const workerInformation = orderedUserProperties(doc);
		const propertyOrder = new Map(
			workerInformation.map((property, index) => [property.uuid, index]),
		);
		return {
			kind: "read",
			data: {
				workerInformation,
				roles: orderedUserTypes(doc).map(({ values, ...role }) => ({
					...role,
					values: valuesOutput(values, propertyOrder),
				})),
				personas: orderedPersonas(doc).map(
					({ locations, values, ...persona }) => ({
						...persona,
						values: valuesOutput(values, propertyOrder),
						...(locations === undefined
							? {}
							: { locationUuids: assignedLocationUuids(locations) }),
					}),
				),
			},
		};
	},
};
