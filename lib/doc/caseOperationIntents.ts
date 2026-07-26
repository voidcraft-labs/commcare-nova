import type { CaseOperation, CaseTarget } from "@/lib/domain";
import { sameCaseOperationTargetIdentity } from "./caseOperationOrder";

type ExistingCaseTarget = Exclude<CaseTarget, { kind: "new" }>;

/**
 * The type one known case target has immediately after `precedingOperations`.
 *
 * The projection follows the same identity comparison as the validator's
 * target-order analysis. Session targets begin at the module's case type;
 * operation targets begin where their create runs; exact expression targets
 * begin at their first assertion. Every later retype advances the rolling
 * type. Callers pass only operations before the insertion/edit point, so a
 * future create can never become an available target accidentally.
 */
export function caseOperationTargetTypeAfter(
	precedingOperations: readonly CaseOperation[],
	target: ExistingCaseTarget,
	initialSessionCaseType: string | undefined,
): string | undefined {
	let caseType = target.kind === "session" ? initialSessionCaseType : undefined;

	for (const operation of precedingOperations) {
		if (
			operation.action === "create" &&
			target.kind === "op" &&
			target.opUuid === operation.uuid
		) {
			caseType = operation.caseType;
			continue;
		}
		if (
			operation.action === "create" ||
			operation.target.kind === "new" ||
			!sameCaseOperationTargetIdentity(operation.target, target)
		) {
			continue;
		}
		// An exact runtime expression establishes its asserted type on first use.
		// Session and operation targets already have a structural starting type.
		caseType ??= operation.caseType;
		if (operation.retype !== undefined) caseType = operation.retype;
	}

	return caseType;
}

/**
 * Apply one target choice as a single complete operation edit.
 *
 * A known target brings its proven rolling type with it. This is deliberately
 * one transformation: committing `target` first and `caseType` second makes
 * both individually invalid when an author crosses case types. Every other
 * authored facet is retained for the shared edit verdict to adjudicate.
 */
export function retargetCaseOperation(
	operation: CaseOperation,
	target: CaseTarget,
	precedingOperations: readonly CaseOperation[],
	initialSessionCaseType: string | undefined,
): CaseOperation {
	const caseType =
		target.kind === "new"
			? undefined
			: caseOperationTargetTypeAfter(
					precedingOperations,
					target,
					initialSessionCaseType,
				);
	return {
		...operation,
		target,
		caseType: caseType ?? operation.caseType,
	};
}
