import {
	and,
	matchAll,
	matchNone,
	or,
	type Predicate,
} from "@/lib/domain/predicate";
import type { StableListOperation } from "./stableListIdentity";

export function logicalClauses(
	kind: "and" | "or",
	clauses: readonly Predicate[],
): Predicate {
	const [first, second, ...rest] = clauses;
	if (first === undefined) return kind === "and" ? matchAll() : matchNone();
	if (second === undefined) return first;
	return kind === "and"
		? and(first, second, ...rest)
		: or(first, second, ...rest);
}
export type LogicalGroupAction =
	| {
			readonly kind: "replace";
			readonly index: number;
			readonly value: Predicate;
	  }
	| { readonly kind: "remove"; readonly index: number }
	| {
			readonly kind: "move";
			readonly index: number;
			readonly direction: -1 | 1;
	  }
	| { readonly kind: "group-next"; readonly index: number }
	| { readonly kind: "ungroup"; readonly index: number };
/** Actual authored group edits. Structural reduction only unwraps zero/one
 * clauses; sentinel clauses and nested groups remain as the author placed them. */
export function planLogicalGroupEdit(
	value: Extract<Predicate, { kind: "and" | "or" }>,
	action: LogicalGroupAction,
):
	| {
			readonly clauses: readonly Predicate[];
			readonly operation: StableListOperation;
			readonly focusIndex: number;
	  }
	| undefined {
	const index = action.index;
	if (!Number.isInteger(index) || index < 0 || index >= value.clauses.length)
		return undefined;
	const clauses = [...value.clauses];
	switch (action.kind) {
		case "replace":
			clauses[index] = action.value;
			return { clauses, operation: { kind: "replace" }, focusIndex: index };
		case "remove":
			clauses.splice(index, 1);
			return {
				clauses,
				operation: { kind: "splice", index, deleteCount: 1, insertCount: 0 },
				focusIndex: Math.min(index, clauses.length - 1),
			};
		case "move": {
			const toIndex = index + action.direction;
			if (toIndex < 0 || toIndex >= clauses.length) return undefined;
			const [moved] = clauses.splice(index, 1);
			clauses.splice(toIndex, 0, moved);
			return {
				clauses,
				operation: { kind: "move", fromIndex: index, toIndex },
				focusIndex: toIndex,
			};
		}
		case "group-next": {
			const second = clauses[index + 1];
			if (second === undefined) return undefined;
			clauses.splice(index, 2, {
				kind: value.kind === "and" ? "or" : "and",
				clauses: [clauses[index], second],
			});
			return {
				clauses,
				operation: { kind: "splice", index, deleteCount: 2, insertCount: 1 },
				focusIndex: index,
			};
		}
		case "ungroup": {
			const child = clauses[index];
			if (child.kind !== "and" && child.kind !== "or") return undefined;
			clauses.splice(index, 1, ...child.clauses);
			return {
				clauses,
				operation: {
					kind: "splice",
					index,
					deleteCount: 1,
					insertCount: child.clauses.length,
				},
				focusIndex: index,
			};
		}
	}
}
