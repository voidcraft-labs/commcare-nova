// Valid-by-construction related-case seeds shared by Predicate cards and
// registry admission. A case type can relate upward to its declared parent or
// downward to any case type that declares it as a parent. The authoring menu
// must not pretend an arbitrary `parent` connection exists when neither does.

import {
	ancestorPath,
	type RelationPath,
	relationStep,
	selfPath,
	subcasePath,
} from "@/lib/domain/predicate";
import type { PredicateEditContext } from "./editorSchemas";

/** Return the first real connection authors can use, preferring the current
 * case type's declared parent and then its first declared child. */
export function firstRelatedCasePath(
	ctx: PredicateEditContext,
): RelationPath | undefined {
	const current = ctx.caseTypes.find(
		(caseType) => caseType.name === ctx.currentCaseType,
	);
	if (
		current?.parent_type !== undefined &&
		ctx.caseTypes.some((caseType) => caseType.name === current.parent_type)
	) {
		return ancestorPath(relationStep("parent"));
	}

	const child = ctx.caseTypes.find(
		(caseType) => caseType.parent_type === ctx.currentCaseType,
	);
	return child === undefined ? undefined : subcasePath("parent", child.name);
}

export function hasRelatedCaseType(ctx: PredicateEditContext): boolean {
	return firstRelatedCasePath(ctx) !== undefined;
}

/** Keep registry factories total for non-UI callers. Menus admit the related
 * predicates only when `hasRelatedCaseType` is true, so authors never see the
 * self fallback as a made-up relationship. */
export function relatedCasePathDefault(
	ctx: PredicateEditContext,
): RelationPath {
	return firstRelatedCasePath(ctx) ?? selfPath();
}
