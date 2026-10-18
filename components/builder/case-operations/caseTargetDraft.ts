import type { Uuid } from "@/lib/domain";
import { type Expression, literal, term } from "@/lib/domain/expression";

export interface CaseTargetDraft {
	readonly formUuid: Uuid;
	readonly operationUuid: Uuid;
	readonly expression: Expression;
}

export type CaseTargetDraftAction = {
	readonly formUuid: Uuid;
	readonly operationUuid: Uuid;
} & (
	| { readonly type: "begin" }
	| { readonly type: "update"; readonly expression: Expression }
	| { readonly type: "clear" }
);

/** One local calculation belongs to the exact form and operation. Events
 * from an older surface cannot update or clear a replacement draft. */
export function reduceCaseTargetDraft(
	current: CaseTargetDraft | null,
	action: CaseTargetDraftAction,
): CaseTargetDraft | null {
	const matches =
		current?.formUuid === action.formUuid &&
		current.operationUuid === action.operationUuid;
	if (action.type === "begin")
		return matches
			? current
			: {
					formUuid: action.formUuid,
					operationUuid: action.operationUuid,
					expression: term(literal("")),
				};
	if (!matches) return current;
	return action.type === "clear"
		? null
		: {
				formUuid: action.formUuid,
				operationUuid: action.operationUuid,
				expression: action.expression,
			};
}
