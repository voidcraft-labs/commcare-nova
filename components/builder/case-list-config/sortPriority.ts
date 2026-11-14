// components/builder/case-list-config/sortPriority.ts
//
// Sort-priority resolution for the canvas-owned Default order editor.

import {
	type CaseListConfig,
	type Column,
	type ColumnSort,
	columnSort,
	orderedColumns,
	type Uuid,
} from "@/lib/domain";

/**
 * The column a Default order choice puts to the gate and then commits, before
 * it takes its rule. A field that is off the list comes back onto it in one
 * way in each layout. In a list with no tile the field inspector's List search
 * matches this switch is that way, so the choice keeps `notOnList` and the
 * gate's `sorted` line names the switch. In a tile list there is no switch:
 * the choice drops `notOnList`, so choosing it leaves the field hidden with
 * its rule, a tile list's hidden sorted column.
 */
export function orderChoiceColumn(column: Column, tiled: boolean): Column {
	if (!tiled || column.notOnList !== true) return column;
	const { notOnList: _notOnList, ...onTheList } = column;
	return onTheList as Column;
}

/**
 * The columns Default order commits for a sequence of rules: each rule
 * renumbered by its place, a column no rule names left unsorted, and a rule
 * over a column the list does not hold yet appended. A rule over a stored
 * column carries that column's list state from the rule, because the rule
 * column is the one the Add menu put to the gate: a tile list's field that is
 * off the list comes back onto it in the same write that gives it the rule.
 */
export function columnsAfterRuleSequence(
	columns: readonly Column[],
	rules: readonly Column[],
): Column[] {
	const ruleByUuid = new Map<
		Uuid,
		{ readonly rule: Column; readonly sort: ColumnSort }
	>();
	rules.forEach((rule, index) => {
		ruleByUuid.set(rule.uuid, {
			rule,
			sort: columnSort(rule.sort?.direction ?? "asc", index, rule.sort?.blanks),
		});
	});
	const next = columns.map((column): Column => {
		const entry = ruleByUuid.get(column.uuid);
		if (entry === undefined) {
			if (column.sort === undefined) return column;
			const { sort: _sort, ...withoutSort } = column;
			return withoutSort as Column;
		}
		const {
			sort: _sort,
			visibleInList: _visibleInList,
			notOnList: _notOnList,
			...rest
		} = column;
		return {
			...rest,
			...(entry.rule.visibleInList !== undefined && {
				visibleInList: entry.rule.visibleInList,
			}),
			...(entry.rule.notOnList === true && { notOnList: true }),
			sort: entry.sort,
		} as Column;
	});
	const known = new Set(columns.map((column) => column.uuid));
	for (const [uuid, { rule, sort }] of ruleByUuid) {
		if (known.has(uuid)) continue;
		next.push({ ...rule, sort } as Column);
	}
	return next;
}

/**
 * Resolve the sorted columns ordered by `sort.priority` ascending.
 * Tie-break to Results order: the column appearing earlier on the running
 * list wins on a priority collision. Same rule the
 * saga / preview / wire layers use; the editor maintains
 * uniqueness on save but the tie-break exists for transient
 * (undo / partial-save) states.
 *
 * The schema doesn't guarantee priority uniqueness or contiguity:
 * per-column sort toggles drop a column's sort slot without
 * renumbering its peers, which leaves gaps (e.g. priorities
 * `[0, 1, 2]` with the middle column cleared becomes `[0, 2]`).
 * Gaps are harmless: every consumer orders by this resolution, and
 * the editor's drag handler renumbers to a clean 0..N-1.
 */
export function resolveSortedColumns(
	config: CaseListConfig,
): readonly Column[] {
	const sorted: { column: Column; priority: number; index: number }[] = [];
	const resultsOrdered = orderedColumns(config, "list");
	for (let i = 0; i < resultsOrdered.length; i++) {
		const col = resultsOrdered[i];
		if (col === undefined) continue;
		if (col.sort === undefined) continue;
		sorted.push({ column: col, priority: col.sort.priority, index: i });
	}
	sorted.sort((a, b) => {
		if (a.priority !== b.priority) return a.priority - b.priority;
		return a.index - b.index;
	});
	return sorted.map((entry) => entry.column);
}
