import type { CaseOperation, FormType } from "@/lib/domain";
import type { FormBuilderCaseAction } from "@/lib/domain/questionId";

/** The direct action elements in the source block that carries this operation's links. */
export function saveToCaseActions(
	operation: CaseOperation,
	formType: FormType,
	ownCloseInBlock: boolean,
): Record<FormBuilderCaseAction, boolean> {
	return {
		create:
			operation.action === "create" ||
			(operation.action === "own" && formType === "registration"),
		close:
			operation.action === "close" ||
			operation.closeAfter === true ||
			(operation.action === "own" && ownCloseInBlock),
	};
}
