// components/builder/case-list-config/cards/expression/ArithCard.tsx
//
// Renders the `arith` ValueExpression — five-op binary numeric
// arithmetic (`+` / `-` / `*` / `div` / `mod`). The `op` discriminator
// stays inline at the operator slot so authors flip between the five
// operations without a kind swap.
//
// Slot shape: `left` + `op` + `right`. Each operand is a recursive
// `ValueExpression`; the result type follows `int×int=int / mixed=
// decimal` promotion. The `div` and `mod` operators use the spelled-
// out CCHQ vocabulary names rather than `/` (the XPath path
// separator) and `%` (no XPath meaning).
//
// Type-checker rule (per `checkExpression`'s `case "arith":`):
// both operands must resolve to numeric types. Errors land at
// `[..., "left"]` and `[..., "right"]`; the editor captures each
// inline next to its operand picker.

"use client";
import { Menu } from "@base-ui/react/menu";
import { useRef } from "react";
import {
	ARITH_OPS,
	type ArithOp,
	arith,
	literal,
	term,
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

const OP_LABELS: Record<ArithOp, { symbol: string; label: string }> = {
	"+": { symbol: "+", label: "Add" },
	"-": { symbol: "−", label: "Subtract" },
	"*": { symbol: "×", label: "Multiply" },
	div: { symbol: "÷", label: "Divide" },
	mod: { symbol: "%", label: "Modulo (remainder)" },
};

/** Default `arith` — `0 + 0`. Both operands are int literals so the
 *  type checker accepts the seed clean. The op defaults to `+` —
 *  the most common arithmetic operation; authors flip via the
 *  inline op menu. */
export function arithDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "arith" }> {
	return arith("+", term(literal(0)), term(literal(0)));
}

interface ArithCardProps {
	readonly value: Extract<ValueExpression, { kind: "arith" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

export function ArithCard({ value, onChange, path }: ArithCardProps) {
	// Per-slot errors render via each `ExpressionPicker` shell's
	// `CardShell` footer — the picker mounted at `[..., "left"]`
	// looks up errors at the same path the type checker emits to,
	// so a parallel `<InlineError>` here would render the same
	// message twice.

	const setLeft = (next: ValueExpression) => {
		onChange(arith(value.op, next, value.right));
	};

	const setOp = (op: ArithOp) => {
		onChange(arith(op, value.left, value.right));
	};

	const setRight = (next: ValueExpression) => {
		onChange(arith(value.op, value.left, next));
	};

	return (
		<div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-start">
			<ExpressionPicker
				value={value.left}
				onChange={setLeft}
				path={appendSlot(path, "left")}
				expectedType="decimal"
				variant="nested"
			/>
			<div className="pt-1">
				<OpMenu op={value.op} setOp={setOp} />
			</div>
			<ExpressionPicker
				value={value.right}
				onChange={setRight}
				path={appendSlot(path, "right")}
				expectedType="decimal"
				variant="nested"
			/>
		</div>
	);
}

interface OpMenuProps {
	readonly op: ArithOp;
	readonly setOp: (op: ArithOp) => void;
}

function OpMenu({ op, setOp }: OpMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const meta = OP_LABELS[op];
	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Operator: ${meta.label}`}
				className="group flex items-center justify-center gap-1 px-3 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer min-w-[3rem]"
			>
				<span className="font-mono text-base leading-none">{meta.symbol}</span>
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
					align="center"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
				>
					<Menu.Popup className={MENU_POPUP_CLS}>
						{ARITH_OPS.map((o, i) => {
							const isActive = o === op;
							const last = ARITH_OPS.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							const m = OP_LABELS[o];
							return (
								<Menu.Item
									key={o}
									onClick={() => setOp(o)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									}`}
								>
									<span className="font-mono text-base w-6 text-center">
										{m.symbol}
									</span>
									<span>{m.label}</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
