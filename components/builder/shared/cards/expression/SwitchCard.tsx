// components/builder/shared/cards/expression/SwitchCard.tsx
//
// Renders the `switch` ValueExpression — value-driven multi-case
// dispatch. Slots:
//
//   - `on` — `ValueExpression`. The discriminator value compared
//     against each case's `when` literal.
//   - `cases[i]` — `{ when: Literal; then: ValueExpression }[]`.
//     Drag-orderable; the schema requires non-empty.
//   - `fallback` — `ValueExpression`. Returned when no case matches.
//
// Type-checker rules (per `checkExpression`'s `case "switch":`):
//   - Each `case.when` literal must be comparable with `on`'s
//     resolved type. Errors land at `[..., "switch", "cases", i,
//     "when"]`.
//   - All `case.then` values + the `fallback` must agree on type
//     (per `accumulateBranchType`). Per-branch errors land at the
//     respective `[..., "switch", "cases", i, "then"]` and
//     `[..., "switch", "fallback"]`.
//
// Path encoding for `switch`: the type checker emits with the kind
// segment first — `[..., "switch", "on" | "fallback"]` for the
// scalar slots and `[..., "switch", "cases", i, "when" | "then"]`
// for the indexed slots. The card uses `appendKindSlot` for the
// scalar sub-paths and `appendKindIndexSlot` for the indexed ones.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import {
	ANY_CONSTRAINT,
	branchConstraint,
	compatibleTypesFor,
	type Literal,
	literal,
	literalType,
	type ResolvedType,
	type SlotConstraint,
	type SwitchCase,
	switchCase,
	switchExpr,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	useEditorErrorsAt,
	usePredicateEditContext,
	useResolvedType,
} from "../../editorContext";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { expressionCardSchemas } from "../../expressionEditorSchemas";
import { removeAndRestoreFocus } from "../../focusAfterRemoval";
import {
	appendKindIndexSlot,
	appendKindSlot,
	type EditorPath,
} from "../../path";
import { InlineError } from "../../primitives/CardShell";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";
import { LiteralValueInput } from "../../primitives/LiteralValueInput";
import {
	ReorderableRow,
	type ReorderKeyboardKey,
	reorderByKeyboard,
	useReorderableList,
} from "../../useReorderableList";
import { useStableListIdentity } from "../../useStableListIdentity";
import {
	reseedLiteralForConstraint,
	reseedValueForConstraint,
	resolveExpressionType,
} from "../reseed";

/** Default `switch` — `switch(literal(""), [{ when: "", then: "" }],
 *  fallback: "")`. The single-case seed satisfies the schema's
 *  non-empty `cases` requirement; the type checker accepts the seed
 *  clean (all values resolve to text). */
export function switchDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "switch" }> {
	return switchExpr(
		term(literal("")),
		[switchCase(literal(""), term(literal("")))],
		term(literal("")),
	);
}

/** Whether a `when` literal's type sits in `on`'s compatible set —
 *  the null literal (`_any`) is universally compatible. */
function whenLiteralAccepted(
	when: Literal,
	accepts: ReadonlySet<ResolvedType>,
): boolean {
	return accepts.has(literalType(when));
}

interface SwitchCardProps {
	readonly value: Extract<ValueExpression, { kind: "switch" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
	/** The switch's own result constraint propagates to every `then`
	 *  branch and the `fallback` — the result is whichever branch
	 *  matches, so each must satisfy the slot. */
	readonly constraint?: SlotConstraint;
}

export function SwitchCard({
	value,
	onChange,
	path,
	constraint = ANY_CONSTRAINT,
}: SwitchCardProps) {
	// Per-slot errors at `[..., "switch", "on" | "fallback"]` render
	// via the matching `ExpressionPicker` shells' `CardShell` footers
	// — no parallel `<InlineError>` is needed here. The `[...,
	// "switch", "cases", i, "when"]` errors fall on the inner `when`
	// literal input (which has no shell of its own), so the per-row
	// `InlineError` for `whenErrors` STAYS in `CaseRow`.
	const containerKey = useId();
	const ctx = usePredicateEditContext();
	const [moveAnnouncement, setMoveAnnouncement] = useState("");
	const rowIdentity = useStableListIdentity(value.cases);

	// Each `case.when` literal must be comparable with `on`'s resolved
	// type — the when input is typed against this accept-set, and a
	// change of `on` reseeds any now-incompatible `when` in the same
	// onChange so the committed switch is never transiently type-wrong.
	const onType = useResolvedType(value.on);
	const whenAccepts = useMemo(() => compatibleTypesFor(onType), [onType]);
	const branchTypes = useMemo(
		() => value.cases.map((item) => resolveExpressionType(item.then, ctx)),
		[value.cases, ctx],
	);
	const fallbackType = useMemo(
		() => resolveExpressionType(value.fallback, ctx),
		[value.fallback, ctx],
	);
	const fallbackConstraint = branchConstraint(constraint, ...branchTypes);

	const apply = (
		cases: readonly SwitchCase[],
	): Extract<ValueExpression, { kind: "switch" }> => {
		const [first, ...rest] = cases;
		// Same call-site cast pattern as ConcatCard / CoalesceCard —
		// `switchExpr` requires at least one case at the type layer;
		// the runtime contract guarantees `cases.length >= 1` (no
		// path mutates the array to empty).
		return switchExpr(value.on, [first, ...rest], value.fallback);
	};

	const setOn = (next: ValueExpression) => {
		const nextAccepts = compatibleTypesFor(resolveExpressionType(next, ctx));
		const reseeded = value.cases.map((item) =>
			whenLiteralAccepted(item.when, nextAccepts)
				? item
				: switchCase(
						reseedLiteralForConstraint(item.when, nextAccepts),
						item.then,
					),
		);
		const [first, ...rest] = reseeded;
		rowIdentity.stage(reseeded, { kind: "replace" });
		onChange(switchExpr(next, [first, ...rest], value.fallback));
	};

	const setFallback = (next: ValueExpression) => {
		onChange(switchExpr(value.on, value.cases, next));
	};

	const updateCase = (index: number, next: SwitchCase) => {
		const updated = value.cases.map((item, itemIndex) =>
			itemIndex === index ? next : item,
		);
		rowIdentity.stage(updated, { kind: "replace" });
		onChange(apply(updated));
	};

	const removeCase = (index: number) => {
		// Schema requires non-empty; refuse the last case's removal.
		if (value.cases.length === 1) return;
		const filtered = value.cases.filter((_, i) => i !== index);
		rowIdentity.stage(filtered, {
			kind: "splice",
			index,
			deleteCount: 1,
			insertCount: 0,
		});
		onChange(apply(filtered));
	};

	const appendCase = () => {
		const whenSeed = reseedLiteralForConstraint(literal(""), whenAccepts);
		const resultConstraint = branchConstraint(
			constraint,
			fallbackType,
			...branchTypes,
		);
		const thenSeed =
			resultConstraint.accepts === "any"
				? term(literal(null))
				: reseedValueForConstraint(term(literal("")), resultConstraint.accepts);
		const next = [...value.cases, switchCase(whenSeed, thenSeed)];
		rowIdentity.stage(next, {
			kind: "splice",
			index: value.cases.length,
			deleteCount: 0,
			insertCount: 1,
		});
		onChange(apply(next));
	};

	const moveCase = (index: number, key: ReorderKeyboardKey) => {
		const result = reorderByKeyboard(value.cases, index, key);
		const towardStart = key === "ArrowUp" || key === "Home";
		if (result === undefined) {
			setMoveAnnouncement(
				`Choice ${index + 1} is already at the ${towardStart ? "beginning" : "end"}`,
			);
			return;
		}
		rowIdentity.stage(result.items, {
			kind: "move",
			fromIndex: result.move.fromIndex,
			toIndex: result.move.toIndex,
		});
		onChange(apply(result.items));
		setMoveAnnouncement(
			`Choice ${index + 1} moved ${towardStart ? "earlier" : "later"}`,
		);
	};

	const { pendingDrop } = useReorderableList({
		containerKey,
		containerKind: "switch",
		items: value.cases,
		itemKeys: rowIdentity.keys,
		onReorder: (next, move) => {
			rowIdentity.stage(next, {
				kind: "move",
				fromIndex: move.fromIndex,
				toIndex: move.toIndex,
			});
			onChange(apply(next));
		},
	});

	return (
		<div className="space-y-3">
			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className="sr-only"
			>
				{moveAnnouncement}
			</p>
			<div>
				<div className="mb-1.5 text-[13px] font-medium text-nova-text-secondary">
					Compare this value
				</div>
				<ExpressionPicker
					value={value.on}
					onChange={setOn}
					path={appendKindSlot(path, "switch", "on")}
					variant="nested"
				/>
			</div>

			<div className="space-y-2">
				<div className="text-[13px] font-medium text-nova-text-secondary">
					Matching choices
				</div>
				{value.cases.map((c, i) => (
					<ReorderableRow
						key={rowIdentity.keys[i]}
						index={i}
						itemKey={rowIdentity.keys[i]}
						containerKey={containerKey}
						containerKind="switch"
						pendingDrop={pendingDrop}
						preview={<SwitchCaseDragPreview />}
					>
						{({
							wrapperRef,
							setHandleEl,
							closestEdge,
							previewPortal,
							beingMoved,
						}) => (
							<div
								ref={wrapperRef}
								data-removal-focus-row
								className={`relative ${beingMoved ? "opacity-50" : ""}`}
							>
								{closestEdge !== null && (
									<div
										aria-hidden="true"
										className="absolute left-0 right-0 h-0.5 bg-nova-violet rounded-full"
										style={{
											top: closestEdge === "top" ? -3 : undefined,
											bottom: closestEdge === "bottom" ? -3 : undefined,
										}}
									/>
								)}
								<CaseRow
									switchCaseValue={c}
									caseIndex={i}
									isOnlyOne={value.cases.length === 1}
									onUpdate={(next) => updateCase(i, next)}
									onRemove={() => removeCase(i)}
									setHandleEl={setHandleEl}
									onMove={(key) => moveCase(i, key)}
									reorderLabel={`Move choice ${i + 1} of ${value.cases.length}`}
									path={path}
									whenAccepts={whenAccepts}
									thenConstraint={branchConstraint(
										constraint,
										fallbackType,
										...branchTypes.filter(
											(_, branchIndex) => branchIndex !== i,
										),
									)}
								/>
								{previewPortal}
							</div>
						)}
					</ReorderableRow>
				))}
				<Button
					type="button"
					variant="outline"
					size="xl"
					onClick={appendCase}
					data-removal-focus-fallback
					className="w-full border-dashed text-nova-text-muted not-disabled:hover:border-nova-violet/30 not-disabled:hover:text-nova-violet-bright"
				>
					<Icon icon={tablerPlus} width="14" height="14" />
					<span>Add choice</span>
				</Button>
			</div>

			<div>
				<div className="mb-1.5 text-[13px] font-medium text-nova-text-secondary">
					Otherwise
				</div>
				<ExpressionPicker
					value={value.fallback}
					onChange={setFallback}
					path={appendKindSlot(path, "switch", "fallback")}
					constraint={fallbackConstraint}
					variant="nested"
				/>
			</div>
		</div>
	);
}

interface CaseRowProps {
	readonly switchCaseValue: SwitchCase;
	readonly caseIndex: number;
	readonly isOnlyOne: boolean;
	readonly onUpdate: (next: SwitchCase) => void;
	readonly onRemove: () => void;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onMove: (key: ReorderKeyboardKey) => void;
	readonly reorderLabel: string;
	readonly path: EditorPath;
	/** The accept-set for the `when` literal — `on`'s compatible
	 *  types. Drives the typed `when` input so an authored value can't
	 *  disagree with `on`. */
	readonly whenAccepts: ReadonlySet<ResolvedType>;
	/** The switch's result constraint — propagated to the `then`
	 *  branch. */
	readonly thenConstraint: SlotConstraint;
}

function CaseRow({
	switchCaseValue,
	caseIndex,
	isOnlyOne,
	onUpdate,
	onRemove,
	setHandleEl,
	onMove,
	reorderLabel,
	path,
	whenAccepts,
	thenConstraint,
}: CaseRowProps) {
	const ctx = usePredicateEditContext();
	// `when` errors land on the inner `SwitchWhenLiteralInput` —
	// that input has no card-shell of its own, so the `<InlineError>`
	// row below the input is the only render path. `then` errors
	// render via the `ExpressionPicker` shell at the matching slot
	// path; no parallel `<InlineError>` is needed for the `then`
	// branch.
	const whenErrors = useEditorErrorsAt(
		appendKindIndexSlot(path, "switch", "cases", caseIndex, "when"),
	);

	const setWhen = (next: Literal) => {
		onUpdate(switchCase(next, switchCaseValue.then));
	};

	const setThen = (next: ValueExpression) => {
		onUpdate(switchCase(switchCaseValue.when, next));
	};

	return (
		<div className="space-y-2 rounded-lg border border-white/[0.05] bg-nova-surface/30 p-3">
			<div className="flex items-center gap-1.5">
				<SimpleTooltip content="Drag or use arrow keys">
					<Button
						type="button"
						variant="ghost"
						size="icon"
						ref={setHandleEl}
						aria-label={reorderLabel}
						aria-keyshortcuts="ArrowUp ArrowDown Home End"
						onKeyDown={(event) => {
							if (
								event.key !== "ArrowUp" &&
								event.key !== "ArrowDown" &&
								event.key !== "Home" &&
								event.key !== "End"
							) {
								return;
							}
							event.preventDefault();
							onMove(event.key);
						}}
						className="size-11 cursor-grab rounded-md text-nova-text-muted not-disabled:hover:bg-white/[0.04] not-disabled:hover:text-nova-text"
					>
						<Icon icon={tablerGripVertical} width="16" height="16" />
					</Button>
				</SimpleTooltip>
				<span className="text-[13px] font-medium text-nova-text-secondary">
					Matching choice
				</span>
				<div className="flex-1" />
				{!isOnlyOne && (
					<SimpleTooltip content="Remove choice">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							aria-label="Remove choice"
							onClick={(event) =>
								removeAndRestoreFocus(event.currentTarget, onRemove)
							}
							data-removal-action
							className="size-11 rounded-md text-nova-text-muted not-disabled:hover:bg-nova-rose/[0.08] not-disabled:hover:text-nova-rose"
						>
							<Icon icon={tablerTrash} width="13" height="13" />
						</Button>
					</SimpleTooltip>
				)}
			</div>

			<div className="grid grid-cols-1 gap-3 @lg:grid-cols-2">
				<div>
					<div className="mb-1.5 text-[13px] font-medium text-nova-text-secondary">
						When it equals
					</div>
					{/* The when value is typed against `on`'s compatible set,
					 *  so an authored value can never disagree with the
					 *  discriminator. No property anchors it (the value is
					 *  compared to `on`, not stored on a case), so the widget
					 *  data type comes from `whenAccepts`. */}
					<LiteralValueInput
						value={switchCaseValue.when}
						onChange={setWhen}
						caseTypeName={ctx.currentCaseType}
						propertyName={undefined}
						accepts={whenAccepts}
						invalid={whenErrors.length > 0}
						ariaLabel="Value to match"
					/>
					<InlineError errors={whenErrors} />
				</div>
				<div>
					<div className="mb-1.5 text-[13px] font-medium text-nova-text-secondary">
						Use this value
					</div>
					<ExpressionPicker
						value={switchCaseValue.then}
						onChange={setThen}
						path={appendKindIndexSlot(
							path,
							"switch",
							"cases",
							caseIndex,
							"then",
						)}
						constraint={thenConstraint}
						variant="nested"
					/>
				</div>
			</div>
		</div>
	);
}

function SwitchCaseDragPreview() {
	const schema = expressionCardSchemas.switch;
	return (
		<div className="inline-flex items-center gap-1.5 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-1.5 text-sm text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerGripVertical}
				width="14"
				height="14"
				className="text-nova-text-muted"
			/>
			<Icon
				icon={schema.icon}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
			<span className="max-w-[240px] truncate">Matching choice</span>
		</div>
	);
}
