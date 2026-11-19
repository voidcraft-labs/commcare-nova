import type { RecordAnswer } from "../store";
import type { DeploymentWithResources } from "../types";

/**
 * The deployment a record answers its caller, for a caller who may read it,
 * as the caller of every seed and of every case here that does not take that
 * access away is. A caller who may not read it is answered no record, and a
 * case that expects one fails here, naming why.
 */
export function readable(answer: RecordAnswer): DeploymentWithResources {
	if (answer.deployment === null)
		throw new Error(
			"The record answered no deployment, which it does only to a caller who may no longer read it, and this caller should still be able to.",
		);
	return answer.deployment;
}
