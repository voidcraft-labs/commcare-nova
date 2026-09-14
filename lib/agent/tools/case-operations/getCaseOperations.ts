import type { Uuid } from "@/lib/domain";
import { formAnswerWrites } from "../../formAnswerWrites";
import type { ToolInvocationContext } from "../../workspace/types";
import type { ReadToolResult } from "../common";
import {
	operationAddressSchema,
	projectedCaseOperations,
	resolveOperationAddress,
} from "./shared";

export type GetCaseOperationsInput = {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
};

export type GetCaseOperationsResult =
	| {
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
			/** The form's display name — the address is identity, so the
			 *  result carries the human handle rather than making the caller
			 *  hold a uuid and a name it never asked for. */
			readonly form: string;
			readonly operations: readonly Record<string, unknown>[];
			readonly answerWrites: ReturnType<typeof formAnswerWrites>;
	  }
	| { readonly error: string };

export const getCaseOperationsTool = {
	description:
		"Read a form's advanced record operations in execution order and the writes derived from its answers.",
	inputSchema: operationAddressSchema,
	async execute(
		input: GetCaseOperationsInput,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<GetCaseOperationsResult>> {
		const doc = ctx.snapshot.doc;
		const address = resolveOperationAddress(doc, input);
		if (!address.ok) {
			return { kind: "read", data: { error: address.error } };
		}
		return {
			kind: "read",
			data: {
				moduleUuid: address.moduleUuid,
				formUuid: address.formUuid,
				form: doc.forms[address.formUuid]?.name ?? "",
				operations: projectedCaseOperations(doc, address.formUuid),
				answerWrites: formAnswerWrites(
					doc,
					address.moduleUuid,
					address.formUuid,
				),
			},
		};
	},
};
