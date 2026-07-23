"use client";

import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { Button } from "@/components/shadcn/button";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import type { EditorPath } from "./path";
import {
	type EditorSearchInputDecl,
	searchInputDisplayLabel,
} from "./searchInputPresentation";

interface RuleFocusContextValue {
	readonly activePath: EditorPath;
	readonly open: (path: EditorPath) => void;
}

const RuleFocusContext = createContext<RuleFocusContextValue | null>(null);

export function pathsEqual(left: EditorPath, right: EditorPath): boolean {
	return (
		left.length === right.length &&
		left.every((segment, index) => segment === right[index])
	);
}

export function RuleFocusProvider({
	activePath,
	open,
	children,
}: {
	readonly activePath: EditorPath;
	readonly open: (path: EditorPath) => void;
	readonly children: ReactNode;
}) {
	const value = useMemo(() => ({ activePath, open }), [activePath, open]);
	return (
		<RuleFocusContext.Provider value={value}>
			{children}
		</RuleFocusContext.Provider>
	);
}

/** Null outside the focus workbench so the standalone AST editors retain
 * their existing inline-tree presentation. */
export function useRuleFocusContext(): RuleFocusContextValue | null {
	return useContext(RuleFocusContext);
}

export function RuleFocusSummary({
	path,
	icon,
	title,
	description,
	hasErrors = false,
}: {
	readonly path: EditorPath;
	readonly icon: IconifyIcon;
	readonly title: string;
	readonly description: string;
	readonly hasErrors?: boolean;
}) {
	const focus = useRuleFocusContext();
	if (focus === null) return null;
	return (
		<Button
			type="button"
			variant="ghost"
			size="xl"
			onClick={() => focus.open(path)}
			aria-label={`Edit ${title.toLocaleLowerCase()}`}
			data-rule-focus-summary
			data-rule-focus-target={JSON.stringify(path)}
			className="h-auto min-h-14 w-full justify-start gap-3 rounded-lg px-2.5 py-2 text-left whitespace-normal not-disabled:hover:bg-white/[0.04]"
		>
			<span className="grid size-9 shrink-0 place-items-center rounded-lg bg-nova-violet/[0.08] text-nova-violet-bright">
				<Icon icon={icon} width="16" height="16" />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block text-sm font-semibold text-nova-text">
					{title}
				</span>
				<span className="mt-0.5 block text-[13px] leading-relaxed text-nova-text-muted">
					{description}
				</span>
				{hasErrors && (
					<span className="mt-1 block text-xs font-medium text-nova-rose">
						Needs attention
					</span>
				)}
			</span>
			<Icon
				icon={tablerChevronRight}
				className="size-4 shrink-0 text-nova-text-muted"
			/>
		</Button>
	);
}

export function expressionFocusTitle(value: ValueExpression): string {
	switch (value.kind) {
		case "term":
			return "Value";
		case "id-of":
			return "Created case ID";
		case "acting-user":
			return "Person using the app";
		case "unowned":
			return "No owner";
		case "today":
			return "Today's date";
		case "now":
			return "Current date and time";
		case "date-add":
			return "Adjusted date";
		case "date-coerce":
			return "Date from a value";
		case "datetime-coerce":
			return "Date and time from a value";
		case "double":
			return "Number from a value";
		case "arith":
			return "Math";
		case "concat":
			return "Combined text";
		case "coalesce":
			return "First available value";
		case "if":
			return "Value chosen by a condition";
		case "switch":
			return "Value chosen by matching";
		case "count":
			return "Count of related cases";
		case "unwrap-list":
			return "Saved selections";
		case "format-date":
			return "Formatted date";
		case "table-lookup":
			return "Unavailable value";
	}
}

export function expressionFocusDescription(value: ValueExpression): string {
	switch (value.kind) {
		case "term":
			return "A case value, search answer, or entered value";
		case "id-of":
			return "Uses the case created by an earlier operation";
		case "acting-user":
			return "Assigns the case to the person using the app";
		case "unowned":
			return "Leaves the case without an owner";
		case "today":
			return "Uses the date when the app runs";
		case "now":
			return "Uses the date and time when the app runs";
		case "date-add":
			return "Moves a date forward or backward";
		case "date-coerce":
			return "Reads another value as a date";
		case "datetime-coerce":
			return "Reads another value as a date and time";
		case "double":
			return "Reads another value as a number";
		case "arith":
			return "Combines two number values";
		case "concat":
			return `${value.parts.length} ${value.parts.length === 1 ? "part" : "parts"} joined as text`;
		case "coalesce":
			return `${value.values.length} ${value.values.length === 1 ? "choice" : "choices"}, using the first one with a value`;
		case "if":
			return "Uses one value when a condition matches and another when it doesn't";
		case "switch":
			return `${value.cases.length} ${value.cases.length === 1 ? "match" : "matches"}, plus a value for everything else`;
		case "count":
			return value.where === undefined
				? "Counts every case on the chosen connection"
				: "Counts connected cases that match a condition";
		case "unwrap-list":
			return "Reads several saved selections from one value";
		case "format-date":
			return "Writes a date in the chosen style";
		case "table-lookup":
			return "This saved value cannot be opened in the editor yet";
	}
}

export function predicateFocusTitle(value: Predicate): string {
	switch (value.kind) {
		case "and":
			return "All conditions match";
		case "or":
			return "Any condition matches";
		case "not":
			return "Exclude when";
		case "when-input-present":
			return "Condition after a search answer";
		case "exists":
			return "Matching related case";
		case "missing":
			return "No matching related case";
		case "eq":
			return "Is";
		case "neq":
			return "Isn’t";
		case "gt":
			return "Is more than";
		case "gte":
			return "Is at least";
		case "lt":
			return "Is less than";
		case "lte":
			return "Is at most";
		case "in":
			return "Is any of";
		case "between":
			return "Is between";
		case "is-null":
			return "Was never recorded";
		case "is-blank":
			return "Is blank";
		case "match":
			return "Matches text";
		case "multi-select-contains":
			return value.quantifier === "all"
				? "Includes every option"
				: "Includes any option";
		case "within-distance":
			return "Is near";
		case "match-all":
			return "Include every case";
		case "match-none":
			return "Exclude every case";
	}
}

export function predicateFocusDescription(
	value: Predicate,
	knownInputs: readonly EditorSearchInputDecl[] = [],
): string {
	switch (value.kind) {
		case "and":
		case "or":
			return `${value.clauses.length} ${value.clauses.length === 1 ? "condition" : "conditions"}`;
		case "not":
			return "Excludes cases when the condition inside matches";
		case "when-input-present":
			return value.input.name
				? `Applies after ${searchInputDisplayLabel(value.input.name, knownInputs)} has an answer`
				: "Applies after the chosen search field has an answer";
		case "exists":
			return value.where === undefined
				? "Checks whether a connected case exists"
				: "Checks whether a connected case matches a condition";
		case "missing":
			return value.where === undefined
				? "Checks that no connected case exists"
				: "Checks that no connected case matches a condition";
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return "Compares case information with another value";
		case "in":
			return `${value.values.length} ${value.values.length === 1 ? "choice" : "choices"}`;
		case "between":
			return "Checks whether a value falls inside a range";
		case "is-null":
			return "Checks whether a value was never recorded";
		case "is-blank":
			return "Checks whether a value is empty or missing";
		case "match":
			return "Looks for a flexible text or date match";
		case "multi-select-contains":
			return `${value.values.length} ${value.values.length === 1 ? "option" : "options"}`;
		case "within-distance":
			return `Within ${value.distance} ${value.unit}`;
		case "match-all":
			return "This condition always matches";
		case "match-none":
			return "This condition never matches";
	}
}
