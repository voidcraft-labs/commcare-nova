import type { CaseType } from "@/lib/domain/blueprint";
import { reachableCaseTypes } from "@/lib/domain/caseTypes";

/** One parent-index depth map for form wire reads, post-submit links, and
 * HQ's case-load metadata. No expression or emitted text is inspected. */
export function caseTypeDepthMap(
	moduleCaseType: string | undefined,
	caseTypes: readonly CaseType[],
): ReadonlyMap<string, number> {
	return new Map(
		reachableCaseTypes(moduleCaseType, caseTypes).map((type) => [
			type.name,
			type.depth,
		]),
	);
}
