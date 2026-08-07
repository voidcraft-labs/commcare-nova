/**
 * Shared SA/MCP tool: rename one or more case properties app-wide.
 *
 * This is the only machine-authoring operation that gives a property rename
 * semantic meaning. The complete relation is one exclusive mutation, so
 * chains, swaps, and cycles are applied simultaneously and never lower through
 * a temporary property or a sequence of lossy field/catalog edits.
 */

import { z } from "zod";
import {
	type CasePropertyRenameImpact,
	casePropertyRenameImpact,
} from "@/lib/doc/casePropertyRenameImpact";
import type { Mutation } from "@/lib/doc/types";
import {
	authoredCasePropertyNameSchema,
	type BlueprintDoc,
} from "@/lib/domain";
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

const renameCasePropertyEntrySchema = z
	.object({
		caseType: z.string().min(1).describe("Case type that owns the property."),
		from: authoredCasePropertyNameSchema.describe(
			"Current property name. It must exist on this case type.",
		),
		to: authoredCasePropertyNameSchema.describe(
			"Resulting property name. An occupied destination must also move in this same relation.",
		),
	})
	.strict();

export const renameCasePropertiesInputSchema = z
	.object({
		renames: z
			.array(renameCasePropertyEntrySchema)
			.min(1)
			.describe(
				"Complete simultaneous rename relation. Sources and destinations must each be unique per case type. Chains, swaps, and cycles are valid; merges and overwrites are not.",
			),
	})
	.strict();

export type RenameCasePropertiesInput = z.infer<
	typeof renameCasePropertiesInputSchema
>;

export interface RenameCasePropertiesSuccess extends MutationSuccess {
	readonly renames: RenameCasePropertiesInput["renames"];
	readonly impact: CasePropertyRenameImpact;
}

export type RenameCasePropertiesResult =
	| RenameCasePropertiesSuccess
	| { error: string };

/**
 * Recover the impact of the exact committed document from the command's
 * inverse. `guardedMutate` may merge an unrelated peer edit before accepting
 * the command, so measuring the caller's stale pre-commit snapshot could omit
 * a carrier that actually moved. The inverse walks the committed document
 * through the same canonical carrier inventory and has identical counts.
 */
function committedImpact(
	doc: BlueprintDoc,
	renames: RenameCasePropertiesInput["renames"],
): CasePropertyRenameImpact {
	const inverse = renames.map(({ caseType, from, to }) => ({
		caseType,
		from: to,
		to: from,
	}));
	const impact = casePropertyRenameImpact(doc, inverse);
	const occurrences = new Map(
		impact.byRename.map((entry) => [
			`${entry.caseType}\0${entry.from}\0${entry.to}`,
			entry.occurrences,
		]),
	);
	return {
		totalOccurrences: impact.totalOccurrences,
		totalCarriers: impact.totalCarriers,
		groups: impact.groups,
		byRename: renames.map((entry) => ({
			...entry,
			occurrences:
				occurrences.get(`${entry.caseType}\0${entry.to}\0${entry.from}`) ?? 0,
		})),
	};
}

export const renameCasePropertiesTool = {
	description:
		"Rename case properties across the whole app as one simultaneous, lossless change. Send the complete nonempty relation in one call: chains, swaps, and cycles are allowed, while merges, overwrites, self-renames, and temporary names are rejected. This moves every typed document reference and saved case value; it never changes field ids.",
	inputSchema: renameCasePropertiesInputSchema,
	async execute(
		input: RenameCasePropertiesInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<RenameCasePropertiesResult>> {
		try {
			const mutation: Mutation = {
				kind: "renameCaseProperties",
				renames: input.renames,
			};
			const commit = await guardedMutate(
				ctx,
				[mutation],
				"case-properties:rename",
			);
			if (!commit.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: commit.error },
				};
			}

			const impact = committedImpact(commit.newDoc, input.renames);
			const count = input.renames.length;
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					message: `Renamed ${count} case ${count === 1 ? "property" : "properties"} across ${impact.totalOccurrences} document ${impact.totalOccurrences === 1 ? "occurrence" : "occurrences"} in ${impact.totalCarriers} ${impact.totalCarriers === 1 ? "carrier" : "carriers"} as one simultaneous app-wide change.`,
					renames: input.renames,
					impact,
					summary: {
						count,
					} satisfies ToolCallSummary,
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
