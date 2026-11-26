// components/builder/case-list-config/sortPriority.ts
//
// Sort-priority resolution for the canvas-owned Default order editor.

import {
	type CalculatedSort,
	type CaseListConfig,
	type Column,
	type ColumnSort,
	calculatedColumn,
	choicePrefixLength,
	columnSort,
	orderedColumns,
	type SortComparison,
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
	positions?: ReadonlyMap<Uuid, number>,
): Column[] {
	const ruleByUuid = new Map<
		Uuid,
		{ readonly rule: Column; readonly sort: ColumnSort }
	>();
	rules.forEach((rule, index) => {
		ruleByUuid.set(rule.uuid, {
			rule,
			sort: columnSort(
				rule.sort?.direction ?? "asc",
				positions?.get(rule.uuid) ?? index,
				rule.sort?.blanks,
				rule.sort?.label,
				rule.sort?.comparator,
				rule.sort?.menuPosition,
			),
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

/** A calculation shares the Default order controls with a column. This
 * projection lives only in the composer and never enters a Results or Details list. */
export function orderingCalculationRow(
	rule: CalculatedSort,
): Extract<Column, { kind: "calculated" }> {
	return calculatedColumn(
		rule.uuid,
		rule.label ?? "Order calculation",
		rule.expression,
		{
			visibleInList: false,
			visibleInDetail: false,
			sort: columnSort(
				rule.direction,
				rule.priority,
				rule.blanks,
				rule.label,
				rule.comparator,
			),
		},
	);
}

/**
 * A rule after its comparison is chosen. Choosing the field's own comparison,
 * or "Use field order", stores none: a rule keeps a comparison only where the
 * author chose one the field would not use by itself.
 */
export function ruleWithComparison(
	sort: ColumnSort,
	choice: SortComparison | undefined,
	defaultComparison: SortComparison | undefined,
): ColumnSort {
	const { comparator: _previous, ...rest } = sort;
	return choice === undefined || choice === defaultComparison
		? rest
		: { ...rest, comparator: choice };
}

/**
 * A group of Sort by choices after one named choice moves to `position`
 * among the named ones. An unnamed choice is not listed in Sort by, so it
 * keeps its slot and the named ones move around it. `undefined` where the
 * move changes nothing or names no place.
 */
export function choicesAfterMove(
	choices: readonly Uuid[],
	named: (uuid: Uuid) => boolean,
	uuid: Uuid,
	position: number,
): Uuid[] | undefined {
	const namedChoices = choices.filter(named);
	const previous = namedChoices.indexOf(uuid);
	if (
		previous < 0 ||
		position < 0 ||
		position >= namedChoices.length ||
		previous === position
	)
		return undefined;
	namedChoices.splice(previous, 1);
	namedChoices.splice(position, 0, uuid);
	let next = 0;
	return choices.map((id) => (named(id) ? namedChoices[next++] : id));
}

/**
 * The columns after the extra fields of Sort by take the order `choices`.
 * Workers see a sort-only property's choice in its rule's priority order
 * unless it is introduced earlier, so only the shortest prefix that puts the
 * choices in this order holds a `menuPosition` (`choicePrefixLength`); every
 * other rule's is removed.
 */
export function columnsWithChoiceOrder(
	columns: readonly Column[],
	choices: readonly Uuid[],
): Column[] {
	const byUuid = new Map(columns.map((column) => [column.uuid, column]));
	const prefix = choicePrefixLength(
		choices,
		(id) => byUuid.get(id)?.sort?.priority ?? 0,
	);
	const positions = new Map(choices.map((id, index) => [id, index]));
	return columns.map((column) => {
		const index = positions.get(column.uuid);
		if (!column.sort || index === undefined) return column;
		const { menuPosition: _previous, ...sort } = column.sort;
		return {
			...column,
			sort: index < prefix ? { ...sort, menuPosition: index } : sort,
		};
	});
}
