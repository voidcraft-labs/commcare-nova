import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type { ToolExecutionContext } from "../../toolExecutionContext";
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
	  }
	| { readonly error: string };

export const getCaseOperationsTool = {
	description:
		"List every case operation in execution order. Addresses and every Nova-owned reference use stable UUIDs; authored ids and names remain readable metadata.",
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
				moduleUuid: address.moduleUuid,
				formUuid: address.formUuid,
				form: doc.forms[address.formUuid]?.name ?? "",
				operations: projectedCaseOperations(doc, address.formUuid),
			},
		};
	},
};
