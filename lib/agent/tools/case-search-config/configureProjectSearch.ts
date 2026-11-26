import { z } from "zod";
import { projectSearchEditBatch } from "@/lib/doc/projectSearchEdits";
import { valueSchema } from "@/lib/domain/expression/types";
import { asUuid, uuidSchema } from "@/lib/domain/uuid";
import type { ToolInvocationContext } from "../../workspace/types";
import { newUuid } from "../case-list-config/shared";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import {
	moduleAddressSchema,
	resolveModuleAddress,
} from "../shared/entityAddresses";

const inputSchema = moduleAddressSchema
	.extend({
		change: z.discriminatedUnion("kind", [
			z.strictObject({
				kind: z.literal("project"),
				search: z.union([
					z.strictObject({
						kind: z.literal("create"),
						name: z.string().trim().min(1),
					}),
					z.strictObject({ kind: z.literal("existing"), uuid: uuidSchema }),
					z.strictObject({
						kind: z.literal("named"),
						name: z.string().trim().min(1),
					}),
				]),
				parameters: z.array(
					z.strictObject({
						uuid: uuidSchema.optional(),
						name: z.string().min(1),
						value: valueSchema,
					}),
				),
				replaceFieldMatching: z.boolean(),
			}),
			z.strictObject({
				kind: z.literal("rename"),
				uuid: uuidSchema,
				name: z.string().trim().min(1),
			}),
			z.strictObject({ kind: z.literal("remove"), uuid: uuidSchema }),
			z.strictObject({
				kind: z.literal("ordinary"),
				fields: z.array(
					z.strictObject({
						fieldUuid: uuidSchema,
						property: z.string().min(1),
					}),
				),
			}),
		]),
	})
	.strict();

export const configureProjectSearchTool = {
	description:
		"Choose who finds a menu's cases. A search supplied by the project space receives the menu's answers and ordered named values, then returns its own matches. Create a search, or reuse one from getModule's available_project_searches by its name or UUID. Supply all named values in order, including an existing value's UUID when editing it. Only replace existing field matching if the person wants the project space to decide matches. To return to ordinary search, choose a case property for each visible parameter field. Rename a logical search by its UUID or remove it after its last menu switches away. Connect the destination's numeric search ID separately when publishing.",
	inputSchema,
	async execute(
		input: z.infer<typeof inputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<unknown>> {
		try {
			const address = resolveModuleAddress(ctx.snapshot.doc, input);
			if (!address.ok)
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: address.error },
				};
			const change = input.change;
			let edit: Parameters<typeof projectSearchEditBatch>[2];
			if (change.kind === "project") {
				const requested = change.search;
				let destination: Extract<
					typeof edit,
					{ kind: "project" }
				>["destination"];
				if (requested.kind === "create")
					destination = { ...requested, uuid: newUuid() };
				else if (requested.kind === "existing") destination = requested;
				else {
					const matches = Object.entries(
						ctx.snapshot.doc.appSettings.projectSearches ?? {},
					).filter(([, search]) => search.name === requested.name);
					if (matches.length !== 1)
						throw new Error(
							"Choose the search by its UUID from the menu's available searches.",
						);
					destination = { kind: "existing", uuid: asUuid(matches[0][0]) };
				}
				edit = {
					kind: "project",
					destination,
					defaults: change.parameters.map((row) => ({
						...row,
						uuid: row.uuid ?? newUuid(),
					})),
					replaceFieldMatching: change.replaceFieldMatching,
				};
			} else if (change.kind === "ordinary") {
				edit = {
					kind: "ordinary",
					properties: new Map(
						change.fields.map((field) => [field.fieldUuid, field.property]),
					),
				};
			} else edit = change;
			const batch = projectSearchEditBatch(
				ctx.snapshot.doc,
				address.moduleUuid,
				edit,
			);
			const commit = await guardedMutate(
				ctx,
				batch,
				`module:${address.moduleUuid}:caseSearch:source`,
			);
			if (!commit.ok)
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					ok: true as const,
					searchUuid: edit.kind === "project" ? edit.destination.uuid : null,
					parameters:
						edit.kind === "project"
							? edit.defaults.map(({ uuid, name }) => ({ uuid, name }))
							: [],
					summary: { location: address.module.name },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
