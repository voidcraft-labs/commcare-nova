/**
 * SA tool: `generateSchema` — record the app's data model (the
 * case-type catalog) ON the app, in one gated batch.
 *
 * It commits the design's structural skeleton: per case type,
 * `declareCaseType` → `setCaseTypeMeta` (parent link) → one
 * `addCaseProperty` per property. From then on the catalog is doc
 * state: `createModule` references a case type by NAME, and the field
 * assembly's catalog defaulting (`applyDefaults`) seeds every
 * case-bound field's label / hint / options / validation from the
 * record — the model is stated once, here, and inherited everywhere.
 *
 * The app's NAME is deliberately not an input: naming lives on
 * `updateApp` alone. A required name here would force an existing
 * app's callers to echo the current name to keep it — one paraphrase
 * and the app silently renames as a side effect of declaring a case
 * type. One slot, one home, no echo contract.
 *
 * Committing records AHEAD of their modules is legal by design: the
 * every-written-type-needs-a-module rule (MISSING_CHILD_CASE_MODULE)
 * keys on form WRITERS, not on the catalog, so a planned record sits
 * clean until a form actually creates cases of it.
 *
 * Additive over AUTHORED content: a later call may append genuinely new
 * properties to an existing record, but it can never replace an existing
 * property or change the record's parent relation. This lets a bounded build
 * lower one large record catalog over several semantic groups without making
 * the first group an all-or-nothing size trap. A bare, chokepoint-declared
 * record (a module case-type flip or a field write landed before the model was
 * recorded) is ENRICHED in place instead (`setCaseProperty` /
 * `setCaseTypeMeta`). In edit mode the tool can therefore introduce a new
 * case type or append new modeled properties to an existing one.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolInvocationContext` interface.
 */

import { z } from "zod";
import { deepEqual } from "@/lib/doc/deepEqual";
import type { Mutation } from "@/lib/doc/types";
import type { CaseType } from "@/lib/domain";
import { caseTypesOutputSchema, cleanCaseTypeRecord } from "../planningSchemas";
import type { ToolInvocationContext } from "../workspace/types";
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
		caseTypes: caseTypesOutputSchema.shape.case_types,
	})
	.strict();

export type GenerateSchemaInput = z.infer<typeof generateSchemaInputSchema>;

/** Human-readable success string or an error record. */
export type GenerateSchemaResult = MutationSuccess | { error: string };

export const generateSchemaTool = {
	description:
		"Record the app's data model onto the app. A call may declare complete new case types or append genuinely new properties to an existing authored type; it never replaces an existing property or changes an existing parent relation. When extending a type, pass only the new property definitions. A bare auto-declared type is filled in. createModule then references a case type by name, and fields writing a recorded property inherit its label, options, and validation.",
	inputSchema: generateSchemaInputSchema,
	async execute(
		input: GenerateSchemaInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<GenerateSchemaResult>> {
		const doc = ctx.snapshot.doc;
		try {
			// One entry per type name WITHIN the call — two entries for the same
			// name would otherwise silently merge (declare no-ops, properties
			// land first-wins, a later entry's parent link overwrites) into a
			// chimera record no single entry described.
			const seenInInput = new Set<string>();
			const dupInInput = new Set<string>();
			for (const ct of input.caseTypes) {
				if (seenInInput.has(ct.name)) dupInInput.add(ct.name);
				seenInInput.add(ct.name);
			}
			if (dupInInput.size > 0) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: `Nothing was recorded — the call lists ${[...dupInInput]
							.map((d) => `"${d}"`)
							.join(
								", ",
							)} more than once. Each case type is one entry; merge the duplicates into a single record and re-issue.`,
					},
				};
			}

			// A BARE record (the declaration chokepoint's shape: no parent meta,
			// every property exactly the auto-registered
			// `{name, label: name, data_type?}`) carries nothing authored, so the
			// call ENRICHES it in place. An authored record accepts new properties
			// only. Existing definitions remain immutable through this add path.
			const existingByName = new Map(
				(doc.caseTypes ?? []).map((ct) => [ct.name, ct]),
			);
			const isBare = (ct: CaseType): boolean =>
				ct.parent_type === undefined &&
				ct.relationship === undefined &&
				ct.properties.every(
					(p) =>
						p.label.parts.length === 1 &&
						p.label.parts[0]?.kind === "text" &&
						p.label.parts[0].text === p.name &&
						p.hint === undefined &&
						p.required === undefined &&
						p.validation === undefined &&
						p.validation_msg === undefined &&
						p.options === undefined,
				);
			const conflicts: string[] = [];
			const cleanedByName = new Map(
				input.caseTypes.map((raw) => {
					const record = cleanCaseTypeRecord(raw) as CaseType;
					return [record.name, record] as const;
				}),
			);
			for (const record of cleanedByName.values()) {
				const existing = existingByName.get(record.name);
				if (existing === undefined || isBare(existing)) continue;
				if (
					(record.parent_type !== undefined &&
						record.parent_type !== existing.parent_type) ||
					(record.relationship !== undefined &&
						record.relationship !== existing.relationship)
				) {
					conflicts.push(`"${record.name}" has a different parent relation`);
				}
				const existingProperties = new Map(
					existing.properties.map((property) => [property.name, property]),
				);
				for (const property of record.properties) {
					const prior = existingProperties.get(property.name);
					if (prior !== undefined && !deepEqual(prior, property)) {
						conflicts.push(
							`"${record.name}.${property.name}" already exists with a different definition`,
						);
					}
				}
			}
			if (conflicts.length > 0) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: `Nothing was recorded — ${conflicts.join(
							"; ",
						)}. Existing record definitions are immutable through this add path. Pass only genuinely new properties, or use the specific editing operation for an intentional change.`,
					},
				};
			}

			const mutations: Mutation[] = [];
			const enriched: string[] = [];
			const extended: string[] = [];
			for (const record of cleanedByName.values()) {
				const existing = existingByName.get(record.name);
				const bareExisting = existing !== undefined && isBare(existing);
				const authoredExisting = existing !== undefined && !bareExisting;
				if (bareExisting) enriched.push(record.name);
				if (authoredExisting) extended.push(record.name);
				if (existing === undefined) {
					mutations.push({ kind: "declareCaseType", caseType: record.name });
				}
				if (
					!authoredExisting &&
					(record.parent_type != null || record.relationship != null)
				) {
					mutations.push({
						kind: "setCaseTypeMeta",
						caseType: record.name,
						parent_type: record.parent_type ?? null,
						relationship: record.relationship ?? null,
					});
				}
				for (const property of record.properties) {
					const existingProperty = existing?.properties.find(
						(candidate) => candidate.name === property.name,
					);
					if (authoredExisting && existingProperty !== undefined) continue;
					mutations.push(
						// `setCaseProperty` replaces a bare auto-registered property
						// by name (and appends a new one); `addCaseProperty` would
						// first-wins no-op against it and silently drop the authored
						// detail. Auto-registered properties the call doesn't restate
						// survive — declared properties outlive their writers.
						bareExisting
							? { kind: "setCaseProperty", caseType: record.name, property }
							: { kind: "addCaseProperty", caseType: record.name, property },
					);
				}
			}
			if (mutations.length === 0) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error:
							"Nothing was recorded — every supplied case type and property already exists with the same definition. Pass only properties that are not yet in the recorded model.",
					},
				};
			}

			const commit = await guardedMutate(ctx, mutations, "schema");
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			}

			const typeNames = input.caseTypes.map((ct) => ct.name);
			const propertyCount = input.caseTypes.reduce(
				(n, ct) => n + ct.properties.length,
				0,
			);
			const summary: ToolCallSummary = {
				subject: typeNames.join(", "),
				count: input.caseTypes.length,
			};
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message: `Recorded the data model: ${typeNames.length} case type${typeNames.length === 1 ? "" : "s"} (${typeNames.join(", ")}) with ${propertyCount} supplied properties.${enriched.length > 0 ? ` ${enriched.map((n) => `"${n}"`).join(", ")} existed as a bare declaration and now carries the recorded model.` : ""}${extended.length > 0 ? ` Added new properties to ${extended.map((n) => `"${n}"`).join(", ")} without changing its existing definitions.` : ""} createModule now references these by name; fields writing a recorded property inherit its label, options, and validation.`,
					summary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
