// components/builder/case-list-config/cards/expression/SwitchCard.tsx
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
import {
	type Literal,
	literal,
	type SwitchCase,
	switchCase,
	switchExpr,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { useEditorErrorsAt } from "../../editorContext";
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
import {
	ReorderableRow,
	useReorderableExpressionList,
} from "../../useReorderableExpressionList";

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

interface SwitchCardProps {
	readonly value: Extract<ValueExpression, { kind: "switch" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

export function SwitchCard({ value, onChange, path }: SwitchCardProps) {
	// Per-slot errors at `[..., "switch", "on" | "fallback"]` render
	// via the matching `ExpressionPicker` shells' `CardShell` footers
	// — no parallel `<InlineError>` is needed here. The `[...,
	// "switch", "cases", i, "when"]` errors fall on the inner
	// `SwitchWhenLiteralInput` (which has no shell of its own), so
	// the per-row `InlineError` for `whenErrors` STAYS in `CaseRow`.
	const containerKey = nodeId(value);

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
		onChange(switchExpr(next, value.cases, value.fallback));
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

	const { pendingDrop } = useReorderableExpressionList({
		containerKey,
		containerKind: "switch",
		items: value.cases,
		onReorder: (next) => onChange(apply(next)),
	});

	return (
		<div className="space-y-2">
			<div>
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
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
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider">
					Cases
				</div>
				{value.cases.map((c, i) => (
					<ReorderableRow
						key={nodeId(c as object)}
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
								/>
								{previewPortal}
							</div>
						)}
					</ReorderableRow>
				))}
				<button
					type="button"
					onClick={appendCase}
					className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				>
					<Icon icon={tablerPlus} width="11" height="11" />
					<span>Add case</span>
				</button>
			</div>

			<div>
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
					Fallback (no case matched)
				</div>
				<ExpressionPicker
					value={value.fallback}
					onChange={setFallback}
					path={appendKindSlot(path, "switch", "fallback")}
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
}

function CaseRow({
	switchCaseValue,
	caseIndex,
	isOnlyOne,
	onUpdate,
	onRemove,
	setHandleEl,
	path,
}: CaseRowProps) {
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
					className="cursor-grab text-nova-text-muted/50 hover:text-nova-text-muted transition-colors -ml-0.5"
				>
					<Icon icon={tablerGripVertical} width="14" height="14" />
				</button>
				<span className="text-[10px] uppercase tracking-wider text-nova-text-muted/80">
					Case {caseIndex + 1}
				</span>
				<div className="flex-1" />
				{!isOnlyOne && (
					<button
						type="button"
						aria-label="Remove case"
						onClick={onRemove}
						className="rounded p-0.5 text-nova-text-muted/60 hover:text-nova-error hover:bg-white/[0.05] transition-colors cursor-pointer"
					>
						<Icon icon={tablerTrash} width="12" height="12" />
					</button>
				)}
			</div>

			<div className="grid grid-cols-2 gap-2">
				<div>
					<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
						When (literal)
					</div>
					<SwitchWhenLiteralInput
						value={switchCaseValue.when}
						onChange={setWhen}
						invalid={whenErrors.length > 0}
					/>
					<InlineError errors={whenErrors} />
				</div>
				<div>
					<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
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
						variant="nested"
					/>
				</div>
			</div>
		</div>
	);
}

/** Switch-case `when` literal input. Each case's `when` is a typed
 *  `Literal` (not an arbitrary value expression) — the wire form
 *  demands a static value at each comparison site. The input
 *  branches on the existing literal's `data_type` qualifier or its
 *  JS-runtime type to pick the input variant; commits through the
 *  matching `literal()` builder. The simplified subset here covers
 *  the common authoring cases (text + number + boolean + null);
 *  authors who want a typed-date `when` flip the literal's source
 *  through the SA tool surface or compose via the on-prop typed
 *  input one level up. */
function SwitchWhenLiteralInput({
	value,
	onChange,
	invalid,
}: {
	readonly value: Literal;
	readonly onChange: (next: Literal) => void;
	readonly invalid: boolean;
}) {
	const initial =
		value.value === null
			? ""
			: typeof value.value === "boolean"
				? value.value
					? "true"
					: "false"
				: String(value.value);
	const inputCls = [
		"w-full px-2 py-1.5 text-xs rounded-md border bg-nova-deep/50 text-nova-text placeholder:text-nova-text-muted/60 focus:outline-none focus:ring-1 transition-colors font-mono",
		invalid
			? "border-nova-error/40 focus:border-nova-error/60 focus:ring-nova-error/30"
			: "border-white/[0.06] focus:border-nova-violet/40 focus:ring-nova-violet/30",
	].join(" ");
	return (
		<input
			type="text"
			defaultValue={initial}
			onBlur={(e) => {
				const text = e.target.value;
				// Coerce common shapes: empty → empty string literal;
				// pure numeric → number literal; "true" / "false" →
				// boolean literal; everything else → string literal.
				// The type checker's literal-to-on-type compatibility
				// check surfaces a mismatch error inline if the typed
				// shape doesn't match `switch.on`'s resolved type.
				if (text === "") {
					onChange(literal(""));
					return;
				}
				if (text === "true") {
					onChange(literal(true));
					return;
				}
				if (text === "false") {
					onChange(literal(false));
					return;
				}
				const asNumber = Number(text);
				if (!Number.isNaN(asNumber) && text.trim() === text) {
					onChange(literal(asNumber));
					return;
				}
				onChange(literal(text));
			}}
			autoComplete="off"
			data-1p-ignore
			placeholder="Value to match"
			aria-label="Case when value"
			aria-invalid={invalid || undefined}
			className={inputCls}
		/>
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
				className="text-nova-violet-bright/80"
			/>
			<span className="max-w-[240px] truncate">Case {index + 1}</span>
		</div>
	);
}
