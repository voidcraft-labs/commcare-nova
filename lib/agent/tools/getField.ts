/**
 * SA tool: `getField` — fetch a single field by stable uuid, with
 * children when the field is a container.
 *
 * Pure read — no mutations, no SSE emission. Resolves the field through
 * the stable `(moduleUuid, formUuid, fieldUuid)` address. Both the SA chat
 * factory and the MCP adapter call this the same way.
 *
 * Container-vs-leaf branching lives here: group / repeat fields carry a
 * `children` key populated with the ordered subtree so the SA sees one
 * coherent view of a container and everything inside it in a single
 * call. Leaf fields return the raw domain `Field` verbatim.
 */

import type { z } from "zod";
import { buildFieldTree, type FieldWithChildren } from "@/lib/doc/fieldWalk";
import { unwrittenPropertiesReadBy } from "@/lib/doc/unwrittenProperties";
import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import { isContainer } from "@/lib/domain";
import { unwrittenPropertiesReminder } from "../systemReminder";
import type { ToolExecutionContext } from "../toolExecutionContext";
import type { ReadToolResult } from "./common";
import {
	fieldAddressSchema,
	resolveFieldAddress,
} from "./shared/entityAddresses";

export const getFieldInputSchema = fieldAddressSchema;

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
 * Two legal return shapes: `{ error }` when the UUID address doesn't resolve,
 * or the found-field payload carrying that immutable address plus the field
 * itself (flat for leaves, with `children` for containers).
 */
export type GetFieldResult =
	| { error: string }
	| {
			moduleUuid: Uuid;
			formUuid: Uuid;
			fieldUuid: Uuid;
			field: Field | ContainerFieldWithChildren;
			/** Agent-only ambient context (see `lib/agent/systemReminder.ts`):
			 *  present when the returned field (or its subtree) reads a case
			 *  property no form in the app writes. */
			system_reminder?: string;
	  };

export const getFieldTool = {
	description: "Get a single field by stable uuid within its form.",
	inputSchema: getFieldInputSchema,
	async execute(
		input: GetFieldInput,
		_ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<ReadToolResult<GetFieldResult>> {
		const resolved = resolveFieldAddress(doc, input);
		if (!resolved.ok) {
			return { kind: "read", data: { error: resolved.error } };
		}
		// If the resolved field is a container, include its children so
		// the SA sees the subtree in one call. Leaf fields return a plain
		// `Field` with no `children` key.
		const canonicalField = isContainer(resolved.field)
			? {
					...resolved.field,
					children: buildFieldTree(doc, resolved.field.uuid),
				}
			: resolved.field;
		const reminder = unwrittenReadsReminder(doc, canonicalField);
		return {
			kind: "read",
			data: {
				moduleUuid: resolved.moduleUuid,
				formUuid: resolved.formUuid,
				fieldUuid: resolved.fieldUuid,
				field: canonicalField,
				...(reminder !== undefined ? { system_reminder: reminder } : {}),
			},
		};
	},
};

/**
 * The per-field flavor of the blueprint summary's closing reminder:
 * when the returned field (for containers, anything in the returned
 * subtree) reads a case property no form in the app writes, say so as
 * background knowledge via the shared reminder rendering.
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
	const entries = unwrittenPropertiesReadBy(doc, included);
	if (entries.length === 0) return undefined;
	return unwrittenPropertiesReminder(doc, entries);
}
