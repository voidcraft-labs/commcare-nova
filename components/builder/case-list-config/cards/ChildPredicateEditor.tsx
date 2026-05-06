// components/builder/case-list-config/cards/ChildPredicateEditor.tsx
//
// Dispatch shell for a single predicate node — looks up the
// schema entry for `value.kind`, delegates rendering to the
// matched card, and frames the card with a kind-replacing menu so
// authors can swap a clause's operator without re-creating the
// surrounding structure.
//
// This is the recursive entry point used by every card that holds
// a nested clause (`not.clause`, `when-input-present.clause`,
// `exists.where`, `and.clauses[i]`, `or.clauses[i]`). The
// PredicateCardEditor at the top of the tree mounts the same
// shell at the root.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import { useRef } from "react";
import type { Predicate } from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { useEditorErrorsAt, usePredicateEditContext } from "../editorContext";
import {
	type PredicateCardSchema,
	type PredicateEditContext,
	predicateCardSchemaList,
	predicateCardSchemas,
} from "../editorSchemas";
import type { EditorPath } from "../path";
import { CardShell } from "../primitives/CardShell";

interface ChildPredicateEditorProps {
	readonly value: Predicate;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
	/**
	 * Optional remove handler — when provided, the card surfaces a
	 * "Delete" item in its kebab menu. Cards inside an `and`/`or`
	 * clause list, under a `not` wrapper, etc. carry the affordance;
	 * the top-level editor passes `undefined` (the root card cannot
	 * be deleted, only replaced).
	 */
	readonly onRemove?: () => void;
	/**
	 * Display variant — the top-level card uses `"normal"`; nested
	 * children inside a logical group use `"nested"` so the parent
	 * group's accent doesn't fight the child's surface.
	 */
	readonly variant?: "normal" | "nested";
	/**
	 * Optional ref-callback the parent installs on the card shell's
	 * grip handle for native drag binding. When undefined, the grip
	 * does not render — only cards inside an `and` / `or` clause
	 * list carry a drag affordance.
	 */
	readonly dragHandleRef?: (el: HTMLElement | null) => void;
}

/**
 * Render one predicate as a card. Looks up the registry entry by
 * `value.kind` and dispatches to the matching card component;
 * routes operator-level errors (path === self) to the shell's
 * error footer; passes a kind-replacing menu in the kebab.
 */
export function ChildPredicateEditor({
	value,
	onChange,
	path,
	onRemove,
	variant = "normal",
	dragHandleRef,
}: ChildPredicateEditorProps) {
	const operatorErrors = useEditorErrorsAt(path);
	const schema = predicateCardSchemas[value.kind];
	const Component = schema.component as React.ComponentType<{
		value: Predicate;
		onChange: (next: Predicate) => void;
		path: EditorPath;
	}>;

	return (
		<CardShell
			icon={schema.icon}
			label={schema.label}
			variant={variant}
			onRemove={onRemove}
			dragHandleRef={dragHandleRef}
			errors={operatorErrors}
			kindAccent={<KindReplaceMenu currentValue={value} onChange={onChange} />}
		>
			<Component value={value} onChange={onChange} path={path} />
		</CardShell>
	);
}

interface KindReplaceMenuProps {
	readonly currentValue: Predicate;
	readonly onChange: (next: Predicate) => void;
}

/**
 * Map a kind to the structural-twin set it shares — pairs of
 * kinds with identical operand shapes that the editor preserves
 * verbatim across replacement. Concretely:
 *
 *   - `exists` ↔ `missing` carry identical `{ via, where? }`
 *     operand shapes — the in-card `KindMenu` already swaps
 *     between them while preserving operands. Routing the outer
 *     replace menu through the same operand-preserving swap
 *     guarantees the two affordances produce the same result for
 *     the same author intent.
 *   - The six comparison kinds (`eq` / `neq` / `gt` / `gte` /
 *     `lt` / `lte`) carry identical `{ left, right }` shapes —
 *     swapping between them preserves the picked property and
 *     value rather than resetting to the schema's default.
 *
 * Returns `null` when no twin shape applies; the caller falls
 * through to `defaultValue(ctx)`.
 */
function preservedOperandSwap(
	currentValue: Predicate,
	targetKind: Predicate["kind"],
): Predicate | null {
	// exists ↔ missing — same `{ via, where? }`.
	if (
		(currentValue.kind === "exists" || currentValue.kind === "missing") &&
		(targetKind === "exists" || targetKind === "missing")
	) {
		return currentValue.where === undefined
			? { kind: targetKind, via: currentValue.via }
			: { kind: targetKind, via: currentValue.via, where: currentValue.where };
	}
	// Comparison ↔ comparison — same `{ left, right }`.
	const COMPARISON_KINDS = new Set<Predicate["kind"]>([
		"eq",
		"neq",
		"gt",
		"gte",
		"lt",
		"lte",
	]);
	if (
		COMPARISON_KINDS.has(currentValue.kind) &&
		COMPARISON_KINDS.has(targetKind)
	) {
		// Narrowing — `currentValue.kind` is a comparison kind so the
		// arm carries `left` / `right`. The discriminated-union type
		// requires the `kind` literal be in the closed set; the cast
		// reads through the runtime guarantee the Set check provides.
		const comparison = currentValue as Extract<
			Predicate,
			{ kind: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" }
		>;
		return {
			kind: targetKind as typeof comparison.kind,
			left: comparison.left,
			right: comparison.right,
		};
	}
	return null;
}

/**
 * Menu that replaces the current card's predicate with a
 * different kind. Two replacement strategies:
 *
 *   1. **Operand-preserving swap** — when the source and target
 *      kinds share an identical operand shape (`exists` ↔
 *      `missing`, comparison ↔ comparison), the existing
 *      operands carry over to the new kind verbatim. Same
 *      result the in-card `KindMenu` produces for `exists` ↔
 *      `missing`, so the two affordances are interchangeable.
 *   2. **Default-value reset** — for every other kind transition
 *      (e.g. `eq` → `between`), the target schema's
 *      `defaultValue(...)` factory builds a fresh predicate.
 *      Operand semantics differ enough that no carry-over is
 *      principled.
 *
 * The menu lists every kind, marking the current one with a
 * violet dot.
 */
function KindReplaceMenu({ currentValue, onChange }: KindReplaceMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const ctx = usePredicateEditContext();
	const editCtx: PredicateEditContext = {
		caseTypes: ctx.caseTypes,
		currentCaseType: ctx.currentCaseType,
		knownInputs: ctx.knownInputs,
	};
	const currentKind = currentValue.kind;

	const replaceWith = <K extends Predicate["kind"]>(
		schema: PredicateCardSchema<K>,
	) => {
		const preserved = preservedOperandSwap(currentValue, schema.kind);
		onChange(preserved ?? schema.defaultValue(editCtx));
	};

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label="Change card type"
				className="group flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded text-nova-text-muted/60 hover:text-nova-violet-bright hover:bg-white/[0.04] transition-colors cursor-pointer"
			>
				<span>Change</span>
				<svg
					aria-hidden="true"
					width="8"
					height="8"
					viewBox="0 0 10 10"
					className="shrink-0 transition-transform group-data-[popup-open]:rotate-180"
				>
					<path
						d="M2 3.5L5 6.5L8 3.5"
						stroke="currentColor"
						strokeWidth="1.4"
						fill="none"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="end"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
					style={{ maxHeight: 320 }}
				>
					<Menu.Popup
						className={`${MENU_POPUP_CLS} max-h-80 overflow-y-auto min-w-[18rem]`}
					>
						{predicateCardSchemaList.map((s, i) => {
							const isCurrent = s.kind === currentKind;
							const isApplicable = s.applicable(editCtx);
							const last = predicateCardSchemaList.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							const cls = [
								corners,
								MENU_ITEM_CLS,
								isCurrent ? "text-nova-violet-bright bg-nova-violet/10" : "",
								isApplicable ? "" : "opacity-40",
							].join(" ");
							return (
								<Menu.Item
									key={s.kind}
									onClick={() => replaceWith(s)}
									disabled={!isApplicable && !isCurrent}
									className={cls}
								>
									<Icon
										icon={s.icon}
										width="14"
										height="14"
										className={
											isCurrent
												? "text-nova-violet-bright"
												: "text-nova-text-muted"
										}
									/>
									<span className="flex-1 text-left min-w-0">
										<div className="truncate">{s.label}</div>
										<div
											className={`text-[10px] truncate ${
												isCurrent
													? "text-nova-violet-bright/60"
													: "text-nova-text-muted"
											}`}
										>
											{s.description}
										</div>
									</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
