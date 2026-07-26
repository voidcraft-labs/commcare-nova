import type { BlueprintDoc } from "@/lib/domain";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import type { ReadToolResult } from "../common";
import {
	operationAddressSchema,
	projectedCaseOperations,
	resolveOperationAddress,
} from "./shared";

export type GetCaseOperationsInput = {
	readonly moduleId: string;
	readonly formId: string;
};

export type GetCaseOperationsResult =
	| {
			readonly moduleId: string;
			readonly formId: string;
			readonly operations: readonly Record<string, unknown>[];
	  }
	| { readonly error: string };

export const getCaseOperationsTool = {
	description:
		"List a form's case operations in execution order. References use operation ids and field paths; storage UUIDs are never returned.",
	inputSchema: operationAddressSchema,
	async execute(
		input: GetCaseOperationsInput,
		_ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<ReadToolResult<GetCaseOperationsResult>> {
		const address = resolveOperationAddress(doc, input);
		if (!address.ok) {
			return { kind: "read", data: { error: address.error } };
		}
		return {
			kind: "read",
			data: {
				moduleId: input.moduleId,
				formId: input.formId,
				operations: projectedCaseOperations(doc, address.formUuid),
			},
		};
	},
};
