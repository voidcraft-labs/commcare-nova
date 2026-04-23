/**
 * SA tool: `getForm` — read a form and its full nested field tree.
 *
 * Pure read — no mutations, no SSE emission. Returns the form entity
 * itself (domain shape verbatim — `closeCondition`, `postSubmit`,
 * `formLinks`, `connect`) augmented with the ordered field tree, so the
 * SA can audit a form's contents before emitting edit mutations without
 * stitching together form metadata and fields from separate calls.
 */

import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { type FormSnapshot, formSnapshot } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";

export const getFormInputSchema = z.object({
	moduleIndex: z.number().describe("0-based module index"),
	formIndex: z.number().describe("0-based form index"),
});

export type GetFormInput = z.infer<typeof getFormInputSchema>;

/**
 * Two legal return shapes — `{ error }` on any lookup miss (module
 * index, form index, or form record) and `{ moduleIndex, formIndex,
 * form }` on success. The error branch collapses all three miss
 * conditions into one identical message so the SA has a single failure
 * mode to diagnose.
 */
export type GetFormResult =
	| { error: string }
	| { moduleIndex: number; formIndex: number; form: FormSnapshot };

export const getFormTool = {
	description:
		"Get a form by module and form index. Returns the full form including all fields (nested by group/repeat containers).",
	inputSchema: getFormInputSchema,
	async execute(
		input: GetFormInput,
		_ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<GetFormResult> {
		const { moduleIndex, formIndex } = input;
		const moduleUuid = doc.moduleOrder[moduleIndex];
		if (!moduleUuid)
			return { error: `Form m${moduleIndex}-f${formIndex} not found` };
		const formUuid = doc.formOrder[moduleUuid]?.[formIndex];
		if (!formUuid)
			return { error: `Form m${moduleIndex}-f${formIndex} not found` };
		const snapshot = formSnapshot(doc, formUuid);
		if (!snapshot)
			return { error: `Form m${moduleIndex}-f${formIndex} not found` };
		return { moduleIndex, formIndex, form: snapshot };
	},
};
