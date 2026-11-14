// components/preview/shared/listFilter.tsx
//
// The case list's own filter box, and the rule it runs: Core's entity
// filter (`lib/preview/listFilterMatch.ts`), the one CommCare runs when a
// worker types into a list's search box. Every typed term has to match
// somewhere in the row, with accents folded and case ignored; with the project
// space's fuzzy search on, a near miss also matches a word of a field's sort
// text. A device matches every field of the list, so the box also matches each
// field hidden from Results and each carrier of the list's order plan. How the
// typed text splits into terms, what closeness does to the order and what an
// emptied box does are the platform's (`PreviewPlatformRules.listFilter`). It
// runs entirely client-side over the rows already on screen: the authored
// search fields query the case store, this narrows what came back.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerX from "@iconify-icons/tabler/x";
import { useId, useRef } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import type {
	CaseListOrderPlan,
	CaseListShortField,
	Column,
	Uuid,
} from "@/lib/domain";
import {
	type ColumnDisplayContext,
	mappingPositionText,
	projectColumnDisplay,
} from "@/lib/preview/columnDisplay";
import { caseRowDisplayValue } from "@/lib/preview/engine/caseDataBindingClient";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { filterTerms, rowFilterScore } from "@/lib/preview/listFilterMatch";
import type { PreviewPlatformRules } from "@/lib/preview/platform";
import { useDeferredFocus } from "@/lib/ui/hooks/useDeferredFocus";
import { useWorkerMessage } from "./WorkerText";

/** What the filter needs besides the text: the project space's fuzzy search,
 *  the platform's rule, and whether the worker has changed the box since the
 *  list opened. */
export interface ListFilterOptions {
	readonly fuzzy: boolean;
	readonly rules: PreviewPlatformRules["listFilter"];
	readonly edited: boolean;
}

/**
 * The rows that survive the filter text, as the platform shows them.
 *
 * A row's fields are what a device's filter reads (commcare-core
 * `util/EntitySortUtil.sortEntities`), in the short detail's order: each
 * shown column's text, and with the list's order plan each hidden field's
 * text (the raw property value, or a hidden calculated column's value) and
 * each carrier's raw value, a hidden field's template and HQ's appended
 * carrier both holding the raw value. A field's sort text, which fuzzy search
 * reads, is the value its plan key orders by; a field that keeps no key has
 * none, and a carrier's raw value is its own.
 *
 * The matches keep the given order with `fuzzy` off or under `list-order`,
 * and are stably re-sorted by ascending score with `fuzzy` on under
 * `closest-first`. An empty text returns every row under `skipped` and
 * before the worker has edited the box; once edited, `runs-once-edited`
 * runs it as the one empty term it splits into. Text of separators alone
 * gives no terms, which every row passes.
 */
export function rowsMatchingFilterText<Row extends CaseRowWithCalculated>(
	columns: readonly Column[],
	rows: readonly Row[],
	filterText: string,
	context: ColumnDisplayContext,
	plan: CaseListOrderPlan | undefined,
	options: ListFilterOptions,
): readonly Row[] {
	if (
		filterText === "" &&
		(options.rules.emptyText === "skipped" || !options.edited)
	)
		return rows;
	const terms = filterTerms(filterText, options.rules.terms);
	if (terms.length === 0) return rows;
	const matches = rows.flatMap((row) => {
		const verdict = rowFilterScore(
			terms,
			filterFields(columns, row, context, plan),
			options.fuzzy,
		);
		return verdict.matches ? [{ row, score: verdict.score }] : [];
	});
	if (options.fuzzy && options.rules.fuzzyOrder === "closest-first")
		matches.sort((a, b) => a.score - b.score);
	return matches.map((match) => match.row);
}

/** A row's fields as the device's filter reads them, in the short detail's order. */
function filterFields(
	columns: readonly Column[],
	row: CaseRowWithCalculated,
	context: ColumnDisplayContext,
	plan: CaseListOrderPlan | undefined,
): { readonly text: string; readonly sortText: string | null }[] {
	const shownText = (column: Column) =>
		projectColumnDisplay(column, row, context).text;
	if (plan === undefined)
		return columns.map((column) => ({
			text: shownText(column),
			sortText: null,
		}));
	const shown = new Set<Uuid>(columns.map((column) => column.uuid));
	const named = new Set<Uuid>();
	const fields: { text: string; sortText: string | null }[] = [];
	for (const field of plan.fields) {
		const { column } = field;
		named.add(column.uuid);
		if (!field.hidden && !shown.has(column.uuid)) continue;
		const text =
			!field.hidden || column.kind === "calculated"
				? shownText(column)
				: caseRowDisplayValue(row, column.field);
		fields.push({ text, sortText: sortTextOf(field, text, row, context) });
	}
	for (const column of columns)
		if (!named.has(column.uuid))
			fields.push({ text: shownText(column), sortText: null });
	for (const carrier of plan.carriers) {
		const raw = caseRowDisplayValue(row, carrier.property);
		fields.push({ text: raw, sortText: raw });
	}
	return fields;
}

/**
 * The text a field's plan key orders by, which fuzzy search reads: the raw
 * value for `property`; the column's shown text for `option-label`,
 * `interval-text` and `calculated`; the markdown a link writes for
 * `link-text` (`[text](value)`, blank for a blank value, as the case store's
 * key and the device's sort expression read it); the position text for
 * `mapping-position`; `null` for a field that keeps no key.
 */
function sortTextOf(
	field: CaseListShortField,
	text: string,
	row: CaseRowWithCalculated,
	context: ColumnDisplayContext,
): string | null {
	const { key, column } = field;
	if (key === undefined) return null;
	switch (key.kind) {
		case "property":
			return caseRowDisplayValue(row, key.property);
		case "option-label":
		case "interval-text":
		case "calculated":
			return field.hidden
				? projectColumnDisplay(column, row, context).text
				: text;
		case "link-text": {
			if (column.kind !== "link") return null;
			const value = caseRowDisplayValue(row, column.field);
			return value === "" ? "" : `[${column.linkText}](${value})`;
		}
		case "mapping-position":
			return column.kind === "id-mapping" || column.kind === "image-map"
				? mappingPositionText(column, row, context.reading)
				: null;
	}
}

/**
 * The filter box itself. Fully controlled; the clear affordance only
 * appears once there's something to clear.
 */
export function ListFilterBox({
	value,
	onChange,
	resultCount,
	scope = "results",
}: {
	readonly value: string;
	readonly onChange: (next: string) => void;
	/** Rows surviving the filter: read out under the box only while
	 *  a filter is active, so the narrowing is never silent. */
	readonly resultCount?: number;
	/** A paged case list can only apply this CommCare-style client filter to
	 * the bounded rows on screen. Naming that scope prevents a zero result from
	 * pretending no matching case exists on another server page. */
	readonly scope?: "results" | "page";
}) {
	const message = useWorkerMessage();
	const id = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const deferFocus = useDeferredFocus();
	return (
		<div>
			<label
				htmlFor={id}
				className="mb-1.5 block text-[13px] font-medium text-nova-text-secondary"
			>
				{message(scope === "page" ? "filterPage" : "filterResults")}
			</label>
			<div className="relative">
				<Icon
					icon={tablerSearch}
					width="16"
					height="16"
					className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-nova-text-muted"
				/>
				<Input
					ref={inputRef}
					id={id}
					type="text"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					autoComplete="off"
					data-1p-ignore
					className="nova-focusable min-h-11 w-full rounded-lg border-pv-input-border bg-pv-surface pr-11 pl-9 text-[14px] text-nova-text dark:bg-pv-surface"
				/>
				{value !== "" && (
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							onChange("");
							deferFocus(() => inputRef.current?.focus());
						}}
						aria-label={message("clearFilter")}
						className="absolute inset-y-0 right-0 h-full w-11 rounded-lg text-nova-text-muted not-disabled:hover:bg-transparent"
					>
						<Icon icon={tablerX} width="14" height="14" />
					</Button>
				)}
			</div>
			{value !== "" && resultCount !== undefined && resultCount > 0 && (
				<p className="mt-2 text-xs text-nova-text-secondary" role="status">
					{message(scope === "page" ? "onThisPage" : "countShown", {
						count: message(
							resultCount === 1 ? "caseCountOne" : "caseCountMany",
							{ count: resultCount.toLocaleString() },
						),
					})}
				</p>
			)}
		</div>
	);
}
