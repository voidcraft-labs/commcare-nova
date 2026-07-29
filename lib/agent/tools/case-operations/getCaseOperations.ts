import type { BlueprintDoc } from "@/lib/domain";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import type { ReadToolResult } from "../common";
import {
	operationAddressSchema,
	projectedCaseOperations,
	resolveOperationAddress,
} from "./shared";

export type GetCaseOperationsInput = {
	readonly moduleUuid: string;
	readonly formUuid: string;
};

export type GetCaseOperationsResult =
	| {
			readonly moduleUuid: string;
			readonly formUuid: string;
			/** The form's display name — the address is identity, so the
			 *  result carries the human handle rather than making the caller
			 *  hold a uuid and a name it never asked for. */
			readonly form: string;
			readonly operations: readonly Record<string, unknown>[];
	  }
	| { readonly error: string };

export const getCaseOperationsTool = {
	description:
		"List every case operation in execution order. Addressed by module and form uuid. References inside an operation use operation ids and field paths. A lookup-bearing operation remains in place with explicit unavailable metadata and stays addressable by id.",
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
				moduleUuid: input.moduleUuid,
				formUuid: input.formUuid,
				form: doc.forms[address.formUuid]?.name ?? "",
				operations: projectedCaseOperations(doc, address.formUuid),
			},
		};
	},
};
