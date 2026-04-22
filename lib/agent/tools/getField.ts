/**
 * SA tool: `getField` — fetch a single field by bare id, with children
 * when the field is a container.
 *
 * Pure read — no mutations, no SSE emission. Resolves the field through
 * the positional `(moduleIndex, formIndex, fieldId)` triple so the SA
 * can read a field it knows only by name without threading a path
 * prefix through the call. Both the SA chat factory and the MCP
 * adapter call this the same way.
 *
 * Container-vs-leaf branching lives here: group / repeat fields carry a
 * `children` key populated with the ordered subtree so the SA sees one
 * coherent view of a container and everything inside it in a single
 * call. Leaf fields return the raw domain `Field` verbatim.
 */

import { z } from "zod";
import { buildFieldTree, type FieldWithChildren } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, Field } from "@/lib/domain";
import { isContainer } from "@/lib/domain";
import { resolveFieldByIndex } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";

export const getFieldInputSchema = z.object({
	moduleIndex: z.number().describe("0-based module index"),
	formIndex: z.number().describe("0-based form index"),
	fieldId: z.string().describe("Field id"),
});

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
	  };

export const getFieldTool = {
	name: "getField" as const,
	description: "Get a single field by ID within a form.",
	inputSchema: getFieldInputSchema,
	async execute(
		input: GetFieldInput,
		_ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<GetFieldResult> {
		const { moduleIndex, formIndex, fieldId } = input;
		const resolved = resolveFieldByIndex(doc, moduleIndex, formIndex, fieldId);
		if (!resolved) {
			return {
				error: `Field "${fieldId}" not found in m${moduleIndex}-f${formIndex}`,
			};
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
		return {
			moduleIndex,
			formIndex,
			fieldId,
			path: resolved.path,
			field,
		};
	},
};
