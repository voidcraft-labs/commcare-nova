// components/builder/shared/cards/expression/ArithCard.tsx
//
// Renders the `arith` Expression: five-op binary numeric
// arithmetic (`+` / `-` / `*` / `div` / `mod`). The `op` discriminator
// stays inline at the operator slot so authors flip between the five
// operations without a kind swap.
//
// Slot shape: `left` + `op` + `right`. Each operand is a recursive
// `Expression`; the result type follows `int×int=int / mixed=
// decimal` promotion. The `div` and `mod` operators use the spelled-
// out CCHQ vocabulary names rather than `/` (the XPath path
// separator) and `%` (no XPath meaning).
//
// Type-checker rule (per `checkExpression`'s `case "arith":`):
// both operands must resolve to numeric types. Errors land at
// `[..., "left"]` and `[..., "right"]`; the editor captures each
// inline next to its operand picker.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import { useRef } from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import type { ExpressionOfKind } from "@/lib/domain/expression";
import {
	arith,
	arithOperandConstraint,
	type Expression,
	literal,
	term,
} from "@/lib/domain/expression";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendSlot, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";

/** Both operands must resolve to a numeric type: module-const for a
 *  stable filter identity across renders. */
const OPERAND_CONSTRAINT = arithOperandConstraint();

const EDITABLE_ARITH_OPS = ["+", "-", "*", "div", "mod"] as const;
type EditableArithOp = (typeof EDITABLE_ARITH_OPS)[number];
const OP_LABELS: Record<EditableArithOp, { symbol: string; label: string }> = {
	"+": { symbol: "+", label: "Add" },
	"-": { symbol: "−", label: "Subtract" },
	"*": { symbol: "×", label: "Multiply" },
	div: { symbol: "÷", label: "Divide" },
	mod: { symbol: "%", label: "Remainder" },
};

/** Default `arith`: `0 + 0`. Both operands are int literals so the
 *  type checker accepts the seed clean. The op defaults to `+`:
 *  the most common arithmetic operation; authors flip via the
 *  inline op menu. */
export function arithDefault(
	_ctx: ExpressionEditContext,
): ExpressionOfKind<"arith"> {
	return arith("+", term(literal(0)), term(literal(0)));
}

interface ArithCardProps {
	readonly value: ExpressionOfKind<"arith">;
	readonly onChange: (next: Expression) => void;
	readonly path: EditorPath;
}

export function ArithCard(props: ArithCardProps) {
	if (props.value.op === "quotient")
		return (
			<p role="status">
				This saved integer division cannot be edited here yet.
			</p>
		);
	return (
		<EditableArithCard
			{...props}
			value={{ ...props.value, op: props.value.op }}
		/>
	);
}

function EditableArithCard({
	value,
	onChange,
	path,
}: Omit<ArithCardProps, "value"> & {
	readonly value: Omit<ArithCardProps["value"], "op"> & {
		readonly op: EditableArithOp;
	};
}) {
	// Per-slot errors render via each `ExpressionPicker` shell's
	// `CardShell` footer: the picker mounted at `[..., "left"]`
	// looks up errors at the same path the type checker emits to,
	// so a parallel `<InlineError>` here would render the same
	// message twice.

	const setLeft = (next: Expression) => {
		onChange(arith(value.op, next, value.right));
	};

	const setOp = (op: EditableArithOp) => {
		onChange(arith(op, value.left, value.right));
	};

	const setRight = (next: Expression) => {
		onChange(arith(value.op, value.left, next));
	};

	return (
		<div className="grid grid-cols-1 @md:grid-cols-[1fr_auto_1fr] gap-2 items-start">
			<ExpressionPicker
				value={value.left}
				onChange={setLeft}
				path={appendSlot(path, "left")}
				constraint={OPERAND_CONSTRAINT}
				variant="nested"
			/>
			<div className="pt-1">
				<OpMenu op={value.op} setOp={setOp} />
			</div>
			<ExpressionPicker
				value={value.right}
				onChange={setRight}
				path={appendSlot(path, "right")}
				constraint={OPERAND_CONSTRAINT}
				variant="nested"
			/>
		</div>
	);
}

interface OpMenuProps {
	readonly op: EditableArithOp;
	readonly setOp: (op: EditableArithOp) => void;
}

function OpMenu({ op, setOp }: OpMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const meta = OP_LABELS[op];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				aria-label={`Math operation ${meta.label}`}
				render={
					<Button
						type="button"
						variant="field"
						className="group min-w-12 @max-md:justify-self-start"
					/>
				}
			>
				<span className="text-base leading-none">{meta.symbol}</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuPortal>
				<DropdownMenuPositioner
					side="bottom"
					align="center"
					sideOffset={4}
					anchor={triggerRef}
				>
					<DropdownMenuPopup>
						{EDITABLE_ARITH_OPS.map((o) => {
							const isActive = o === op;
							const m = OP_LABELS[o];
							return (
								<DropdownMenuItem
									key={o}
									onClick={() => setOp(o)}
									className={
										isActive
											? "bg-nova-violet/10 text-nova-violet-bright"
											: undefined
									}
								>
									<span className="w-6 text-center text-base">{m.symbol}</span>
									<span>{m.label}</span>
								</DropdownMenuItem>
							);
						})}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}
