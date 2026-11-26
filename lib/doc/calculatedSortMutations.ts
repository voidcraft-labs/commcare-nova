import { deepEqual } from "@/lib/doc/deepEqual";
import { sequenceMovesTo } from "@/lib/doc/mutations/sequence";
import type { Mutation } from "@/lib/doc/types";
import type { CalculatedSort, Uuid } from "@/lib/domain";

/** Preserve independent edits to the order, worker name and formula. */
export function calculatedSortMutations(
	moduleUuid: Uuid,
	before: readonly CalculatedSort[],
	after: readonly CalculatedSort[],
): Mutation[] {
	const kept = new Set(after.map((rule) => rule.uuid));
	const previous = new Map(before.map((rule) => [rule.uuid, rule]));
	const changes: Mutation[] = before
		.filter((rule) => !kept.has(rule.uuid))
		.map((rule) => ({
			kind: "removeCalculatedSort",
			moduleUuid,
			uuid: rule.uuid,
		}));
	for (const rule of after) {
		const old = previous.get(rule.uuid);
		if (!old) {
			changes.push({ kind: "addCalculatedSort", moduleUuid, sort: rule });
			continue;
		}
		const patch: Extract<Mutation, { kind: "updateCalculatedSort" }>["patch"] =
			{
				...(!deepEqual(old.expression, rule.expression) && {
					expression: rule.expression,
				}),
				...(old.direction !== rule.direction && { direction: rule.direction }),
				...(old.priority !== rule.priority && { priority: rule.priority }),
				...(old.comparator !== rule.comparator && {
					comparator: rule.comparator ?? null,
				}),
				...(old.blanks !== rule.blanks && { blanks: rule.blanks ?? null }),
				...(old.label !== rule.label && { label: rule.label ?? null }),
			};
		if (Object.keys(patch).length)
			changes.push({
				kind: "updateCalculatedSort",
				moduleUuid,
				uuid: rule.uuid,
				patch,
			});
	}
	const next = after.map((rule) => rule.uuid);
	const current = [
		...before.filter((rule) => kept.has(rule.uuid)),
		...after.filter((rule) => !previous.has(rule.uuid)),
	].map((rule) => rule.uuid);
	for (const move of sequenceMovesTo(current, next))
		changes.push({
			kind: "updateCalculatedSort",
			moduleUuid,
			uuid: move.uuid,
			after: move.after,
			patch: {},
		});
	return changes;
}
