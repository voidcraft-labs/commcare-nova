/**
 * SA tool: `setCalculatedColumns` — replace the calculated column
 * array on a module's case list.
 *
 * Accepts the typed `CalculatedColumn[]` shape directly. Each
 * calculated column carries a stable `id` (referenced by sort keys
 * and the live-preview projection), a `header`, a typed
 * `ValueExpression`, and an optional per-column `sort` config.
 * Calculated columns produce derived per-row values (e.g. "days
 * since last visit", "concatenated full name") that the wire
 * emitter lowers into a Postgres expression / on-device XPath /
 * CSQL fragment.
 *
 * Wholesale replacement: the supplied array fully replaces the
 * module's `caseListConfig.calculatedColumns` slot. An empty array
 * removes every calculated column.
 *
 * Both the SA chat factory and the MCP adapter call this through
 * the shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → human-readable summary, tagged
 *      `module:M:calculatedColumns`.
 */

import { z } from "zod";
import { type BlueprintDoc, calculatedColumnSchema } from "@/lib/domain";
import { updateModuleMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { baseCaseListConfig } from "./shared";

export const setCalculatedColumnsInputSchema = z.object({
	moduleIndex: z
		.number()
		.describe("0-based module index whose calculated columns to replace"),
	calculatedColumns: z
		.array(calculatedColumnSchema)
		.describe(
			"Replacement calculated column array. Each entry is a CalculatedColumn AST node — `id` (stable identifier referenced by sort keys + live-preview projection), `header` (column header text), `expression` (typed ValueExpression that yields the per-row derived value), and optional `sort` config. The provided array replaces the module's calculated columns wholesale.",
		),
});

export type SetCalculatedColumnsInput = z.infer<
	typeof setCalculatedColumnsInputSchema
>;

/** Human-readable success string or an error record. */
export type SetCalculatedColumnsResult = string | { error: string };

export const setCalculatedColumnsTool = {
	description:
		"Replace the calculated column array on a module's case list with a typed CalculatedColumn AST array. Each entry pairs a stable id, header, and ValueExpression; optional per-column sort config available. Wholesale replace.",
	inputSchema: setCalculatedColumnsInputSchema,
	async execute(
		input: SetCalculatedColumnsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetCalculatedColumnsResult>> {
		const { moduleIndex, calculatedColumns } = input;
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
			const mod = doc.modules[moduleUuid];
			if (!mod) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: `Module ${moduleIndex} not found` },
				};
			}

			// Preserve every other slot of the case-list config; only
			// `calculatedColumns` is being replaced.
			const base = baseCaseListConfig(mod);
			const mutations = updateModuleMutations(doc, moduleUuid, {
				caseListConfig: { ...base, calculatedColumns },
			});
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`module:${moduleIndex}:calculatedColumns`,
			);

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: `Successfully set ${calculatedColumns.length} calculated column${calculatedColumns.length === 1 ? "" : "s"} on module "${mod.name}" (index ${moduleIndex}).`,
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
