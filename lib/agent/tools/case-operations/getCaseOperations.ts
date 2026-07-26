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
		"List every case operation in execution order. References use operation ids and field paths; storage UUIDs are never returned. A lookup-bearing operation remains in place with explicit unavailable metadata and stays addressable by id.",
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
