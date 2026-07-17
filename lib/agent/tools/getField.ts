/**
 * SA tool: `getField` — fetch a single field by id or uuid, with
 * children when the field is a container.
 *
 * Pure read — no mutations, no SSE emission. Resolves the field through
 * the positional `(moduleIndex, formIndex, fieldId)` triple so the SA
 * can read a field it knows only by name without threading a path
 * prefix through the call — and through the field's uuid when duplicate
 * ids make the bare id ambiguous (`resolveFieldTarget` refuses those
 * with every match listed). Both the SA chat factory and the MCP
 * adapter call this the same way.
 *
 * Container-vs-leaf branching lives here: group / repeat fields carry a
 * `children` key populated with the ordered subtree so the SA sees one
 * coherent view of a container and everything inside it in a single
 * call. Leaf fields return the raw domain `Field` verbatim.
 */

import { z } from "zod";
import { buildFieldTree, type FieldWithChildren } from "@/lib/doc/fieldWalk";
import {
	describeUnwrittenProperty,
	unwrittenProperties,
} from "@/lib/doc/unwrittenProperties";
import type { BlueprintDoc, Field } from "@/lib/domain";
import { isContainer } from "@/lib/domain";
import { FIELD_REF_HINT, resolveFieldTarget } from "../blueprintHelpers";
import { systemReminder } from "../systemReminder";
import type { ToolExecutionContext } from "../toolExecutionContext";
import type { ReadToolResult } from "./common";

export const getFieldInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		fieldId: z.string().describe(`Field to read — ${FIELD_REF_HINT}`),
	})
	.strict();

export type GetFieldInput = z.infer<typeof getFieldInputSchema>;

/**
 * Field payload shape for container fields — the domain `Field` plus
 * its ordered subtree. Narrower than `FieldWithChildren` (where
 * `children` is optional to cover leaves too): the tool only constructs
 * this shape when `isContainer(field)` is true, so `children` is
 * guaranteed present. Leaf fields come back as raw `Field` with no
 * `children` key so downstream consumers can branch on `isContainer`
 * themselves.
 */
export type ContainerFieldWithChildren = Field & {
	children: FieldWithChildren[];
};

/**
 * Two legal return shapes: `{ error }` when the triple doesn't resolve,
 * or the found-field payload carrying positional context + the field
 * itself (flat for leaves, with `children` for containers).
 */
export type GetFieldResult =
	| { error: string }
	| {
			moduleIndex: number;
			formIndex: number;
			fieldId: string;
			path: string;
			field: Field | ContainerFieldWithChildren;
			/** Agent-only ambient context (see `lib/agent/systemReminder.ts`):
			 *  present when the returned field (or its subtree) reads a case
			 *  property no form in the app writes. */
			system_reminder?: string;
	  };

export const getFieldTool = {
	description: "Get a single field by id (or uuid) within a form.",
	inputSchema: getFieldInputSchema,
	async execute(
		input: GetFieldInput,
		_ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<ReadToolResult<GetFieldResult>> {
		const { moduleIndex, formIndex, fieldId } = input;
		const resolved = resolveFieldTarget(doc, moduleIndex, formIndex, fieldId);
		if (!resolved.ok) {
			return { kind: "read", data: { error: resolved.error } };
		}
		// If the resolved field is a container, include its children so
		// the SA sees the subtree in one call. Leaf fields return a plain
		// `Field` with no `children` key.
		const field = isContainer(resolved.field)
			? {
					...resolved.field,
					children: buildFieldTree(doc, resolved.field.uuid),
				}
			: resolved.field;
		const reminder = unwrittenReadsReminder(doc, field);
		return {
			kind: "read",
			data: {
				moduleIndex,
				formIndex,
				fieldId,
				path: resolved.path,
				field,
				...(reminder !== undefined ? { system_reminder: reminder } : {}),
			},
		};
	},
};

/**
 * The per-field flavor of the blueprint summary's closing reminder:
 * when the returned field (for containers, anything in the returned
 * subtree) reads a case property no form in the app writes, say so as
 * background knowledge — the value comes from outside the app, which
 * is a normal state, not something to fix or announce.
 */
function unwrittenReadsReminder(
	doc: BlueprintDoc,
	field: Field | ContainerFieldWithChildren,
): string | undefined {
	const included = new Set<string>();
	const collect = (node: Field | FieldWithChildren): void => {
		included.add(node.uuid);
		if ("children" in node && node.children) {
			for (const child of node.children) collect(child);
		}
	};
	collect(field);
	const entries = unwrittenProperties(doc).filter((entry) =>
		entry.reads.some((read) => included.has(read.carrier)),
	);
	if (entries.length === 0) return undefined;
	return systemReminder(
		[
			"For your awareness: no form in this app writes the following case properties read here:",
			...entries.map((entry) => `- ${describeUnwrittenProperty(doc, entry)}`),
			"This is normal — the values come from outside the app (another app on the same case type, an integration, or staged sample data). Don't bring it up with the user unless they ask or it directly affects what they asked for.",
		].join("\n"),
	);
}
