// A fixture that writes a form's case operations by hand keeps the form's
// own case first, as every registration, follow-up and close form of a
// module with a case type holds it (`CASE_OWN_OPERATION`).
import type { CaseOperation, Form } from "@/lib/domain";

/** The own case `form` holds (none on a survey), to stand first. */
export function ownArms(
	form: Pick<Form, "caseOperations"> | undefined,
): CaseOperation[] {
	return (form?.caseOperations ?? []).filter(
		(operation) => operation.action === "own",
	);
}
