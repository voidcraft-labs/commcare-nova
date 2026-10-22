import type { CaseType } from "@/lib/domain";
import {
	type RelationPath,
	resolveRelationDestination as resolveDomainDestination,
} from "@/lib/domain/expression";

/** The editor uses the same strict destination as the checker. An ambiguous or
 * inconsistent walk has no row scope until its relationship is repaired. */
export function resolveRelationDestination(
	via: RelationPath,
	originCaseType: string,
	caseTypes: readonly CaseType[],
): string | undefined {
	const destination = resolveDomainDestination(via, originCaseType, caseTypes);
	return destination.ok ? destination.caseType : undefined;
}
