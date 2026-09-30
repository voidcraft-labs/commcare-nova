import {
	CaptureSubmissionRejectedError,
	CaseNotFoundError,
	CasePropertiesValidationError,
	SubmissionRejectedError,
} from "@/lib/case-store/errors";
import { AppTestUnavailableError } from "@/lib/db/appTests";
import { FormEvaluationInputError } from "../engine/formEvaluationTypes";

/** A worker action refusal is retained; infrastructure failures abort the call. */
export class AppTestActionError extends AppTestUnavailableError {}
export function expectedAppTestRefusal(error: unknown): error is Error {
	return (
		error instanceof AppTestActionError ||
		error instanceof FormEvaluationInputError ||
		error instanceof CaptureSubmissionRejectedError ||
		error instanceof CaseNotFoundError ||
		error instanceof CasePropertiesValidationError ||
		error instanceof SubmissionRejectedError
	);
}
