// components/builder/case-list-config/cards/ComparisonCard.tsx
//
// Renders the six comparison kinds (`eq` / `neq` / `gt` / `gte`
// / `lt` / `lte`) as a single card. Each shares the same
// `{ kind, left, right }` shape; the kind discriminator picks the
// operator. The schema entry's `defaultValue(ctx)` factory builds a
// kind-specific default predicate that the user can refine.
//
// UI shape: property picker on the left, operator dropdown in the
// middle, value picker on the right. The value picker mirrors the
// type of the picked property — text / numeric / date / select —
// via `LiteralValueInput`'s `data_type` switch.

"use client";
import { Menu } from "@base-ui/react/menu";
import { useRef } from "react";
import {
	type ComparisonKind,
	eq,
	gt,
	gte,
	literal,
	lt,
	lte,
	neq,
	type Predicate,
	prop,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { useEditorErrorsAt } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";

/** Per-kind builder dispatch. Keeps the card body's onChange paths
 *  precise — each kind constructs through the matching builder so
 *  the AST stays canonical. Exported so `preservedOperandSwap` in
 *  `ChildPredicateEditor` can route comparison ↔ comparison
 *  replacements through the same builders. */
export const KIND_BUILDERS: Record<
	ComparisonKind,
	(left: Parameters<typeof eq>[0], right: Parameters<typeof eq>[1]) => Predicate
> = {
	eq,
	neq,
	gt,
	gte,
	lt,
	lte,
};

const KIND_LABELS: Record<ComparisonKind, { label: string; symbol: string }> = {
	eq: { label: "equals", symbol: "=" },
	neq: { label: "not equals", symbol: "≠" },
	lt: { label: "less than", symbol: "<" },
	lte: { label: "less than or equal", symbol: "≤" },
	gt: { label: "greater than", symbol: ">" },
	gte: { label: "greater than or equal", symbol: "≥" },
};

const ORDERED_KINDS = new Set<ComparisonKind>(["lt", "lte", "gt", "gte"]);
const ORDERED_PROPERTY_TYPES = new Set<string>([
	"int",
	"decimal",
	"date",
	"datetime",
	"time",
]);

/**
 * Comparison-arm shape narrowed on the per-kind discriminator. The
 * schema's comparison arm declares `kind: ComparisonKind`, so a
 * direct `Extract<Predicate, { kind: K }>` (where K is one of the
 * six comparison kinds) resolves to `never` — the narrowing
 * tightens `kind` to the literal but preserves the schema's
 * operand types. This alias is what every comparison default
 * factory returns.
 */
type ComparisonArm<K extends ComparisonKind> = Extract<
	Predicate,
	{ kind: ComparisonKind }
> & { kind: K };

/**
 * Build the default comparison predicate for a kind. Picks the
 * first applicable property — for ordering operators, the first
 * ordered-typed property; otherwise any property — and seeds the
 * RHS with an empty literal so the user immediately sees the value
 * input.
 *
 * Returns the precise `ComparisonArm<K>` shape rather than
 * `Extract<Predicate, { kind: K }>` because the latter resolves to
 * `never` (the schema's comparison arm carries `kind:
 * ComparisonKind`, not the per-kind narrowed literal). The runtime
 * AST is identical.
 */
export function comparisonDefault<K extends ComparisonKind>(
	kind: K,
	ctx: PredicateEditContext,
): ComparisonArm<K> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find((p) =>
		ORDERED_KINDS.has(kind)
			? ORDERED_PROPERTY_TYPES.has(p.data_type ?? "text")
			: true,
	);
	const propName = property?.name ?? "";
	const builder = KIND_BUILDERS[kind] as (
		l: Parameters<typeof eq>[0],
		r: Parameters<typeof eq>[1],
	) => ComparisonArm<K>;
	return builder(prop(ctx.currentCaseType, propName), literal(""));
}

interface ComparisonCardProps {
	readonly value: Extract<
		Predicate,
		{ kind: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" }
	>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

/**
 * Comparison card body. The slots:
 *   - `left` — `ValueExpression`. The card EDITS the canonical
 *     `term(prop(...))` shape via `PropertyRefPicker`; non-Term,
 *     non-prop-Term, and prop-with-non-self-`via` shapes route
 *     through that picker's read-only badge with an explicit
 *     Replace affordance, so the authored expression round-trips
 *     without destruction.
 *   - operator — kind discriminator (eq / neq / gt / lt / lte / gte).
 *   - `right` — `ValueExpression`. The card mounts an
 *     `ExpressionPicker` shell at the slot, dispatching every
 *     ValueExpression kind (term / arith / if / count / coalesce /
 *     etc.) through the registry-driven per-arm cards. Authors swap
 *     kinds via the picker's "Change" menu; nested operands recurse
 *     through the same shell. The picker's own `CardShell` footer
 *     surfaces inline errors at the slot path.
 */
export function ComparisonCard({ value, onChange, path }: ComparisonCardProps) {
	// Left-side errors render via the picker's `invalid` prop +
	// the inline `<InlineError>` below — `PropertyRefPicker` doesn't
	// have a card-shell footer of its own, so the slot's errors
	// surface here directly. Right-side errors render via the
	// `ExpressionPicker` shell's `CardShell` footer at the matching
	// slot path; rendering them again here would double the
	// diagnostic row count for the same message.
	const leftErrors = useEditorErrorsAt(appendSlot(path, "left"));

	const setLeft = (left: ValueExpression) => {
		const builder = KIND_BUILDERS[value.kind];
		onChange(builder(left, value.right));
	};

	const setKind = (nextKind: ComparisonKind) => {
		const builder = KIND_BUILDERS[nextKind];
		onChange(builder(value.left, value.right));
	};

	const setRight = (right: Parameters<typeof eq>[1]) => {
		const builder = KIND_BUILDERS[value.kind];
		onChange(builder(value.left, right));
	};

	return (
		<div className="grid grid-cols-[1.4fr_auto_1.6fr] gap-2 items-start">
			<div>
				<PropertyRefPicker
					mode="left"
					value={value.left}
					onChange={setLeft}
					invalid={leftErrors.length > 0}
					ariaLabel="Left operand"
				/>
				<InlineError errors={leftErrors} />
			</div>

			<OperatorMenu kind={value.kind} setKind={setKind} />

			<div>
				{/* Right operand routes through `ExpressionPicker` so
				 *  every ValueExpression kind (term, arith, if, count,
				 *  etc.) is editable at this slot via the registry-
				 *  driven dispatch. The picker handles round-trip
				 *  preservation for non-canonical shapes by mounting
				 *  the matching kind's card; the kind-replace menu in
				 *  the picker shell is the path for swapping kinds.
				 *  The picker's own `CardShell` footer surfaces inline
				 *  errors at the slot path, so no parallel
				 *  `<InlineError>` is needed here. */}
				<ExpressionPicker
					value={value.right}
					onChange={setRight}
					path={appendSlot(path, "right")}
					variant="nested"
				/>
			</div>
		</div>
	);
}

interface OperatorMenuProps {
	readonly kind: ComparisonKind;
	readonly setKind: (kind: ComparisonKind) => void;
}

function OperatorMenu({ kind, setKind }: OperatorMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const meta = KIND_LABELS[kind];
	const items: readonly ComparisonKind[] = [
		"eq",
		"neq",
		"lt",
		"lte",
		"gt",
		"gte",
	];

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
						{items.map((k, i) => {
							const isActive = k === kind;
							const last = items.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							const m = KIND_LABELS[k];
							return (
								<Menu.Item
									key={k}
									onClick={() => setKind(k)}
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
