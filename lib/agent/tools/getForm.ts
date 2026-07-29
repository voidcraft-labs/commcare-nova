/**
 * SA tool: `getForm` — read a form and its full nested field tree.
 *
 * Pure read — no mutations, no SSE emission. Returns the form entity in
 * domain vocabulary (`closeCondition`, `postSubmit`, `formLinks`, `connect`)
 * augmented with the ordered field tree. The shared dormant-carrier
 * projection hides S05a lookup-only carriers without changing the canonical
 * document.
 */

import { z } from "zod";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { type FormSnapshot, formSnapshot } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import type { ReadToolResult } from "./common";
import {
	formAddressSchema,
	resolveFormAddress,
} from "./shared/entityAddresses";

export const getFormInputSchema = formAddressSchema;

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
	| {
			moduleUuid: Uuid;
			formUuid: Uuid;
			form: FormSnapshot;
	  };

export const getFormTool = {
	description:
		"Get a form by stable module and form UUIDs. Returns the full form including all fields (nested by group/repeat containers).",
	inputSchema: getFormInputSchema,
	async execute(
		input: GetFormInput,
		_ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<ReadToolResult<GetFormResult>> {
		const address = resolveFormAddress(doc, input);
		if (!address.ok) {
			return { kind: "read", data: { error: address.error } };
		}
		const { moduleUuid, formUuid } = address;
		const snapshot = formSnapshot(doc, formUuid);
		if (!snapshot) {
			return {
				kind: "read",
				data: { error: `Form UUID "${formUuid}" is not readable.` },
			};
		}
		return {
			kind: "read",
			data: {
				moduleUuid,
				formUuid,
				form: snapshot,
			},
		};
	},
};
