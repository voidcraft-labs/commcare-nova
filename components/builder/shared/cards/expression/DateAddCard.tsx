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
import { Menu } from "@base-ui/react/menu";
import { useRef } from "react";
import {
	DATE_ADD_INTERVALS,
	type DateAddInterval,
	dateAdd,
	dateOperandConstraint,
	literal,
	numericConstraint,
	term,
	today,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendSlot, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";

/** The `date` operand resolves to date or datetime; `quantity` is
 *  numeric — module-consts for stable identities across renders. */
const DATE_CONSTRAINT = dateOperandConstraint();
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
}

export function DateAddCard({ value, onChange, path }: DateAddCardProps) {
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

	return (
		<div className="space-y-2">
			<div>
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
					Date
				</div>
				<ExpressionPicker
					value={value.date}
					onChange={setDate}
					path={appendSlot(path, "date")}
					constraint={DATE_CONSTRAINT}
					variant="nested"
				/>
			</div>

			<div className="grid grid-cols-[auto_1fr] gap-2 items-start">
				<div>
					<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
						Interval
					</div>
					<IntervalMenu interval={value.interval} setInterval={setInterval} />
				</div>
				<div>
					<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
						Quantity
					</div>
					<ExpressionPicker
						value={value.quantity}
						onChange={setQuantity}
						path={appendSlot(path, "quantity")}
						constraint={QUANTITY_CONSTRAINT}
						variant="nested"
					/>
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
	const triggerRef = useRef<HTMLButtonElement>(null);
	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Interval: ${INTERVAL_LABELS[interval]}`}
				className="group flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
			>
				<span>{INTERVAL_LABELS[interval]}</span>
				<svg
					aria-hidden="true"
					width="10"
					height="10"
					viewBox="0 0 10 10"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				>
					<path
						d="M2 3.5L5 6.5L8 3.5"
						stroke="currentColor"
						strokeWidth="1.2"
						fill="none"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
				>
					<Menu.Popup className={MENU_POPUP_CLS}>
						{DATE_ADD_INTERVALS.map((iv, i) => {
							const isActive = iv === interval;
							const last = DATE_ADD_INTERVALS.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							return (
								<Menu.Item
									key={iv}
									onClick={() => setInterval(iv)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									}`}
								>
									<span>{INTERVAL_LABELS[iv]}</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
