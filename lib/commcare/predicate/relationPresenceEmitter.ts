import type { RelationPath, RelationStep } from "@/lib/domain/predicate/types";
import { quoteLiteral } from "./stringQuoting";
import {
	buildAncestorJoinNodeset,
	DEFAULT_INSTANCE_ROOT,
	type InstanceRoot,
} from "./termEmitter";

type DirectedRelation = Exclude<RelationPath, { kind: "self" }>;

/**
 * Whether the immediate predicate candidate can be named from the original
 * `current()` case. Root and pure ancestor chains are singleton-addressable;
 * a scope entered through subcase/any-relation is not, because XPath 1.0 has
 * no lexical variable for that candidate.
 */
export type OnDeviceCaseAnchor =
	| { readonly kind: "root" }
	| {
			readonly kind: "ancestor";
			readonly via: readonly RelationStep[];
	  }
	| { readonly kind: "unaddressable" };

export const ROOT_ON_DEVICE_CASE_ANCHOR: OnDeviceCaseAnchor = { kind: "root" };

/** Anchor inside a relation's destination `where` scope. */
export function descendOnDeviceCaseAnchor(
	anchor: OnDeviceCaseAnchor,
	via: RelationPath,
): OnDeviceCaseAnchor {
	if (via.kind === "self") return anchor;
	if (via.kind !== "ancestor" || anchor.kind === "unaddressable") {
		return { kind: "unaddressable" };
	}
	return {
		kind: "ancestor",
		via: anchor.kind === "root" ? via.via : [...anchor.via, ...via.via],
	};
}

/** XPath selecting the singleton anchor's case id, when one is nameable. */
export function onDeviceAnchorCaseId(
	anchor: OnDeviceCaseAnchor,
	root: InstanceRoot = DEFAULT_INSTANCE_ROOT,
): string | undefined {
	switch (anchor.kind) {
		case "root":
			return "current()/@case_id";
		case "ancestor":
			return `${buildAncestorJoinNodeset(anchor.via, root)}/@case_id`;
		case "unaddressable":
			return undefined;
		default: {
			const _exhaustive: never = anchor;
			return _exhaustive;
		}
	}
}

/**
 * Emit a relation-presence predicate relative to the evaluator's immediate
 * case candidate. Core preserves `current()` from the first predicate forever,
 * so a nested join cannot use `current()` or `.` as a lexical outer-case
 * variable. Instead, eagerly collect every destination id that satisfies the
 * nested filter and test the immediate candidate's index/id for membership.
 * CCHQ itself uses the same `selected(join(' ', ids), id)` idiom.
 */
export function emitImmediateRelationPresence(
	via: DirectedRelation,
	where: string | undefined,
	root: InstanceRoot = DEFAULT_INSTANCE_ROOT,
): string {
	switch (via.kind) {
		case "ancestor":
			return emitAncestorPresence(via.via, where, root);
		case "subcase":
			return emitSubcasePresence(via.identifier, via.ofCaseType, where, root);
		case "any-relation": {
			const ancestor = emitAncestorPresence(
				[
					{
						identifier: via.identifier,
						throughCaseType: via.ofCaseType,
					},
				],
				where,
				root,
			);
			const subcase = emitSubcasePresence(
				via.identifier,
				via.ofCaseType,
				where,
				root,
			);
			return `(${ancestor} or ${subcase})`;
		}
		default: {
			const _exhaustive: never = via;
			throw new Error(
				`emitImmediateRelationPresence: unhandled relation ${String(_exhaustive)}`,
			);
		}
	}
}

function emitAncestorPresence(
	steps: readonly RelationStep[],
	where: string | undefined,
	root: InstanceRoot,
): string {
	let destinationFilter = where ?? "true()";
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		const step = steps[index];
		const candidates = candidateCases(
			step.throughCaseType,
			destinationFilter,
			root,
		);
		const immediateIndex = `index/${step.identifier}`;
		destinationFilter = `count(${immediateIndex}) > 0 and selected(join(' ', ${candidates}/@case_id), ${immediateIndex})`;
	}
	return destinationFilter;
}

function emitSubcasePresence(
	identifier: string,
	ofCaseType: string | undefined,
	where: string | undefined,
	root: InstanceRoot,
): string {
	const candidates = candidateCases(ofCaseType, where ?? "true()", root);
	return `count(@case_id) > 0 and selected(join(' ', ${candidates}/index/${identifier}), @case_id)`;
}

function candidateCases(
	caseType: string | undefined,
	where: string,
	root: InstanceRoot,
): string {
	const typeFilter =
		caseType === undefined
			? ""
			: `@case_type=${quoteLiteral(caseType, "case-list-filter")} and `;
	return `instance('${root}')/${root}/case[${typeFilter}${
		caseType === undefined ? where : `(${where})`
	}]`;
}
