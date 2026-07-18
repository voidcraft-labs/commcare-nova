// components/builder/shared/cards/expression/DateAddCard.tsx
//
// Renders the `date-add` ValueExpression: `date + (interval ×
// quantity)`. Three slots:
//
//   - `date` — `ValueExpression` resolving to a date or datetime.
//     Recursive `ExpressionPicker` so authors can compose `today() +
//     7 days`, `prop(...) - 1 month`, etc.
//   - `interval` — closed enum (`seconds` / `minutes` / `hours` /
//     `days` / `weeks` / `months` / `years`). Plain dropdown.
//   - `quantity` — `ValueExpression` resolving to a numeric type.
//     Recursive `ExpressionPicker` keyed to `int` / `decimal`.
//
// Type-checker rules (per `checkExpression`'s `case "date-add"`):
//   - `date` must be `date` or `datetime`. The result type follows
//     the operand: `date + days = date`, `datetime + hours = datetime`.
//   - `quantity` must be `int` or `decimal`. The error path is
//     `[..., "quantity"]`; the editor's slot-side `useEditorErrorsAt`
//     captures it inline.

"use client";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import {
	ANY_CONSTRAINT,
	DATE_ADD_INTERVALS,
	type DateAddInterval,
	dateAdd,
	dateAddOperandConstraint,
	literal,
	numericConstraint,
	type SlotConstraint,
	term,
	today,
	type ValueExpression,
} from "@/lib/domain/predicate";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendSlot, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";

/** The quantity is always numeric. The date operand's exact temporal type
 * follows the parent result slot and is derived inside the component. */
const QUANTITY_CONSTRAINT = numericConstraint();

const INTERVAL_LABELS: Record<DateAddInterval, string> = {
	seconds: "Seconds",
	minutes: "Minutes",
	hours: "Hours",
	days: "Days",
	weeks: "Weeks",
	months: "Months",
	years: "Years",
};

/** Default `date-add` value — `today() + 7 days`. The seven-day
 *  default is the most authored shape (relative-date filters); the
 *  type checker validates both operands so the default lands clean. */
export function dateAddDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "date-add" }> {
	return dateAdd(today(), "days", term(literal(7)));
}

interface DateAddCardProps {
	readonly value: Extract<ValueExpression, { kind: "date-add" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
	/** `date-add` returns the exact type of its date operand, so the parent
	 *  result constraint must narrow that operand to date or datetime. */
	readonly constraint?: SlotConstraint;
}

export function DateAddCard({
	value,
	onChange,
	path,
	constraint = ANY_CONSTRAINT,
}: DateAddCardProps) {
	// Per-slot errors render via each `ExpressionPicker` shell's
	// `CardShell` footer at the matching slot path. The type checker
	// emits at `[..., "date"]` and `[..., "quantity"]`; the picker
	// mounted at each slot looks up the same path.

	const setDate = (next: ValueExpression) => {
		onChange(dateAdd(next, value.interval, value.quantity));
	};

	const setInterval = (next: DateAddInterval) => {
		onChange(dateAdd(value.date, next, value.quantity));
	};

	const setQuantity = (next: ValueExpression) => {
		onChange(dateAdd(value.date, value.interval, next));
	};
	const dateConstraint = dateAddOperandConstraint(constraint);

	return (
		<div className="space-y-3">
			<div>
				<div className="mb-1.5 text-[13px] font-medium text-nova-text-secondary">
					Starting date
				</div>
				<ExpressionPicker
					value={value.date}
					onChange={setDate}
					path={appendSlot(path, "date")}
					constraint={dateConstraint}
					variant="nested"
				/>
			</div>

			<div>
				<div className="mb-1.5 text-[13px] font-medium text-nova-text-secondary">
					Change by
				</div>
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
					<ExpressionPicker
						value={value.quantity}
						onChange={setQuantity}
						path={appendSlot(path, "quantity")}
						constraint={QUANTITY_CONSTRAINT}
						variant="nested"
					/>
					<IntervalMenu interval={value.interval} setInterval={setInterval} />
				</div>
			</div>
		</div>
	);
}

interface IntervalMenuProps {
	readonly interval: DateAddInterval;
	readonly setInterval: (interval: DateAddInterval) => void;
}

function IntervalMenu({ interval, setInterval }: IntervalMenuProps) {
	return (
		<Select
			value={interval}
			onValueChange={(next) => {
				if (
					next === "seconds" ||
					next === "minutes" ||
					next === "hours" ||
					next === "days" ||
					next === "weeks" ||
					next === "months" ||
					next === "years"
				) {
					setInterval(next);
				}
			}}
		>
			<SelectTrigger
				aria-label={`Interval ${INTERVAL_LABELS[interval]}`}
				className="h-11 border-white/[0.06] bg-nova-deep/50 px-3 text-sm text-nova-violet-bright not-disabled:hover:border-nova-violet/30 dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50"
			>
				<SelectValue>{INTERVAL_LABELS[interval]}</SelectValue>
			</SelectTrigger>
			<SelectContent align="end">
				{DATE_ADD_INTERVALS.map((nextInterval) => (
					<SelectItem
						key={nextInterval}
						value={nextInterval}
						className="min-h-11"
					>
						{INTERVAL_LABELS[nextInterval]}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
