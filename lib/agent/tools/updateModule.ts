/**
 * SA tool: `updateModule` — patch module-level metadata.
 *
 * Covers the three module-scoped edits the SA exposes: display name,
 * case list columns, and case detail columns. Both the SA chat factory
 * and the MCP adapter call this through the shared
 * `ToolExecutionContext` interface. The `case_detail_columns` key
 * supports `null` as "clear" — matches the store's
 * `updateModuleMutations` convention for nullable columns.
 *
 * Three exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Module disappeared between resolution and patch (shouldn't
 *      happen under normal flow) → `{ error }`.
 *   3. Success → human-readable summary listing the changed keys,
 *      tagged `module:M`.
 */

import { z } from "zod";
import { type BlueprintDoc, plainColumn } from "@/lib/domain";
import { updateModuleMutations } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "./common";

export const updateModuleInputSchema = z.object({
	moduleIndex: z.number().describe("0-based module index"),
	name: z.string().optional().describe("New module name"),
	case_list_columns: z
		.array(
			z.object({
				field: z.string().describe("Case property name"),
				header: z.string().describe("Column header text"),
			}),
		)
		.optional()
		.describe("New case list columns"),
	case_detail_columns: z
		.array(
			z.object({
				field: z.string().describe("Case property name"),
				header: z.string().describe("Display label for this detail field"),
			}),
		)
		.nullable()
		.optional()
		.describe("Columns for case detail view. null to remove."),
});

export type UpdateModuleInput = z.infer<typeof updateModuleInputSchema>;

/** Human-readable success string or an error record. */
export type UpdateModuleResult = string | { error: string };

export const updateModuleTool = {
	description:
		"Update module metadata: name, case list columns, or case detail columns.",
	inputSchema: updateModuleInputSchema,
	async execute(
		input: UpdateModuleInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<UpdateModuleResult>> {
		const { moduleIndex, name, case_list_columns, case_detail_columns } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: `Module ${moduleIndex} not found` },
				};
			}

			// Build the helper patch lazily — every omitted key stays
			// out so the reducer's `undefined`-means-leave-alone semantics
			// hold. `null` on `case_detail_columns` is a value, not an
			// absence: it maps to the helper's "clear" signal (the
			// `detailColumns` slot inside `caseListConfig` becomes
			// absent).
			//
			// The SA-facing input keeps the legacy `{field, header}[]`
			// shape. When either columns key is supplied this layer
			// builds a fresh `caseListConfig` snapshot from the
			// existing module (preserving any author-side sort /
			// filter / calculated / search authoring that
			// downstream tools have written) and replaces the column
			// arrays in place.
			const existingConfig = doc.modules[moduleUuid]?.caseListConfig;
			const baseConfig = existingConfig ?? {
				columns: [],
				sort: [],
				calculatedColumns: [],
				searchInputs: [],
			};
			const patch: Parameters<typeof updateModuleMutations>[2] = {};
			if (name !== undefined) patch.name = name;
			if (
				case_list_columns !== undefined ||
				case_detail_columns !== undefined
			) {
				// SA-input shape is intentionally lossy. The SA's
				// `case_list_columns` schema is `{field, header}[]` —
				// a flat-text shape that maps to `kind: "plain"` columns
				// only. When an SA `updateModule` arrives with a fresh
				// columns list, structured kinds previously authored
				// through the column editor (Date / Phone / Late Flag /
				// ID Mapping / Time-Since-Until / Search-Only) are
				// flattened into plain columns. The success summary
				// counts the post-flatten plain columns; the SA receives
				// no signal that structured authoring was discarded.
				// The tradeoff is intentional — exposing the full
				// discriminated-union to the SA blows past the Anthropic
				// schema-compiler's 8-optional ceiling per array item
				// (per root CLAUDE.md "Structured output constraint")
				// and would force a breaking change on every existing SA
				// conversation. Authors who want structured kinds use
				// the column editor directly.
				const nextColumns =
					case_list_columns !== undefined
						? case_list_columns.map((col) => plainColumn(col.field, col.header))
						: baseConfig.columns;
				let nextDetail: typeof baseConfig.detailColumns;
				if (case_detail_columns === null) {
					// `null` clears the long-detail override; absent ≡
					// "long detail mirrors short detail".
					nextDetail = undefined;
				} else if (case_detail_columns !== undefined) {
					nextDetail = case_detail_columns.map((col) =>
						plainColumn(col.field, col.header),
					);
				} else {
					nextDetail = baseConfig.detailColumns;
				}
				patch.caseListConfig = {
					...baseConfig,
					columns: nextColumns,
					...(nextDetail !== undefined && { detailColumns: nextDetail }),
				};
			}

			const mutations = updateModuleMutations(doc, moduleUuid, patch);
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(mutations, newDoc, `module:${moduleIndex}`);

			// Read back from the post-mutation doc so the summary reflects the
			// values the SA can expect on a follow-up read.
			const mod = newDoc.modules[moduleUuid];
			if (!mod) {
				return {
					kind: "mutate" as const,
					mutations,
					newDoc,
					result: { error: `Module ${moduleIndex} not found after update` },
				};
			}
			const changes: string[] = [];
			if (name !== undefined) changes.push(`name → "${mod.name}"`);
			if (case_list_columns !== undefined)
				changes.push(
					`case list columns (${mod.caseListConfig?.columns.length ?? 0})`,
				);
			if (case_detail_columns !== undefined)
				changes.push(
					case_detail_columns === null
						? "case detail columns removed"
						: `case detail columns (${mod.caseListConfig?.detailColumns?.length ?? 0})`,
				);
			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: `Successfully updated module "${mod.name}" (index ${moduleIndex}). Changed: ${changes.join(", ")}.`,
			};
		} catch (err) {
			return {
				kind: "mutate" as const,
				mutations: [],
				newDoc: doc,
				result: { error: err instanceof Error ? err.message : String(err) },
			};
		}
	},
};
