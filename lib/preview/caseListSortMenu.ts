// lib/preview/caseListSortMenu.ts
//
// The running case list's Sort by, as the platform Preview plays it
// (`platform.ts`, `sortMenu`): what it lists, what a pick does to the order,
// and what lets a pick go. The list's own order and its fields are the order
// plan's (`lib/domain/caseListOrder.ts`); a pick orders the list by one field
// alone (rule 11), and the case store orders the rows by it
// (`engine/caseDataBindingHelpers.ts::buildCaseStoreSortKeys`), so every page
// follows the pick.

import { z } from "zod";
import type {
	CaseListOrderPlan,
	CaseListOrderRule,
	Column,
	SortDirection,
} from "@/lib/domain";
import type { PreviewPlatformRules } from "./platform";

/** One pick: the column whose field or carrier orders the list, and whether
 *  the worker turned its direction around. */
export interface CaseListSortPick {
	readonly column: string;
	readonly reversed: boolean;
}

/**
 * The worker's picks in the list's Sort by, newest first. With none the list
 * keeps its own order. `thenListOrder` says whether the list's own order
 * breaks the ties the picks leave, which it does on Android, where each pick
 * sorts the list it holds again with a stable sort.
 */
export interface CaseListSortChoice {
	readonly picks: readonly CaseListSortPick[];
	readonly thenListOrder: boolean;
}

/** The list's own order, before any pick. */
export const LIST_ORDER: CaseListSortChoice = Object.freeze({
	picks: Object.freeze([]),
	thenListOrder: true,
});

/** The choice as a running read sends it, plain JSON, checked again on the
 *  server, which orders only by a pick its plan holds. */
export const caseListSortChoiceSchema = z.strictObject({
	picks: z
		.array(
			z.strictObject({
				column: z.string().min(1).max(200),
				reversed: z.boolean(),
			}),
		)
		.max(500),
	thenListOrder: z.boolean(),
});

type SortMenuColumn =
	| Column
	| (Pick<Column, "uuid" | "header"> & {
			readonly kind: "independent-calculation";
	  });

/** One field of the short detail, a carrier included, in detail order. */
interface SortField {
	readonly column: SortMenuColumn;
	readonly hidden: boolean;
	readonly rule:
		| Pick<CaseListOrderRule, "order" | "direction" | "label">
		| undefined;
}

function detailFields(
	plan: CaseListOrderPlan,
	columns: readonly Column[],
): readonly SortField[] {
	return [
		...plan.fields.map((field) => ({
			column: field.column,
			hidden: field.hidden,
			rule: field.rule,
		})),
		...plan.carriers.flatMap((carrier) => {
			const column = columns.find(
				(candidate) => candidate.uuid === carrier.column,
			);
			return column === undefined
				? []
				: [{ column, hidden: true, rule: carrier.rule }];
		}),
		...plan.calculations.map((calc) => ({
			column: {
				kind: "independent-calculation" as const,
				uuid: calc.sort.uuid,
				header: calc.sort.label ?? "",
			},
			hidden: true,
			rule: {
				order: calc.order,
				direction: calc.sort.direction,
				...(calc.sort.label && {
					label: { column: calc.sort.uuid, text: calc.sort.label },
				}),
			},
		})),
	];
}

/** The fields the list's own order sorts by, in its order. */
function listOrderFields(fields: readonly SortField[]): readonly SortField[] {
	return fields
		.filter((field) => field.rule !== undefined)
		.sort((a, b) => (a.rule?.order ?? 0) - (b.rule?.order ?? 0));
}

/** One entry of the list's Sort by. */
export interface CaseListSortOption {
	/** The column whose field or carrier the entry orders by. */
	readonly column: SortMenuColumn;
	/** The name a device shows: a shown field's header, a hidden field's
	 *  name in Sort by, `""` where it shows none (a Web Apps tile's unnamed
	 *  sort field). */
	readonly name: string;
	/** Which way the entry's arrow points, where the platform marks it. */
	readonly arrow?: "up" | "down";
	/** Its place in the list's own order, where Android numbers it. */
	readonly priority?: number;
}

const arrowOf = (direction: SortDirection, reversed: boolean) =>
	(direction === "desc") !== reversed ? "down" : "up";

/**
 * What the list's Sort by lists for `rules`, with the marks the choice gives
 * each entry. `plan` is the plan of the list Preview shows, in the language
 * it shows (its headers and its names in Sort by), and `columns` the list's
 * columns, which name a carrier's.
 *
 * Android lists every field whose header is not blank, in detail order: a
 * shown field always has one, since a blank header is written as a no-break
 * space (`lib/commcare/localeFile.ts::hqLocaleFileValue`), and a hidden field
 * or a carrier only where its rule carries a name. It marks the picked field
 * with its direction, and before any pick every field of the list's own
 * order, numbered where there are several. Web Apps lists the sort fields in
 * the list's order, in a list of columns only those it shows, and marks the
 * picked one with a down arrow, an up one once picked again.
 */
export function caseListSortOptions(args: {
	readonly plan: CaseListOrderPlan;
	readonly columns: readonly Column[];
	readonly rules: PreviewPlatformRules["sortMenu"];
	readonly tiled: boolean;
	readonly choice: CaseListSortChoice;
}): readonly CaseListSortOption[] {
	const { plan, columns, rules, tiled, choice } = args;
	const fields = detailFields(plan, columns);
	const nameOf = (field: SortField) =>
		field.hidden ? (field.rule?.label?.text ?? "") : field.column.header;
	const listed =
		rules.lists === "named-fields"
			? fields.filter((field) => !field.hidden || nameOf(field) !== "")
			: listOrderFields(fields).filter((field) => tiled || !field.hidden);
	const pick = choice.picks[0];
	const ordered = listOrderFields(fields);
	return listed.map((field): CaseListSortOption => {
		const option = { column: field.column, name: nameOf(field) };
		const direction = field.rule?.direction ?? "asc";
		if (pick !== undefined) {
			if (pick.column !== field.column.uuid) return option;
			return {
				...option,
				arrow:
					rules.marks === "pick-only"
						? pick.reversed
							? "up"
							: "down"
						: arrowOf(direction, pick.reversed),
			};
		}
		if (rules.marks === "pick-only") return option;
		const place = ordered.indexOf(field);
		if (place < 0) return option;
		return {
			...option,
			arrow: arrowOf(direction, false),
			...(ordered.length > 1 && { priority: place + 1 }),
		};
	});
}

/**
 * The choice after the worker picks `column`. A pick of the field already
 * picked turns it around; any other pick starts in the field's own
 * direction, but on Android a first pick of the list's only sort field turns
 * it around, since the list already sorts by it. Android keeps the earlier
 * picks to break ties; Web Apps keeps the one pick.
 */
export function pickCaseListSort(
	choice: CaseListSortChoice,
	column: string,
	plan: CaseListOrderPlan,
	columns: readonly Column[],
	rules: PreviewPlatformRules["sortMenu"],
): CaseListSortChoice {
	const latest = choice.picks[0];
	const ordered = listOrderFields(detailFields(plan, columns));
	const reversed =
		latest === undefined
			? rules.firstPickOfOnlyRule === "reverses" &&
				ordered.length === 1 &&
				ordered[0]?.column.uuid === column
			: latest.column === column && !latest.reversed;
	const pick = { column, reversed };
	return rules.ties === "earlier-order"
		? {
				picks: [pick, ...choice.picks.filter((p) => p.column !== column)],
				thenListOrder: true,
			}
		: { picks: [pick], thenListOrder: false };
}

/** The choice once the filter's text changes: Web Apps lets a pick go,
 *  Android keeps it. */
export function caseListSortAfterFilterText(
	choice: CaseListSortChoice,
	rules: PreviewPlatformRules["sortMenu"],
): CaseListSortChoice {
	return rules.filterText === "lets-go" ? LIST_ORDER : choice;
}
