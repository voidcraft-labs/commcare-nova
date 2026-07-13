/**
 * SA tool: `generateSchema` — record the app's data model (name +
 * case-type catalog) ON the app, in one gated batch.
 *
 * The first tool call of a new build, after the SA has reasoned the
 * whole design through and written it to the user. It commits the
 * design's structural skeleton: `setAppName` (when the name is new or
 * changed) plus, per case type, `declareCaseType` → `setCaseTypeMeta`
 * (parent link) → one `addCaseProperty` per property. From then on the
 * catalog is doc state: `createModule` references a case type by NAME,
 * and the field assembly's catalog defaulting (`applyDefaults`) seeds
 * every case-bound field's label / hint / options / validation from the
 * record — the model is stated once, here, and inherited everywhere.
 *
 * Committing records AHEAD of their modules is legal by design: the
 * every-written-type-needs-a-module rule (MISSING_CHILD_CASE_MODULE)
 * keys on form WRITERS, not on the catalog, so a planned record sits
 * clean until a form actually creates cases of it.
 *
 * Additive only: a case type the app already carries is rejected —
 * re-declaring would silently replace the record other fields' defaults
 * were seeded from. In edit mode this is how a NEW case type enters the
 * app (declare it here, then create its module).
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface.
 */

import { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, CaseType } from "@/lib/domain";
import { caseTypesOutputSchema, cleanCaseTypeRecord } from "../planningSchemas";
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

export const generateSchemaInputSchema = z
	.object({
		appName: z
			.string()
			.min(1)
			.describe(
				"Short app name (2-5 words). On an existing app, pass the current name to keep it.",
			),
		caseTypes: caseTypesOutputSchema.shape.case_types,
	})
	.strict();

export type GenerateSchemaInput = z.infer<typeof generateSchemaInputSchema>;

/** Human-readable success string or an error record. */
export type GenerateSchemaResult = MutationSuccess | { error: string };

export const generateSchemaTool = {
	description:
		"Record the app's data model — its name and every case type with its properties — onto the app, in one call. The first call of a build (after the design is reasoned through); also how a NEW case type enters an existing app. Case types the app already carries are rejected — pass only new ones. createModule then references a case type by name, and fields writing a recorded property inherit its label, options, and validation.",
	inputSchema: generateSchemaInputSchema,
	async execute(
		input: GenerateSchemaInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<GenerateSchemaResult>> {
		try {
			const existing = new Set((doc.caseTypes ?? []).map((ct) => ct.name));
			const duplicates = input.caseTypes
				.map((ct) => ct.name)
				.filter((name) => existing.has(name));
			if (duplicates.length > 0) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Nothing was recorded — the app already has a record for ${duplicates
							.map((d) => `"${d}"`)
							.join(
								", ",
							)}. This tool only ADDS case types; re-declaring one would replace the record existing fields were seeded from. Re-issue with only the new case types.`,
					},
				};
			}

			const mutations: Mutation[] = [];
			const renaming = doc.appName !== "" && doc.appName !== input.appName;
			if (doc.appName !== input.appName) {
				mutations.push({ kind: "setAppName", name: input.appName });
			}
			for (const raw of input.caseTypes) {
				// Collapse the record's null slots to absence BEFORE it touches
				// the catalog — a null hint/parent_type on a stored CaseProperty
				// fails the next load's Zod gate.
				const record = cleanCaseTypeRecord(raw) as CaseType;
				mutations.push({ kind: "declareCaseType", caseType: record.name });
				if (record.parent_type != null || record.relationship != null) {
					mutations.push({
						kind: "setCaseTypeMeta",
						caseType: record.name,
						parent_type: record.parent_type ?? null,
						relationship: record.relationship ?? null,
					});
				}
				for (const property of record.properties) {
					mutations.push({
						kind: "addCaseProperty",
						caseType: record.name,
						property,
					});
				}
			}

			const commit = await guardedMutate(ctx, doc, mutations, "schema");
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: commit.error },
				};
			}

			const typeNames = input.caseTypes.map((ct) => ct.name);
			const propertyCount = input.caseTypes.reduce(
				(n, ct) => n + ct.properties.length,
				0,
			);
			const summary: ToolCallSummary = {
				subject: input.appName,
				count: input.caseTypes.length,
				...(doc.appName !== input.appName && {
					nameChange: renaming ? "renamed" : "named",
				}),
			};
			return {
				kind: "mutate" as const,
				mutations,
				newDoc: commit.newDoc,
				result: {
					message: `Recorded the data model on "${input.appName}": ${typeNames.length} case type${typeNames.length === 1 ? "" : "s"} (${typeNames.join(", ")}) with ${propertyCount} properties. createModule now references these by name; fields writing a recorded property inherit its label, options, and validation.`,
					summary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
