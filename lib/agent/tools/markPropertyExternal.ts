/**
 * SA tool: `markPropertyExternal` — record (or clear) the fact that a
 * case property is written OUTSIDE this app.
 *
 * This is the no-writer advisory's resolution path
 * (`lib/doc/noWriterAdvisories.ts`): a property that gates behavior
 * with no in-app writer flags on every surface until either a writer
 * exists or this marking says another app / HQ / an integration owns
 * it. The marking is a catalog fact (`casePropertySchema.external`),
 * so one call silences the advisory for the builder, the SA, and MCP
 * clients alike — and the optional `note` preserves WHAT writes it, so
 * a future conversation doesn't have to re-ask the user.
 *
 * A dedicated tool because no other surface can reach an authored
 * property: `generateSchema` is additive over authored records by
 * design (re-declaring one is rejected), and the field tools edit
 * fields, not catalog entries.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface.
 */

import { z } from "zod";
import { noWriterAdvisories } from "@/lib/doc/noWriterAdvisories";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, CaseProperty } from "@/lib/domain";
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

export const markPropertyExternalInputSchema = z
	.object({
		case_type: z
			.string()
			.min(1)
			.describe("The case type (by name) whose property is being marked."),
		property: z.string().min(1).describe("The case property name."),
		external: z
			.object({
				note: z
					.string()
					.min(1)
					.nullable()
					.optional()
					.describe(
						"What writes the property — e.g. \"set by the pharmacy fulfillment app\". null when the user doesn't know or didn't say.",
					),
			})
			.strict()
			.nullable()
			.describe(
				"Pass an object (with an optional note) to mark the property as written outside this app — this silences the no-writer advisory for it. Pass null to clear the marking, when forms in this app are meant to own the property again.",
			),
	})
	.strict();

export type MarkPropertyExternalInput = z.infer<
	typeof markPropertyExternalInputSchema
>;

/** Human-readable success string or an error record. */
export type MarkPropertyExternalResult = MutationSuccess | { error: string };

export const markPropertyExternalTool = {
	description:
		"Record that a case property is written OUTSIDE this app — by another app on the same case type, by CommCare HQ, or by an integration — or clear that marking (external: null). Use it when a no-writer advisory flags a property the user confirms is set elsewhere; include a note naming what sets it. Marked properties stop flagging everywhere.",
	inputSchema: markPropertyExternalInputSchema,
	async execute(
		input: MarkPropertyExternalInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<MarkPropertyExternalResult>> {
		try {
			const caseType = (doc.caseTypes ?? []).find(
				(ct) => ct.name === input.case_type,
			);
			if (!caseType) {
				const known = (doc.caseTypes ?? []).map((ct) => `"${ct.name}"`);
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Nothing was marked — the app's catalog has no case type "${input.case_type}". ${
							known.length > 0
								? `It records: ${known.join(", ")}. Check the name, or`
								: "It records none yet;"
						} declare the type first (generateSchema).`,
					},
				};
			}

			const existing = caseType.properties.find(
				(p) => p.name === input.property,
			);

			if (input.external === null) {
				if (existing?.external === undefined) {
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							message: `"${input.property}" on case type "${input.case_type}" isn't marked external — nothing to clear.`,
							summary: { subject: input.property, location: input.case_type },
						},
					};
				}
				const { external: _cleared, ...rest } = existing;
				return commitMarking(ctx, doc, input, rest, {
					message: `Cleared the external marking on "${input.property}" (case type "${input.case_type}"). If it still gates behavior with no in-app writer, the no-writer advisory will flag it again.`,
					summary: { subject: input.property, location: input.case_type },
				});
			}

			const external =
				input.external.note != null ? { note: input.external.note } : {};
			const property: CaseProperty = existing
				? { ...existing, external }
				: // An unlisted property gets the declaration chokepoint's bare
					// shape (`ensureCatalogProperty`) plus the marking. This is a
					// DELIBERATE declare-new arm, not just typo tolerance: on an
					// authored record it is the only way to declare a property
					// another system writes (generateSchema rejects authored
					// re-declaration, and a gate can't reference an undeclared
					// property) — so a typo'd name can't be refused outright;
					// instead the message below discloses the new declaration
					// loudly with the correction recipe.
					{ name: input.property, label: input.property, external };
			const noteText =
				input.external.note != null ? ` (${input.external.note})` : "";
			// The prose is honest about what actually happened: a marking only
			// "silences" an advisory that was open, and a name the catalog
			// didn't list minted a NEW property — which is either the
			// declare-external flow working as intended or a typo the caller
			// must hear about now, while the fix is one call away.
			const advisoryWasOpen = noWriterAdvisories(doc).some(
				(a) => a.caseType === input.case_type && a.property === input.property,
			);
			const effect = advisoryWasOpen
				? "Its no-writer advisory is silenced; forms here can still read it, and adding a writer later is fine."
				: "No advisory was open for it — the marking records the fact for future reference.";
			const declaredNew = !existing
				? ` The catalog didn't list "${input.property}", so this DECLARED it new — if you meant an existing property (this type declares: ${caseType.properties.map((p) => `"${p.name}"`).join(", ") || "none"}), clear this marking (external: null on "${input.property}") and mark the right one.`
				: "";
			return commitMarking(ctx, doc, input, property, {
				message: `Marked "${input.property}" on case type "${input.case_type}" as set outside this app${noteText}. ${effect}${declaredNew}`,
				summary: { subject: input.property, location: input.case_type },
			});
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};

async function commitMarking(
	ctx: ToolExecutionContext,
	doc: BlueprintDoc,
	input: MarkPropertyExternalInput,
	property: CaseProperty,
	success: { message: string; summary: ToolCallSummary },
): Promise<MutatingToolResult<MarkPropertyExternalResult>> {
	const declared = (doc.caseTypes ?? [])
		.find((ct) => ct.name === input.case_type)
		?.properties.some((p) => p.name === input.property);
	const mutations: Mutation[] = [
		declared
			? { kind: "setCaseProperty", caseType: input.case_type, property }
			: { kind: "addCaseProperty", caseType: input.case_type, property },
	];
	const commit = await guardedMutate(ctx, doc, mutations, "schema");
	if (!commit.ok) {
		return {
			kind: "mutate" as const,
			mutations: [],
			newDoc: doc,
			result: { error: commit.error },
		};
	}
	return {
		kind: "mutate" as const,
		mutations,
		newDoc: commit.newDoc,
		result: success,
	};
}
