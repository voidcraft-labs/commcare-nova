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
import { useMemo } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import {
	ANY_CONSTRAINT,
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
import { nodeId } from "../../nodeIdentity";
import {
	appendKindIndexSlot,
	appendKindSlot,
	type EditorPath,
} from "../../path";
import { InlineError } from "../../primitives/CardShell";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";
import { LiteralValueInput } from "../../primitives/LiteralValueInput";
import { ReorderableRow, useReorderableList } from "../../useReorderableList";
import { reseedLiteralForConstraint, resolveExpressionType } from "../reseed";

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
	const containerKey = nodeId(value);
	const ctx = usePredicateEditContext();

	// Each `case.when` literal must be comparable with `on`'s resolved
	// type — the when input is typed against this accept-set, and a
	// change of `on` reseeds any now-incompatible `when` in the same
	// onChange so the committed switch is never transiently type-wrong.
	const onType = useResolvedType(value.on);
	const whenAccepts = useMemo(() => compatibleTypesFor(onType), [onType]);

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
		const reseeded = value.cases.map((c) =>
			whenLiteralAccepted(c.when, nextAccepts)
				? c
				: switchCase(reseedLiteralForConstraint(c.when, nextAccepts), c.then),
		);
		const [first, ...rest] = reseeded;
		onChange(switchExpr(next, [first, ...rest], value.fallback));
	};

	const setFallback = (next: ValueExpression) => {
		onChange(switchExpr(value.on, value.cases, next));
	};

	const updateCase = (index: number, next: SwitchCase) => {
		const updated = value.cases.map((c, i) => (i === index ? next : c));
		onChange(apply(updated));
	};

	const removeCase = (index: number) => {
		// Schema requires non-empty; refuse the last case's removal.
		if (value.cases.length === 1) return;
		const filtered = value.cases.filter((_, i) => i !== index);
		onChange(apply(filtered));
	};

	const appendCase = () => {
		const next = [...value.cases, switchCase(literal(""), term(literal("")))];
		onChange(apply(next));
	};

	const { pendingDrop } = useReorderableList({
		containerKey,
		containerKind: "switch",
		items: value.cases,
		onReorder: (next) => onChange(apply(next)),
	});

	return (
		<div className="space-y-2">
			<div>
				<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted mb-1.5">
					Match against
				</div>
				<ExpressionPicker
					value={value.on}
					onChange={setOn}
					path={appendKindSlot(path, "switch", "on")}
					variant="nested"
				/>
			</div>

			<div className="space-y-1.5">
				<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted">
					Cases
				</div>
				{value.cases.map((c, i) => (
					<ReorderableRow
						key={nodeId(c)}
						index={i}
						containerKey={containerKey}
						containerKind="switch"
						pendingDrop={pendingDrop}
						preview={<SwitchCaseDragPreview index={i} />}
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
									path={path}
									whenAccepts={whenAccepts}
									thenConstraint={constraint}
								/>
								{previewPortal}
							</div>
						)}
					</ReorderableRow>
				))}
				<button
					type="button"
					onClick={appendCase}
					className="w-full inline-flex items-center justify-center gap-2 px-3 min-h-11 text-[13px] rounded-lg border border-dashed border-white/[0.10] text-nova-text-muted hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				>
					<Icon icon={tablerPlus} width="14" height="14" />
					<span>Add Case</span>
				</button>
			</div>

			<div>
				<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted mb-1.5">
					Otherwise
				</div>
				<ExpressionPicker
					value={value.fallback}
					onChange={setFallback}
					path={appendKindSlot(path, "switch", "fallback")}
					constraint={constraint}
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
		<div className="rounded-md border border-white/[0.05] bg-nova-surface/30 px-2 py-2 space-y-1.5">
			<div className="flex items-center gap-1.5">
				<button
					type="button"
					ref={setHandleEl}
					aria-label="Reorder case"
					className="size-11 -ml-2 grid place-items-center rounded-md cursor-grab text-nova-text-muted hover:text-nova-text-muted transition-colors"
				>
					<Icon icon={tablerGripVertical} width="14" height="14" />
				</button>
				<span className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted">
					Case {caseIndex + 1}
				</span>
				<div className="flex-1" />
				{!isOnlyOne && (
					<Tooltip content="Remove this case">
						<button
							type="button"
							aria-label="Remove case"
							onClick={onRemove}
							className="size-11 grid place-items-center rounded-md text-nova-text-muted hover:text-nova-rose hover:bg-white/[0.05] transition-colors cursor-pointer"
						>
							<Icon icon={tablerTrash} width="13" height="13" />
						</button>
					</Tooltip>
				)}
			</div>

			<div className="grid grid-cols-2 gap-2">
				<div>
					<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted mb-1.5">
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
						ariaLabel="Case when value"
					/>
					<InlineError errors={whenErrors} />
				</div>
				<div>
					<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted mb-1.5">
						Then
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

function SwitchCaseDragPreview({ index }: { readonly index: number }) {
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
			<span className="max-w-[240px] truncate">Case {index + 1}</span>
		</div>
	);
}
