/**
 * SA tool: `getForm` — read a form and its full nested field tree.
 *
 * Pure read — no mutations, no SSE emission. Returns the form entity in
 * domain vocabulary (`closeCondition`, `postSubmit`, `formLinks`, `connect`)
 * augmented with the ordered field tree. UUID-backed expression and lookup
 * references remain in their canonical round-trippable shapes.
 */

import type { z } from "zod";
import { formRecordName } from "@/lib/doc/formRecordName";
import { formNavigation, type Uuid } from "@/lib/domain";
import { type FormSnapshot, formSnapshot } from "../blueprintHelpers";
import type { ToolInvocationContext } from "../workspace/types";
import type { ReadToolResult } from "./common";
import {
	formAddressSchema,
	resolveFormAddress,
} from "./shared/entityAddresses";

export const getFormInputSchema = formAddressSchema;

export type GetFormInput = z.infer<typeof getFormInputSchema>;

/**
 * Two legal return shapes — `{ error }` on any UUID or membership miss,
 * and `{ moduleUuid, formUuid, form }` on success.
 */
export type GetFormResult =
	| { error: string }
	| {
			moduleUuid: Uuid;
			formUuid: Uuid;
			form: FormSnapshot;
			navigation: ReturnType<typeof formNavigation>;
			recordName?: ReturnType<typeof formRecordName>;
	  };

export const getFormTool = {
	description: "Read a form, its questions, record naming rule and navigation.",
	inputSchema: getFormInputSchema,
	async execute(
		input: GetFormInput,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<GetFormResult>> {
		const doc = ctx.snapshot.doc;
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
		const recordName = formRecordName(doc, formUuid);
		return {
			kind: "read",
			data: {
				moduleUuid,
				formUuid,
				form: snapshot,
				navigation: formNavigation(doc, formUuid),
				...(recordName && { recordName }),
			},
		};
	},
};
