import type { CaseOperation, Uuid } from "@/lib/domain";
import {
	type OperationSemantics,
	operationSemantics,
} from "../../authoring/operationSemantics";
import { formAnswerWrites } from "../../formAnswerWrites";
import type { ToolInvocationContext } from "../../workspace/types";
import type { ReadToolResult } from "../common";
import {
	type CasePlacementWords,
	formCasePlacementWords,
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
			/** Every case change in the order it runs, this form's own case
			 *  first, without the placement a published app holds: the read
			 *  states where each is kept in `placements` instead. */
			readonly operations: readonly CaseOperation[];
			/** Where CommCare HQ keeps each change, by operation uuid. The
			 *  authoring projection puts each on its change as `placement`. */
			readonly placements: Readonly<Record<Uuid, CasePlacementWords>>;
			/** Where HQ keeps this form's own close, when it has a block of its
			 *  own. */
			readonly ownClose?: { readonly placement: CasePlacementWords };
			readonly answerWrites: ReturnType<typeof formAnswerWrites>;
			readonly operationSemantics: OperationSemantics;
	  }
	| { readonly error: string };

export const getCaseOperationsTool = {
	description:
		"Read a form's case changes in the order they run, this form's own case first, each with where CommCare HQ keeps it.",
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
		const placements = formCasePlacementWords(doc, address.formUuid);
		return {
			kind: "read",
			data: {
				moduleUuid: address.moduleUuid,
				formUuid: address.formUuid,
				form: doc.forms[address.formUuid]?.name ?? "",
				operations: projectedCaseOperations(doc, address.formUuid).map(
					({ placement: _held, ...operation }) => operation as CaseOperation,
				),
				placements: placements.operations,
				...(placements.ownClose !== undefined && {
					ownClose: { placement: placements.ownClose },
				}),
				operationSemantics: operationSemantics(doc, address.formUuid),
				answerWrites: formAnswerWrites(
					doc,
					address.moduleUuid,
					address.formUuid,
				),
			},
		};
	},
};
