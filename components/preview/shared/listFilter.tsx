// components/preview/shared/listFilter.tsx
//
// The case list's own filter box, and the rule it runs: Core's entity
// filter (`lib/preview/listFilterMatch.ts`), the one CommCare runs when a
// worker types into a list's search box. Every typed term has to match
// somewhere in the row, with accents folded and case ignored; with the project
// space's fuzzy search on, a near miss also matches a word of a field's sort
// text. A device matches every field of the list, so the box also matches each
// field hidden from Results and each carrier of the list's order plan, each
// read as the device holds it. How the
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
import type { CaseListOrderPlan, Column } from "@/lib/domain";
import type { ColumnDisplayContext } from "@/lib/preview/columnDisplay";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import {
	caseListFilterFields,
	caseListOrderTerms,
	type ImageReference,
	orderTermsTie,
} from "@/lib/preview/engine/caseListFilterFields";
import { filterTerms, rowFilterScore } from "@/lib/preview/listFilterMatch";
import type { PreviewPlatformRules } from "@/lib/preview/platform";
import { useDeferredFocus } from "@/lib/ui/hooks/useDeferredFocus";
import { useWorkerMessage } from "./WorkerText";

/** What the filter needs besides the text: the project space's fuzzy search,
 *  the platform's rule, whether the worker has changed the box since the list
 *  opened, and the path a device holds for each image a mapping shows. */
export interface ListFilterOptions {
	readonly fuzzy: boolean;
	readonly rules: PreviewPlatformRules["listFilter"];
	readonly edited: boolean;
	readonly imageReference: ImageReference;
}

/**
 * The rows that survive the filter text, as the platform shows them.
 *
 * A row's fields are what a device's filter reads
 * (`lib/preview/engine/caseListFilterFields.ts::caseListFilterFields`): the
 * text each field's template evaluates to, which is not always what its cell
 * draws.
 *
 * The matches keep the given order with `fuzzy` off. With `fuzzy` on they
 * are stably re-sorted by ascending score: over the whole list under
 * `closest-first`, and under `closest-among-ties` within each run of matches
 * the list's order ties on every rule (`caseListOrderTerms`, `orderTermsTie`),
 * as Formplayer sorts the filter's closest-first matches again by the list's
 * order with a stable sort. An empty text returns every row under `skipped`
 * and before the worker has edited the box; once edited, `runs-once-edited`
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
			caseListFilterFields(columns, row, context, plan, options.imageReference),
			options.fuzzy,
		);
		return verdict.matches ? [{ row, score: verdict.score }] : [];
	});
	if (!options.fuzzy) return matches.map((match) => match.row);
	const byScore = (a: { score: number }, b: { score: number }) =>
		a.score - b.score;
	if (options.rules.fuzzyOrder === "closest-first")
		return matches.sort(byScore).map((match) => match.row);
	const ordered: Row[] = [];
	let run: { row: Row; score: number }[] = [];
	let runTerms: ReturnType<typeof caseListOrderTerms> = [];
	for (const match of matches) {
		const matchTerms = caseListOrderTerms(match.row, context, plan);
		if (run.length > 0 && !orderTermsTie(runTerms, matchTerms)) {
			for (const tied of run.sort(byScore)) ordered.push(tied.row);
			run = [];
		}
		if (run.length === 0) runTerms = matchTerms;
		run.push(match);
	}
	for (const tied of run.sort(byScore)) ordered.push(tied.row);
	return ordered;
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
