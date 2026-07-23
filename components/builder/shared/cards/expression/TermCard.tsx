// components/builder/shared/cards/expression/TermCard.tsx
//
// Term-arm card for the ValueExpression editor — the universal value
// carrier. Edits the six authorable Term variants:
//
//   - `prop` — case property reference (with optional `via:
//     RelationPath` walk preserved across edits via the shared
//     `PropertyRefPicker`).
//   - `input` — search-input ref (named picker over declared inputs).
//   - `session-context` — closed-namespace session field (`userid` /
//     `username` / `deviceid` / `appversion`).
//   - `session-user` — open-namespace user-data field (free-text).
//   - `field` — stable form-field identity, preserved here but authored only
//     by the future case-operation editor.
//   - `literal` — primitive constant (string / number / boolean /
//     null) with optional `data_type` qualifier preserved on rebuild.
//   - `table-column` remains a dormant compatibility carrier: a direct
//     preserved value renders read-only and never enters the source menu.
//
// The card edits ONLY Term-shaped values — non-Term ValueExpression
// arms route through their own dedicated cards (ArithCard / IfCard /
// etc.) at the `ExpressionPicker` shell's registry-driven dispatch.
//
// Valid by construction: the card takes the slot's `SlotConstraint`
// and gates every value source against it — a source that can't
// produce an accepted type is disabled WITH A REASON (never dimmed),
// the property / search-input dropdowns filter to admissible entries,
// and the literal shape menu offers only shapes whose value type the
// slot accepts. A `nonEmpty` slot refuses to commit an empty literal.
// The current source / shape stays selectable even when the constraint
// no longer admits it (legacy-open backstop).

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import tablerSwitch from "@iconify-icons/tabler/switch";
import tablerUser from "@iconify-icons/tabler/user";
import tablerVariable from "@iconify-icons/tabler/variable";
import {
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { FieldError } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	asUuid,
	type CaseProperty,
	type CasePropertyDataType,
	canonicalCasePropertyName,
	effectiveDataType,
} from "@/lib/domain";
import {
	ANY_CONSTRAINT,
	acceptsType,
	dateLiteral,
	datetimeLiteral,
	formField,
	input,
	type Literal,
	literal,
	prop,
	type ResolvedType,
	reasonFor,
	type SlotConstraint,
	sessionContext,
	sessionUser,
	type Term,
	timeLiteral,
	type ValueExpression,
	term as wrapTerm,
	XML_ELEMENT_NAME_PATTERN,
} from "@/lib/domain/predicate";
import {
	type AdmitExpressionChange,
	useEditorErrorsAt,
	useEditorErrorsBelow,
	useExpressionFocusTarget,
	usePredicateEditContext,
} from "../../editorContext";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { rebuildLiteralPreservingDataType } from "../../literalRebuild";
import type { EditorPath } from "../../path";
import { InlineError } from "../../primitives/CardShell";
import { PropertyRefPicker } from "../../primitives/PropertyRefPicker";
import { searchInputDisplayLabel } from "../../searchInputPresentation";
import { reseedLiteralForConstraint } from "../reseed";

/** Default Term-arm value — a `term(literal(""))`. The empty literal
 *  renders the typed text input directly; authors who want a different
 *  Term variant flip the mode menu. */
export function termDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "term" }> {
	return wrapTerm(literal(""));
}

/** Term mode discriminator — one per Term arm. Drives the mode menu
 *  in the card's body. */
type TermMode =
	| "literal"
	| "property"
	| "field"
	| "input"
	| "session-context"
	| "session-user";

interface TermDraft {
	readonly value: Term;
	readonly authored: boolean;
}

interface PendingTermModeChange {
	readonly source: Term;
	readonly targetMode: TermMode;
	/** A source without a schema-valid automatic default is collected inside
	 * the confirmation before it is allowed to reach the document. */
	readonly userFieldDraft?: string;
	readonly replacesAuthoredSource: boolean;
}

interface TermCardProps {
	readonly value: Extract<ValueExpression, { kind: "term" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
	/** The slot's type constraint — gates the value sources and the
	 *  literal shape menu. Defaults to `ANY_CONSTRAINT`. */
	readonly constraint?: SlotConstraint;
	/** Copy context for the source menu. A predicate's left side is the
	 *  condition subject, so its property source reads "Case information";
	 *  ordinary value slots read "Other case information". The editor and AST
	 *  behavior are identical. */
	readonly sourceContext?: "value" | "subject";
	/** Extra entries the picker shell injects into the source menu —
	 *  the computed expression kinds (math, if–then, today, …), so ONE
	 *  dropdown answers "what is this value?" without a separate
	 *  Change affordance. Built by `ExpressionPicker` (which owns the
	 *  expression registry) to keep the module graph acyclic. */
	readonly computedItems?: React.ReactNode;
}

/**
 * Term-arm card. Renders a mode toggle + per-mode body editor.
 *
 * Path encoding: the typeChecker delegates the `term` arm directly
 * to `resolveTermType(...)` with the path UNCHANGED — Term-resolution
 * errors land at the slot path, not at `[..., "term"]`. The card
 * therefore looks up errors at its own path, not at a deeper
 * sub-segment.
 */
export function TermCard(props: TermCardProps) {
	if (props.value.term.kind === "table-column") {
		return <DormantTableColumnTerm />;
	}
	return <EditableTermCard {...props} />;
}

/**
 * A direct table-column term is a preserved compatibility carrier, not an
 * authorable value source. Keep it visible without mounting source menus or
 * controls that could rewrite the carrier before lookup authoring lands.
 */
function DormantTableColumnTerm() {
	return (
		<div
			role="note"
			aria-label="Saved lookup table value"
			className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-white/[0.06] bg-nova-deep/50 px-3 py-2"
		>
			<Icon
				icon={tablerDatabase}
				width="14"
				height="14"
				aria-hidden="true"
				className="shrink-0 text-nova-violet-bright"
			/>
			<span className="min-w-0">
				<span className="block text-sm text-nova-text">Lookup table value</span>
				<span className="block text-[13px] text-nova-text-muted">
					Read only in this editor
				</span>
			</span>
		</div>
	);
}

function EditableTermCard({
	value,
	onChange,
	path,
	constraint = ANY_CONSTRAINT,
	sourceContext = "value",
	computedItems,
}: TermCardProps) {
	const ctx = usePredicateEditContext();
	// Term-side error rendering — two sources:
	//
	//   - `errors` (exact-at-path): the general-purpose term-arm
	//     branch in `checkExpression` calls `resolveTermType(...,
	//     path)` UNCHANGED, so unknown-property / unknown-input
	//     failures land at the slot path itself. The picker shell's
	//     `CardShell` footer ALREADY renders errors at this exact
	//     path; the card reads them here only to drive the input's
	//     `aria-invalid` state.
	//
	//   - `descendantErrors`: a small set of upstream call sites
	//     (notably `checkMatch`) push term-resolution failures one
	//     segment deeper at `[..., slotPath, "term"]` because they
	//     resolve the term directly without going through
	//     `checkExpression`. The shell's exact-at-path lookup misses
	//     these; the card surfaces them inline below the input so the
	//     diagnostic still reaches the user.
	const errors = useEditorErrorsAt(path);
	const descendantErrors = useEditorErrorsBelow(path);

	const term = value.term;
	const mode = termMode(term);
	const sourceTriggerRef = useRef<HTMLButtonElement>(null);
	const { register: registerExpressionFocusTarget } =
		useExpressionFocusTarget(path);
	const setSourceTriggerRef = useCallback(
		(target: HTMLButtonElement | null) => {
			sourceTriggerRef.current = target;
			registerExpressionFocusTarget(target);
		},
		[registerExpressionFocusTarget],
	);
	const draftsByModeRef = useRef(new Map<TermMode, TermDraft>());
	const [pendingModeChange, setPendingModeChange] =
		useState<PendingTermModeChange | null>(null);
	const replacementUserFieldId = useId();
	const replacementUserFieldHelpId = `${replacementUserFieldId}-help`;

	// Each source keeps its own mounted draft. Controlled parents often parse
	// and clone the emitted object, so preserve the draft's authored/default
	// provenance when the semantic value is unchanged rather than relying on
	// object identity.
	useEffect(() => {
		const saved = draftsByModeRef.current.get(mode);
		if (saved === undefined) {
			draftsByModeRef.current.set(mode, {
				value: term,
				authored: termHasMeaningfulContent(term),
			});
			return;
		}
		if (saved.value === term) return;
		draftsByModeRef.current.set(mode, {
			value: term,
			authored: termsMatch(saved.value, term)
				? saved.authored
				: termHasMeaningfulContent(term),
		});
	}, [mode, term]);

	const modeAdmission = useMemo(
		() => computeModeAdmission(ctx, constraint, path),
		[ctx, constraint, path],
	);

	const applyMode = useCallback(
		(next: TermMode, explicitTarget?: Term) => {
			if (next === mode) return;
			const currentDraft = draftsByModeRef.current.get(mode);
			draftsByModeRef.current.set(mode, {
				value: term,
				authored:
					currentDraft !== undefined && termsMatch(currentDraft.value, term)
						? currentDraft.authored
						: termHasMeaningfulContent(term),
			});

			let targetDraft =
				explicitTarget === undefined
					? draftsByModeRef.current.get(next)
					: { value: explicitTarget, authored: true };
			if (targetDraft === undefined) {
				targetDraft = {
					value: buildTermDefault(next, ctx, constraint),
					authored: false,
				};
			}
			draftsByModeRef.current.set(next, targetDraft);
			onChange(wrapTerm(targetDraft.value));
		},
		[constraint, ctx, mode, onChange, term],
	);

	const requestMode = useCallback(
		(next: TermMode) => {
			if (next === mode) return;
			const currentDraft = draftsByModeRef.current.get(mode);
			const authored =
				currentDraft !== undefined && termsMatch(currentDraft.value, term)
					? currentDraft.authored
					: termHasMeaningfulContent(term);
			const replacesAuthoredSource = authored && termHasMeaningfulContent(term);
			const savedTarget = draftsByModeRef.current.get(next)?.value;
			const userFieldDraft =
				next === "session-user"
					? savedTarget?.kind === "session-user"
						? savedTarget.field
						: ""
					: undefined;
			const needsUserField =
				next === "session-user" &&
				(userFieldDraft === undefined || !userFieldIsValid(userFieldDraft));
			if (replacesAuthoredSource || needsUserField) {
				setPendingModeChange({
					source: term,
					targetMode: next,
					userFieldDraft,
					replacesAuthoredSource,
				});
				return;
			}
			applyMode(next);
		},
		[applyMode, mode, term],
	);

	const handleTermChange = useCallback(
		(next: Term) => {
			draftsByModeRef.current.set(termMode(next), {
				value: next,
				authored: true,
			});
			onChange(wrapTerm(next));
		},
		[onChange],
	);
	const literalValue = term.kind === "literal" ? term : null;
	const literalShape =
		literalValue === null ? "text" : classifyLiteralShape(literalValue);
	const draftsByShapeRef = useRef(new Map<LiteralShape, LiteralDraft>());
	const [pendingShapeChange, setPendingShapeChange] =
		useState<PendingLiteralShapeChange | null>(null);

	useEffect(() => {
		if (literalValue === null) return;
		const saved = draftsByShapeRef.current.get(literalShape);
		if (saved === undefined) {
			draftsByShapeRef.current.set(literalShape, {
				value: literalValue,
				authored: literalHasMeaningfulContent(literalValue),
			});
			return;
		}
		if (saved.value === literalValue) return;
		draftsByShapeRef.current.set(literalShape, {
			value: literalValue,
			authored: literalsMatch(saved.value, literalValue)
				? saved.authored
				: literalHasMeaningfulContent(literalValue),
		});
	}, [literalShape, literalValue]);

	const applyLiteralShape = useCallback(
		(next: LiteralShape) => {
			if (literalValue === null || next === literalShape) return;
			const currentDraft = draftsByShapeRef.current.get(literalShape);
			draftsByShapeRef.current.set(literalShape, {
				value: literalValue,
				authored:
					currentDraft !== undefined &&
					literalsMatch(currentDraft.value, literalValue)
						? currentDraft.authored
						: literalHasMeaningfulContent(literalValue),
			});
			let targetDraft = draftsByShapeRef.current.get(next);
			if (targetDraft === undefined) {
				targetDraft = {
					value: buildLiteralForShape(next),
					authored: false,
				};
				draftsByShapeRef.current.set(next, targetDraft);
			}
			handleTermChange(targetDraft.value);
		},
		[handleTermChange, literalShape, literalValue],
	);

	const requestLiteralShape = useCallback(
		(next: LiteralShape) => {
			if (literalValue === null || next === literalShape) return;
			const currentDraft = draftsByShapeRef.current.get(literalShape);
			const authored =
				currentDraft !== undefined &&
				literalsMatch(currentDraft.value, literalValue)
					? currentDraft.authored
					: literalHasMeaningfulContent(literalValue);
			if (authored && literalHasMeaningfulContent(literalValue)) {
				setPendingShapeChange({ source: literalValue, targetShape: next });
				return;
			}
			applyLiteralShape(next);
		},
		[applyLiteralShape, literalShape, literalValue],
	);

	const handleBodyTermChange = useCallback(
		(next: Term) => {
			if (next.kind === "literal") {
				draftsByShapeRef.current.set(classifyLiteralShape(next), {
					value: next,
					authored: true,
				});
			}
			handleTermChange(next);
		},
		[handleTermChange],
	);

	const pendingCopy =
		pendingModeChange === null
			? null
			: !pendingModeChange.replacesAuthoredSource &&
					pendingModeChange.targetMode === "session-user"
				? {
						title: "Which user information?",
						description: "Enter the saved user field this condition should use",
					}
				: describeTermModeReplacement(
						pendingModeChange.source,
						termModeLabel(pendingModeChange.targetMode, sourceContext),
					);
	const pendingUserField = pendingModeChange?.userFieldDraft;
	const pendingUserFieldError =
		pendingUserField === undefined ||
		pendingUserField.length === 0 ||
		userFieldIsValid(pendingUserField)
			? undefined
			: userFieldError(pendingUserField);
	const pendingShapeCopy =
		pendingShapeChange === null
			? null
			: describeLiteralShapeReplacement(
					classifyLiteralShape(pendingShapeChange.source),
					pendingShapeChange.targetShape,
				);

	return (
		<>
			<div className="space-y-1">
				<div className="grid grid-cols-1 @md:grid-cols-[auto_1fr] gap-2 items-start">
					<ModeMenu
						mode={mode}
						setMode={requestMode}
						admission={modeAdmission}
						sourceContext={sourceContext}
						computedItems={computedItems}
						triggerRef={sourceTriggerRef}
						setTriggerRef={setSourceTriggerRef}
						literalShape={literalValue === null ? undefined : literalShape}
						onLiteralShapeChange={requestLiteralShape}
						literalConstraint={constraint}
					/>
					<TermBodyInput
						term={term}
						onChange={handleBodyTermChange}
						constraint={constraint}
						invalid={errors.length > 0 || descendantErrors.length > 0}
						path={path}
						admitExpressionChange={ctx.admitExpressionChange}
					/>
				</div>
				{descendantErrors.length > 0 && (
					<InlineError errors={descendantErrors} />
				)}
			</div>
			<AlertDialog
				open={pendingModeChange !== null}
				onOpenChange={(open) => {
					if (open) return;
					setPendingModeChange(null);
				}}
			>
				<AlertDialogContent finalFocus={sourceTriggerRef} className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle>{pendingCopy?.title}</AlertDialogTitle>
						<AlertDialogDescription className="text-left">
							{pendingCopy?.description}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{pendingUserField !== undefined ? (
						<div className="space-y-2">
							<label
								htmlFor={replacementUserFieldId}
								className="text-sm font-medium text-nova-text"
							>
								User field name
							</label>
							<Input
								id={replacementUserFieldId}
								type="text"
								required
								value={pendingUserField}
								onChange={(event) =>
									setPendingModeChange((current) =>
										current === null
											? null
											: {
													...current,
													userFieldDraft: event.target.value,
												},
									)
								}
								autoComplete="off"
								data-1p-ignore
								aria-invalid={pendingUserFieldError !== undefined || undefined}
								aria-describedby={replacementUserFieldHelpId}
								className={userFieldInputClass(
									pendingUserFieldError !== undefined,
								)}
							/>
							{pendingUserFieldError === undefined ? (
								<p
									id={replacementUserFieldHelpId}
									className="text-[13px] leading-5 text-nova-text-secondary"
								>
									Use the field name saved on the user, like assigned_region
								</p>
							) : (
								<FieldError
									id={replacementUserFieldHelpId}
									className="text-[13px] leading-5 text-nova-rose"
								>
									{pendingUserFieldError}
								</FieldError>
							)}
						</div>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant={
								pendingModeChange?.replacesAuthoredSource === true
									? "destructive"
									: "default"
							}
							disabled={
								pendingUserField !== undefined &&
								!userFieldIsValid(pendingUserField)
							}
							onClick={() => {
								if (pendingModeChange === null) return;
								const explicitTarget =
									pendingModeChange.userFieldDraft === undefined
										? undefined
										: userFieldIsValid(pendingModeChange.userFieldDraft)
											? sessionUser(pendingModeChange.userFieldDraft)
											: null;
								if (explicitTarget === null) return;
								if (termsMatch(pendingModeChange.source, term)) {
									applyMode(pendingModeChange.targetMode, explicitTarget);
								}
								setPendingModeChange(null);
							}}
						>
							{pendingModeChange?.replacesAuthoredSource === false
								? "Use field"
								: "Replace"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog
				open={pendingShapeChange !== null}
				onOpenChange={(open) => {
					if (open) return;
					setPendingShapeChange(null);
				}}
			>
				<AlertDialogContent finalFocus={sourceTriggerRef} className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle>{pendingShapeCopy?.title}</AlertDialogTitle>
						<AlertDialogDescription className="text-left">
							{pendingShapeCopy?.description}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (pendingShapeChange === null || literalValue === null)
									return;
								if (literalsMatch(pendingShapeChange.source, literalValue)) {
									applyLiteralShape(pendingShapeChange.targetShape);
								}
								setPendingShapeChange(null);
							}}
						>
							Change value
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/** Read the mode discriminator from the Term's `kind`. Maps `prop`
 *  to "property" because the user-facing label is "Case property"
 *  rather than "Prop"; every other kind reads through unchanged. */
function termMode(term: Term): TermMode {
	switch (term.kind) {
		case "literal":
			return "literal";
		case "prop":
			return "property";
		case "field":
			return "field";
		case "input":
			return "input";
		case "session-context":
			return "session-context";
		case "session-user":
			return "session-user";
		case "table-column":
			throw dormantTableColumnAuthoringError();
	}
}

function dormantTableColumnAuthoringError(): Error {
	return new Error(
		"Lookup table columns are dormant and cannot reach the generic term editor.",
	);
}

function termsMatch(left: Term, right: Term): boolean {
	if (left === right) return true;
	return JSON.stringify(left) === JSON.stringify(right);
}

function literalHasMeaningfulContent(value: Literal): boolean {
	return typeof value.value === "string" ? value.value.length > 0 : true;
}

export function termHasMeaningfulContent(value: Term): boolean {
	switch (value.kind) {
		case "literal":
			return literalHasMeaningfulContent(value);
		case "prop":
			return value.property.length > 0 || value.via !== undefined;
		case "field":
			return true;
		case "input":
			return (value.name ?? "").length > 0;
		case "session-context":
			return true;
		case "session-user":
			return value.field.length > 0;
		case "table-column":
			throw dormantTableColumnAuthoringError();
	}
}

function termModeLabel(
	mode: TermMode,
	sourceContext: "value" | "subject",
): string {
	switch (mode) {
		case "literal":
			return "A value";
		case "property":
			return sourceContext === "subject"
				? "Case information"
				: "Other case information";
		case "field":
			return "A form answer";
		case "input":
			return "A search answer";
		case "session-context":
			return "App information";
		case "session-user":
			return "User information";
	}
}

function describeTermModeReplacement(
	source: Term,
	targetLabel: string,
): { readonly title: string; readonly description: string } {
	const replacement = targetLabel.replace(/^./, (letter) =>
		letter.toLocaleLowerCase(),
	);
	const title = `Use ${replacement} instead?`;
	switch (source.kind) {
		case "literal":
			return {
				title,
				description: "This replaces the saved value. You can undo this change.",
			};
		case "prop":
			return source.via === undefined
				? {
						title,
						description:
							"This replaces the selected case information. You can undo this change.",
					}
				: {
						title,
						description:
							"This replaces the selected case information and its connection. You can undo this change.",
					};
		case "field":
			return {
				title,
				description:
					"This replaces the selected form answer. You can undo this change.",
			};
		case "input":
			return {
				title,
				description:
					"This replaces the selected search answer. You can undo this change.",
			};
		case "session-context":
			return {
				title,
				description:
					"This replaces the selected app information. You can undo this change.",
			};
		case "session-user":
			return {
				title,
				description:
					"This replaces the saved user information field. You can undo this change.",
			};
		case "table-column":
			throw dormantTableColumnAuthoringError();
	}
}

/** Whether the slot accepts a value of type `t` — `ANY_CONSTRAINT`
 *  admits everything. */
function constraintAdmitsType(
	constraint: SlotConstraint,
	t: ResolvedType,
): boolean {
	return constraint.accepts === "any" || acceptsType(constraint, t);
}

/** A property filter derived from the slot constraint — `undefined`
 *  (no narrowing) when the constraint is unconstrained. Memoize at the
 *  call site so `PropertyPicker`'s `[caseType, filter]` memo stays
 *  stable across renders with the same constraint. */
function propertyFilterFor(
	constraint: SlotConstraint,
): ((p: CaseProperty) => boolean) | undefined {
	if (constraint.accepts === "any") return undefined;
	return (p) => acceptsType(constraint, effectiveDataType(p));
}

/** Per-mode admission verdict + reason for the source menu. */
type ModeAdmission = Record<TermMode, { admitted: boolean; reason?: string }>;

interface TermAdmissionContext extends ExpressionEditContext {
	readonly admitExpressionChange?: AdmitExpressionChange;
}

/**
 * Resolve which Term sources can produce a value the slot accepts:
 *   - `literal` — admitted unless this exact node is an absence-check
 *     subject. Otherwise a literal can be `null`, which is compatible
 *     with every type, and the shape menu does the fine-grained gating
 *     per accepted type.
 *   - `property` — admitted when a property of an accepted type
 *     exists on the current case type.
 *   - `input` — admitted when a declared search input of an accepted
 *     type is in scope.
 *   - `session-context` / `session-user` — resolve to `text`, so
 *     admitted only when the slot accepts text.
 */
function computeModeAdmission(
	ctx: TermAdmissionContext,
	constraint: SlotConstraint,
	path: EditorPath,
): ModeAdmission {
	const reason = reasonFor(constraint);
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const hasAcceptedProperty =
		constraint.accepts === "any" ||
		(ct?.properties.some((p) =>
			acceptsType(constraint, effectiveDataType(p)),
		) ??
			false);
	const hasAcceptedInput =
		constraint.accepts === "any" ||
		ctx.knownInputs.some((i) => acceptsType(constraint, i.data_type ?? "text"));
	const textAdmitted = constraintAdmitsType(constraint, "text");
	const typeAdmission: ModeAdmission = {
		literal:
			constraint.forbidDirectLiteral === true
				? {
						admitted: false,
						reason:
							"Use case information, a search answer, app information, or a calculation here",
					}
				: { admitted: true },
		property: hasAcceptedProperty
			? { admitted: true }
			: { admitted: false, reason },
		field: {
			admitted: false,
			reason: "Form answers are selected when configuring case operations",
		},
		input: hasAcceptedInput ? { admitted: true } : { admitted: false, reason },
		"session-context": textAdmitted
			? { admitted: true }
			: { admitted: false, reason },
		"session-user": textAdmitted
			? { admitted: true }
			: { admitted: false, reason },
	};
	if (ctx.admitExpressionChange === undefined) return typeAdmission;

	return Object.fromEntries(
		(Object.keys(typeAdmission) as TermMode[]).map((mode) => {
			const slotVerdict = typeAdmission[mode];
			if (!slotVerdict.admitted) return [mode, slotVerdict];
			const ruleVerdict = ctx.admitExpressionChange?.(
				path,
				wrapTerm(buildTermAdmissionProbe(mode, ctx, constraint)),
			);
			return [mode, ruleVerdict ?? slotVerdict];
		}),
	) as ModeAdmission;
}

/** Use a schema-valid representative only to ask a rule-level admission
 * checker whether a source family is allowed. User information has no honest
 * semantic default, so this probe must never become authored data. */
function buildTermAdmissionProbe(
	mode: TermMode,
	ctx: ExpressionEditContext,
	constraint: SlotConstraint,
): Term {
	return mode === "session-user"
		? sessionUser("_")
		: buildTermDefault(mode, ctx, constraint);
}

/** Build a per-mode draft. Property, search-answer, and app-information
 * defaults are schema-valid choices. User information deliberately starts
 * incomplete because inventing a field would silently change the rule's
 * meaning; `requestMode` collects that field before this draft may commit. */
function buildTermDefault(
	mode: TermMode,
	ctx: ExpressionEditContext,
	constraint: SlotConstraint,
): Term {
	switch (mode) {
		case "literal":
			return constraint.accepts === "any"
				? literal("")
				: reseedLiteralForConstraint(literal(""), constraint.accepts);
		case "property": {
			const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
			const filter = propertyFilterFor(constraint);
			const property = ct?.properties.find((p) => (filter ? filter(p) : true));
			// Default to a placeholder property name — the picker surfaces
			// "Pick a property" until the author picks one, and the type
			// checker surfaces "Unknown property ''" inline.
			return prop(
				ctx.currentCaseType,
				canonicalCasePropertyName(property?.name ?? ""),
			);
		}
		case "field":
			// Form-field references are authored only by the case-operation editor.
			// This unreachable seed exists so the generic round-trip editor remains
			// exhaustive without inventing a user-authored reference.
			return formField(asUuid("00000000-0000-4000-8000-000000000000"));
		case "input": {
			const matching = ctx.knownInputs.find((i) =>
				constraint.accepts === "any"
					? true
					: acceptsType(constraint, i.data_type ?? "text"),
			);
			return input(matching?.name ?? ctx.knownInputs[0]?.name ?? "");
		}
		case "session-context":
			// `userid` is the most authored choice ("owned by me"
			// filters in the case-list); other fields require an
			// explicit pick.
			return sessionContext("userid");
		case "session-user":
			// Open-namespace user-data field — defaults to a placeholder.
			// The card surfaces a per-slot error until the author types
			// a real field name.
			return sessionUser("");
	}
}

interface ModeMenuProps {
	readonly mode: TermMode;
	readonly setMode: (mode: TermMode) => void;
	readonly admission: ModeAdmission;
	readonly sourceContext: "value" | "subject";
	readonly computedItems?: React.ReactNode;
	readonly triggerRef: RefObject<HTMLButtonElement | null>;
	readonly setTriggerRef: (target: HTMLButtonElement | null) => void;
	readonly literalShape?: LiteralShape;
	readonly onLiteralShapeChange: (shape: LiteralShape) => void;
	readonly literalConstraint: SlotConstraint;
}

function ModeMenu({
	mode,
	setMode,
	admission,
	sourceContext,
	computedItems,
	triggerRef,
	setTriggerRef,
	literalShape,
	onLiteralShapeChange,
	literalConstraint,
}: ModeMenuProps) {
	const triggerId = useId();
	const ctx = usePredicateEditContext();

	const items = useMemo<
		readonly { mode: TermMode; label: string; icon: IconifyIcon }[]
	>(() => {
		const base: { mode: TermMode; label: string; icon: IconifyIcon }[] = [
			{
				mode: "literal",
				label: termModeLabel("literal", sourceContext),
				icon: tablerVariable,
			},
			{
				mode: "property",
				label: termModeLabel("property", sourceContext),
				icon: tablerDatabase,
			},
		];
		if (mode === "field") {
			base.push({
				mode: "field",
				label: termModeLabel("field", sourceContext),
				icon: tablerVariable,
			});
		}
		if (mode === "input" || ctx.knownInputs.length > 0) {
			base.push({
				mode: "input",
				label: termModeLabel("input", sourceContext),
				icon: tablerSwitch,
			});
		}
		base.push({
			mode: "session-context",
			label: termModeLabel("session-context", sourceContext),
			icon: tablerUser,
		});
		base.push({
			mode: "session-user",
			label: termModeLabel("session-user", sourceContext),
			icon: tablerSparkles,
		});
		return base;
	}, [ctx.knownInputs, mode, sourceContext]);

	const activeItem = items.find((i) => i.mode === mode) ?? items[0];

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={setTriggerRef}
				id={triggerId}
				aria-label={`${sourceContext === "subject" ? "Condition source" : "Value source"}: ${activeItem.label}`}
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className="group min-h-11 justify-start border-white/[0.06] bg-nova-deep/50 px-3 text-sm text-nova-text-muted not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-deep/50 not-disabled:hover:text-nova-text dark:bg-nova-deep/50"
					/>
				}
			>
				<Icon
					icon={activeItem.icon}
					width="14"
					height="14"
					className="text-nova-violet-bright"
				/>
				<span>{activeItem.label}</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="ml-auto shrink-0 transition-transform group-data-[popup-open]:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuPortal>
				<DropdownMenuPositioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
				>
					<DropdownMenuPopup>
						{items.map((item) => {
							const isActive = item.mode === mode;
							// The active source stays selectable even when the
							// constraint no longer admits it (legacy-open backstop);
							// every other inadmissible source is disabled with its
							// reason rather than dimmed-but-clickable.
							const verdict = admission[item.mode];
							const admitted = isActive || verdict.admitted;
							const hasReason = !admitted && verdict.reason !== undefined;
							return (
								<DropdownMenuItem
									key={item.mode}
									disabled={!admitted}
									onClick={() => setMode(item.mode)}
									className={
										isActive ? "bg-nova-violet/10 text-nova-violet-bright" : ""
									}
								>
									<Icon
										icon={item.icon}
										width="14"
										height="14"
										className={
											isActive
												? "text-nova-violet-bright"
												: "text-nova-text-muted"
										}
									/>
									<span className="flex-1 text-left min-w-0">
										<div className="break-words">{item.label}</div>
										{hasReason && (
											<div className="break-words text-xs text-nova-text-muted">
												{verdict.reason}
											</div>
										)}
									</span>
								</DropdownMenuItem>
							);
						})}
						{literalShape !== undefined && (
							<LiteralShapeSubmenu
								shape={literalShape}
								onSelect={onLiteralShapeChange}
								constraint={literalConstraint}
							/>
						)}
						{computedItems !== undefined && (
							<>
								<div
									className="mt-1 border-t border-white/[0.06] px-3 pt-2.5 pb-1 text-xs font-medium text-nova-text-muted"
									role="presentation"
								>
									Calculated
								</div>
								{computedItems}
							</>
						)}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}

interface TermBodyInputProps {
	readonly term: Term;
	readonly onChange: (next: Term) => void;
	readonly constraint: SlotConstraint;
	readonly invalid: boolean;
	readonly path: EditorPath;
	readonly admitExpressionChange: AdmitExpressionChange | undefined;
}

/**
 * Per-mode body editor. Dispatches on the Term's `kind` and renders
 * the matching input shape. The Term arm's `kind` discriminator is
 * exhaustively narrowed; an unhandled case is a TypeScript build
 * error.
 */
function TermBodyInput({
	term,
	onChange,
	constraint,
	invalid,
	path,
	admitExpressionChange,
}: TermBodyInputProps) {
	const propertyFilter = useMemo(
		() => propertyFilterFor(constraint),
		[constraint],
	);
	switch (term.kind) {
		case "literal":
			// The constraint already carries the subject's resolved type, so the
			// ordinary path is just the matching input. Literal type choices remain
			// available from the single Value source menu instead of leaking a
			// second technical selector into every comparison row.
			return (
				<LiteralBodyInput
					value={term}
					onChange={onChange}
					shape={classifyLiteralShape(term)}
					nonEmpty={constraint.nonEmpty === true}
					invalid={invalid}
				/>
			);
		case "prop":
			// Routes through `PropertyRefPicker` so the prop's optional
			// `via: RelationPath` walk round-trips on every property name
			// change. The picker handles the canonical-vs-non-canonical
			// branch internally and rebuilds via `prop(caseType, name,
			// via)` (three-arg form) — bypassing this primitive would
			// silently drop authored relation walks on first user click.
			// The constraint filter narrows the dropdown to properties of
			// an accepted type.
			return (
				<PropertyRefPicker
					mode="property-only"
					value={term}
					onChange={(next) => onChange(next)}
					admitChange={(next) =>
						admitExpressionChange?.(path, wrapTerm(next)) ?? {
							admitted: true,
						}
					}
					filter={propertyFilter}
					invalid={invalid}
				/>
			);
		case "field":
			return (
				<Input
					value={term.uuid}
					readOnly
					aria-label="Referenced form field"
					aria-invalid={invalid || undefined}
				/>
			);
		case "input":
			return (
				<InputRefMenu
					value={term.name}
					onChange={(name) => onChange(input(name))}
					constraint={constraint}
					invalid={invalid}
				/>
			);
		case "session-context":
			return (
				<SessionContextMenu
					value={term.field}
					onChange={(field) => onChange(sessionContext(field))}
					invalid={invalid}
				/>
			);
		case "session-user":
			return (
				<UserFieldInput
					value={term.field}
					onChange={(field) => onChange(sessionUser(field))}
					invalid={invalid}
				/>
			);
		case "table-column":
			throw dormantTableColumnAuthoringError();
	}
}

interface InputRefMenuProps {
	readonly value: string | undefined;
	readonly onChange: (name: string) => void;
	readonly constraint: SlotConstraint;
	readonly invalid: boolean;
}

const SEARCH_ANSWER_TYPE_LABELS: Record<CasePropertyDataType, string> = {
	text: "Text",
	int: "Number",
	decimal: "Number",
	date: "Date",
	time: "Time",
	datetime: "Date and time",
	single_select: "Single choice",
	multi_select: "Multiple choices",
	geopoint: "Location",
};

/** Search-input dropdown — picks from declared search inputs in
 *  scope whose declared type the slot accepts. A saved input that is
 *  no longer declared keeps its readable identity and a recovery menu
 *  instead of collapsing to an empty placeholder. The currently-selected
 *  input always shows (legacy-open backstop) even when its type is no longer
 *  admitted. */
function InputRefMenu({
	value,
	onChange,
	constraint,
	invalid,
}: InputRefMenuProps) {
	const ctx = usePredicateEditContext();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const items = useMemo(
		() =>
			ctx.knownInputs.filter(
				(i) =>
					i.name === value ||
					constraint.accepts === "any" ||
					acceptsType(constraint, i.data_type ?? "text"),
			),
		[ctx.knownInputs, constraint, value],
	);
	const current = items.find((i) => i.name === value);
	const hasSavedValue = value !== undefined && value.trim().length > 0;
	const currentMissing = hasSavedValue && current === undefined;
	const currentLabel =
		current !== undefined
			? searchInputDisplayLabel(current.name, ctx.knownInputs)
			: hasSavedValue
				? searchInputDisplayLabel(value, ctx.knownInputs)
				: undefined;
	const triggerClass = [
		"group h-auto min-h-11 w-full justify-between rounded-lg border bg-nova-deep/50 px-3 py-2 text-sm text-nova-text whitespace-normal dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50",
		invalid
			? "border-nova-rose/40"
			: "border-white/[0.06] not-disabled:hover:border-nova-violet/30",
	].join(" ");

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				aria-label={`Search answer: ${currentLabel ?? "Choose a search answer"}${currentMissing ? ", no longer available" : ""}`}
				aria-invalid={invalid || undefined}
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className={triggerClass}
					/>
				}
			>
				<span className="min-w-0 flex-1 text-left">
					<span className="block break-words text-nova-violet-bright">
						{currentLabel ?? "Choose a search answer"}
					</span>
					{currentMissing ? (
						<span className="block text-xs font-normal text-nova-rose">
							No longer available
						</span>
					) : null}
				</span>
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
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<DropdownMenuPopup className="min-w-0">
						{currentMissing ? (
							<div
								className={
									items.length > 0
										? "border-b border-white/[0.06] px-3 py-2.5"
										: "px-3 py-2.5"
								}
								role="presentation"
							>
								<div className="break-words text-sm font-medium text-nova-text">
									{currentLabel} is no longer available
								</div>
								<div className="mt-1 text-[13px] leading-5 text-nova-text-secondary">
									{items.length > 0
										? "Choose another search answer below, or add this search field again"
										: "Choose another value source, or add this search field again"}
								</div>
							</div>
						) : items.length === 0 ? (
							<div
								className="px-3 py-2.5 text-[13px] leading-5 text-nova-text-secondary"
								role="presentation"
							>
								No compatible search answers are available. Choose another value
								source or add a search field.
							</div>
						) : null}
						{items.map((it) => {
							const isActive = it.name === value;
							return (
								<DropdownMenuItem
									key={it.name}
									onClick={() => onChange(it.name)}
									className={
										isActive ? "bg-nova-violet/10 text-nova-violet-bright" : ""
									}
								>
									<span className="min-w-0 flex-1 break-words">
										{searchInputDisplayLabel(it.name, ctx.knownInputs)}
									</span>
									{it.data_type && (
										<span className="text-xs text-nova-text-muted">
											{SEARCH_ANSWER_TYPE_LABELS[it.data_type]}
										</span>
									)}
								</DropdownMenuItem>
							);
						})}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}

/** Closed-namespace session field menu. The four fields come from
 *  `SESSION_CONTEXT_FIELDS` in the predicate package; widening the
 *  set requires a parallel edit there + here so the type stays
 *  closed at compile time. */
function SessionContextMenu({
	value,
	onChange,
	invalid,
}: {
	readonly value: "userid" | "username" | "deviceid" | "appversion";
	readonly onChange: (
		field: "userid" | "username" | "deviceid" | "appversion",
	) => void;
	readonly invalid: boolean;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const items: readonly {
		field: "userid" | "username" | "deviceid" | "appversion";
		label: string;
	}[] = [
		{ field: "userid", label: "Current user's ID" },
		{ field: "username", label: "Current user's name" },
		{ field: "deviceid", label: "This device's ID" },
		{ field: "appversion", label: "App version" },
	];
	const current = items.find((i) => i.field === value) ?? items[0];
	const triggerClass = [
		"group min-h-11 w-full justify-between rounded-lg border bg-nova-deep/50 px-3 text-sm text-nova-text dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50",
		invalid
			? "border-nova-rose/40"
			: "border-white/[0.06] not-disabled:hover:border-nova-violet/30",
	].join(" ");

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				aria-label={`App information: ${current.label}`}
				aria-invalid={invalid || undefined}
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className={triggerClass}
					/>
				}
			>
				<span className="text-nova-violet-bright">{current.label}</span>
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
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<DropdownMenuPopup className="min-w-0">
						{items.map((it) => {
							const isActive = it.field === value;
							return (
								<DropdownMenuItem
									key={it.field}
									onClick={() => onChange(it.field)}
									className={
										isActive ? "bg-nova-violet/10 text-nova-violet-bright" : ""
									}
								>
									<span>{it.label}</span>
								</DropdownMenuItem>
							);
						})}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}

type LiteralShape =
	| "text"
	| "number"
	| "boolean"
	| "null"
	| "date"
	| "datetime"
	| "time";

interface LiteralDraft {
	readonly value: Literal;
	readonly authored: boolean;
}

interface PendingLiteralShapeChange {
	readonly source: Literal;
	readonly targetShape: LiteralShape;
}

/** Classify a literal into the editor's shape enum. Reads
 *  `data_type` first (the explicit qualifier set by `dateLiteral`
 *  etc.), then falls back to the JS runtime type — same fallback
 *  the type-checker's `literalType` uses. The classification drives
 *  the input variant; the runtime literal carries the matching
 *  qualifier on rebuild via the `buildLiteralForShape` mapping. */
function classifyLiteralShape(lit: Literal): LiteralShape {
	if (lit.data_type === "date") return "date";
	if (lit.data_type === "datetime") return "datetime";
	if (lit.data_type === "time") return "time";
	if (lit.value === null) return "null";
	if (typeof lit.value === "boolean") return "boolean";
	if (typeof lit.value === "number") return "number";
	return "text";
}

function literalsMatch(left: Literal, right: Literal): boolean {
	return left.value === right.value && left.data_type === right.data_type;
}

/** The resolved type a literal shape produces — drives the shape
 *  menu's per-shape admission against the slot's accept-set.
 *  `boolean` resolves to `text` (CommCare has no Boolean type); `null`
 *  resolves to the null sentinel (`_any`), compatible with every
 *  type. */
const LITERAL_SHAPE_TYPE: Record<LiteralShape, ResolvedType> = {
	text: "text",
	number: "int",
	boolean: "text",
	null: "_any",
	date: "date",
	datetime: "datetime",
	time: "time",
};

/** Initial draft for a shape the mounted editor has not visited yet.
 *  Typed builders carry the intended temporal qualifier; returning to
 *  a visited shape restores its cached draft instead. */
function buildLiteralForShape(shape: LiteralShape): Literal {
	switch (shape) {
		case "text":
			return literal("");
		case "number":
			return literal(0);
		case "boolean":
			return literal(false);
		case "null":
			return literal(null);
		case "date":
			return dateLiteral("");
		case "datetime":
			return datetimeLiteral("");
		case "time":
			return timeLiteral("");
	}
}

const LITERAL_SHAPE_LABELS: Record<LiteralShape, string> = {
	text: "Text",
	number: "Number",
	boolean: "Yes or no",
	null: "No value",
	date: "Date",
	datetime: "Date and time",
	time: "Time",
};

function describeLiteralShapeReplacement(
	source: LiteralShape,
	target: LiteralShape,
): { readonly title: string; readonly description: string } {
	const sourceDescription =
		source === "null"
			? "saved “No value” choice"
			: `saved ${LITERAL_SHAPE_LABELS[source].toLocaleLowerCase()} value`;
	return {
		title: `Change this value to ${LITERAL_SHAPE_LABELS[target].toLocaleLowerCase()}?`,
		description: `This replaces the ${sourceDescription}. You can undo this change.`,
	};
}

/** Literal types are progressive options inside the existing value-source
 * menu. The ordinary comparison path therefore renders one inferred input,
 * while imported and advanced literal shapes remain fully editable. */
function LiteralShapeSubmenu({
	shape,
	onSelect,
	constraint,
}: {
	readonly shape: LiteralShape;
	readonly onSelect: (shape: LiteralShape) => void;
	readonly constraint: SlotConstraint;
}) {
	const items: readonly LiteralShape[] = [
		"text",
		"number",
		"boolean",
		"null",
		"date",
		"datetime",
		"time",
	];
	const reason = reasonFor(constraint);
	return (
		<>
			<div
				className="mt-1 border-t border-white/[0.06] px-3 pt-2.5 pb-1 text-xs font-medium text-nova-text-muted"
				role="presentation"
			>
				Value options
			</div>
			<DropdownMenuSub>
				<DropdownMenuSubTrigger>
					<span className="min-w-0 flex-1 text-left">
						<span className="block">Value type</span>
						<span className="block text-xs text-nova-text-muted">
							{LITERAL_SHAPE_LABELS[shape]}
						</span>
					</span>
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent>
					{items.map((s) => {
						const isActive = s === shape;
						// The active shape stays selectable even when the
						// constraint no longer admits it (legacy-open backstop).
						const admitted =
							isActive ||
							constraintAdmitsType(constraint, LITERAL_SHAPE_TYPE[s]);
						return (
							<DropdownMenuItem
								key={s}
								disabled={!admitted}
								onClick={() => onSelect(s)}
								className={
									isActive
										? "bg-nova-violet/10 text-nova-violet-bright"
										: undefined
								}
							>
								<span className="flex-1 text-left min-w-0">
									<div className="break-words">{LITERAL_SHAPE_LABELS[s]}</div>
									{!admitted && (
										<div className="break-words text-xs text-nova-text-muted">
											{reason}
										</div>
									)}
								</span>
								{isActive && (
									<Icon
										icon={tablerCheck}
										width="14"
										height="14"
										className="text-nova-violet-bright"
									/>
								)}
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuSubContent>
			</DropdownMenuSub>
		</>
	);
}

const LITERAL_INPUT_CLS_VALID =
	"h-auto min-h-11 w-full rounded-lg border border-white/[0.06] bg-nova-deep/50 px-3 text-sm text-nova-text placeholder:text-nova-text-muted focus-visible:border-nova-violet/40 focus-visible:ring-nova-violet/30 md:text-sm dark:bg-nova-deep/50";
const LITERAL_INPUT_CLS_INVALID =
	"h-auto min-h-11 w-full rounded-lg border border-nova-rose/40 bg-nova-deep/50 px-3 text-sm text-nova-text placeholder:text-nova-text-muted focus-visible:border-nova-rose/60 focus-visible:ring-nova-rose/30 md:text-sm dark:bg-nova-deep/50";

function literalInputCls(invalid: boolean): string {
	return invalid ? LITERAL_INPUT_CLS_INVALID : LITERAL_INPUT_CLS_VALID;
}

/** Per-shape body input. Each branch commits through the matching
 *  builder so the literal's `data_type` qualifier survives every
 *  edit. */
function LiteralBodyInput({
	value,
	onChange,
	shape,
	nonEmpty,
	invalid,
}: {
	readonly value: Literal;
	readonly onChange: (next: Literal) => void;
	readonly shape: LiteralShape;
	readonly nonEmpty: boolean;
	readonly invalid: boolean;
}) {
	switch (shape) {
		case "text":
			return (
				<LiteralTextInput
					value={value}
					onChange={onChange}
					nonEmpty={nonEmpty}
					invalid={invalid}
				/>
			);
		case "number":
			return (
				<LiteralNumberInput
					value={value}
					onChange={onChange}
					invalid={invalid}
				/>
			);
		case "boolean":
			return (
				<LiteralBooleanToggle
					value={value}
					onChange={onChange}
					invalid={invalid}
				/>
			);
		case "null":
			return <LiteralNullChip />;
		case "date":
			return (
				<LiteralTypedDateInput
					value={value}
					onChange={(s) => onChange(dateLiteral(s))}
					inputType="date"
					nonEmpty={nonEmpty}
					invalid={invalid}
				/>
			);
		case "datetime":
			return (
				<LiteralTypedDateInput
					value={value}
					onChange={(s) => onChange(datetimeLiteral(s))}
					inputType="datetime-local"
					nonEmpty={nonEmpty}
					invalid={invalid}
				/>
			);
		case "time":
			return (
				<LiteralTypedDateInput
					value={value}
					onChange={(s) => onChange(timeLiteral(s))}
					inputType="time"
					nonEmpty={nonEmpty}
					invalid={invalid}
				/>
			);
	}
}

/** Text-typed literal input — commits on blur to avoid hammering
 *  the type checker on every keystroke. A required slot keeps an
 *  emptied draft in place and explains how to correct it; restoring
 *  the previous value would make the user's edit appear to vanish. */
function LiteralTextInput({
	value,
	onChange,
	nonEmpty,
	invalid,
}: {
	readonly value: Literal;
	readonly onChange: (next: Literal) => void;
	readonly nonEmpty: boolean;
	readonly invalid: boolean;
}) {
	const initial = typeof value.value === "string" ? value.value : "";
	const inputRef = useRef<HTMLInputElement>(null);
	const requiredErrorId = useId();
	const [draft, setDraft] = useState(initial);
	const [showRequiredError, setShowRequiredError] = useState(false);
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
			setShowRequiredError(false);
		}
	}, [initial, draft]);
	// Commit gating + qualifier preservation:
	//   - The no-op `draft === initial` short-circuit keeps a focus
	//     pulse on an untouched input from re-emitting the AST. The
	//     parent receives nothing, so the source reference flows
	//     through untouched.
	//   - A `nonEmpty` slot preserves an emptied draft with an inline
	//     correction rather than committing or silently restoring it.
	//   - On a real edit, `rebuildLiteralPreservingDataType` carries
	//     the source's `data_type` qualifier through. A literal
	//     declared `data_type: "single_select"` (or any non-temporal
	//     qualifier) stays declared after the edit; the bare
	//     `literal(draft)` rebuild would silently drop it.
	const commit = useCallback(() => {
		if (nonEmpty && draft === "") {
			setShowRequiredError(true);
			return;
		}
		setShowRequiredError(false);
		if (draft === initial) return;
		onChange(rebuildLiteralPreservingDataType(value, draft));
	}, [draft, initial, nonEmpty, onChange, value]);
	const effectiveInvalid = invalid || showRequiredError;
	return (
		<div>
			<Input
				ref={inputRef}
				type="text"
				value={draft}
				onChange={(event) => {
					const next = event.target.value;
					setDraft(next);
					if (showRequiredError && next !== "") {
						setShowRequiredError(false);
					}
				}}
				onBlur={commit}
				autoComplete="off"
				data-1p-ignore
				placeholder="Type a value"
				aria-label="Text value"
				aria-invalid={effectiveInvalid || undefined}
				aria-describedby={showRequiredError ? requiredErrorId : undefined}
				className={literalInputCls(effectiveInvalid)}
			/>
			{showRequiredError ? (
				<FieldError
					id={requiredErrorId}
					className="mt-2 text-[13px] leading-5 text-nova-rose"
				>
					Enter a value
				</FieldError>
			) : null}
		</div>
	);
}

/** Numeric literal input — commits on blur, accepting finite integers
 *  and decimals. Empty input commits a `literal(null)` so the type
 *  checker treats the slot as the absent-or-null compatibility case;
 *  malformed drafts remain visible with an inline correction. */
function LiteralNumberInput({
	value,
	onChange,
	invalid,
}: {
	readonly value: Literal;
	readonly onChange: (next: Literal) => void;
	readonly invalid: boolean;
}) {
	const initial = typeof value.value === "number" ? String(value.value) : "";
	const inputRef = useRef<HTMLInputElement>(null);
	const numberErrorId = useId();
	const [draft, setDraft] = useState(initial);
	const [showNumberError, setShowNumberError] = useState(false);
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
			setShowNumberError(false);
		}
	}, [initial, draft]);
	// Commit gating + qualifier preservation: same shape as
	// `LiteralTextInput`. The numeric input's no-op gate compares
	// the draft against the source's serialized form so a focus
	// pulse on an untouched input doesn't fire. Empty input emits a
	// `literal(null)` carrying the source's qualifier — the type
	// checker treats null as universally compatible per
	// `typesCompatible`'s `_any` rule.
	const commit = useCallback(() => {
		const trimmed = draft.trim();
		if (trimmed === "") {
			setShowNumberError(false);
			if (draft !== initial) {
				onChange(rebuildLiteralPreservingDataType(value, null));
			}
			return;
		}
		const parsed = finiteLiteralNumber(trimmed);
		if (parsed === undefined) {
			setShowNumberError(true);
			return;
		}
		setShowNumberError(false);
		if (draft === initial) return;
		onChange(rebuildLiteralPreservingDataType(value, parsed));
	}, [draft, initial, onChange, value]);
	const effectiveInvalid = invalid || showNumberError;
	return (
		<div>
			<Input
				ref={inputRef}
				type="text"
				inputMode="decimal"
				value={draft}
				onChange={(event) => {
					const next = event.target.value;
					setDraft(next);
					if (
						showNumberError &&
						(next.trim() === "" || finiteLiteralNumber(next) !== undefined)
					) {
						setShowNumberError(false);
					}
				}}
				onBlur={commit}
				autoComplete="off"
				data-1p-ignore
				aria-label="Number value"
				aria-invalid={effectiveInvalid || undefined}
				aria-describedby={showNumberError ? numberErrorId : undefined}
				className={literalInputCls(effectiveInvalid)}
			/>
			{showNumberError ? (
				<FieldError
					id={numberErrorId}
					className="mt-2 text-[13px] leading-5 text-nova-rose"
				>
					Enter a number
				</FieldError>
			) : null}
		</div>
	);
}

function finiteLiteralNumber(draft: string): number | undefined {
	if (draft.trim() === "") return undefined;
	const parsed = Number(draft);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Boolean literal toggle — segmented control showing both states
 *  with an active marker. Commits the boolean directly. */
function LiteralBooleanToggle({
	value,
	onChange,
	invalid,
}: {
	readonly value: Literal;
	readonly onChange: (next: Literal) => void;
	readonly invalid: boolean;
}) {
	const current = typeof value.value === "boolean" ? value.value : false;
	const baseCls = "h-11 flex-1 rounded-md text-sm";
	const activeCls = "text-nova-violet-bright bg-nova-violet/10";
	const idleCls =
		"text-nova-text-muted hover:text-nova-text hover:bg-white/[0.04]";
	const wrapCls = invalid
		? "flex gap-1 px-1 py-1 rounded-md border border-nova-rose/40 bg-nova-deep/50"
		: "flex gap-1 px-1 py-1 rounded-md border border-white/[0.06] bg-nova-deep/50";
	// `<fieldset>` carries the implicit "group of related controls" role
	// without a separate `role="group"` attribute — biome's
	// `useSemanticElements` rule prefers the semantic element. The
	// visible-label decoration uses `aria-label` rather than a
	// `<legend>` because the surrounding card already carries a
	// surrounding value-source label and a redundant legend would
	// add a structural heading the screen reader doesn't need.
	// Qualifier-preserving toggle: each button rebuilds via
	// `rebuildLiteralPreservingDataType` so a literal carrying a
	// `data_type` qualifier doesn't silently drop it on click. The
	// no-op gate (don't fire when the user clicks the already-active
	// state) matches the text / numeric inputs' commit-on-change
	// contract.
	return (
		<fieldset className={wrapCls} aria-label="Yes or no value">
			<Button
				type="button"
				variant="ghost"
				size="xl"
				onClick={() => {
					if (current) return;
					onChange(rebuildLiteralPreservingDataType(value, true));
				}}
				className={`${baseCls} ${current ? activeCls : idleCls}`}
				aria-pressed={current}
			>
				Yes
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="xl"
				onClick={() => {
					if (!current) return;
					onChange(rebuildLiteralPreservingDataType(value, false));
				}}
				className={`${baseCls} ${!current ? activeCls : idleCls}`}
				aria-pressed={!current}
			>
				No
			</Button>
		</fieldset>
	);
}

/** Null sentinel chip — non-editable, showing the literal resolves
 *  to null. The shape menu above flips back to a typed shape if the
 *  user wants a non-null value. */
function LiteralNullChip() {
	return (
		<div className="flex min-h-11 items-center rounded-lg border border-dashed border-white/[0.08] bg-nova-deep/30 px-3 text-[13px] text-nova-text-muted">
			<span>No value</span>
		</div>
	);
}

/** Native typed-date / typed-time / typed-datetime input. Browsers
 *  drive the picker UX; the wire form is the platform's ISO-
 *  formatted output, which matches CommCare's date / datetime
 *  conventions when truncated to seconds. Commits on change rather
 *  than blur — picker commits are atomic events, not in-flight
 *  edits. Same shape `LiteralValueInput`'s `DateInput` uses.
 *
 *  A required slot keeps a cleared picker visible with a correction
 *  instead of snapping back to the previous date or time. */
function LiteralTypedDateInput({
	value,
	onChange,
	inputType,
	nonEmpty,
	invalid,
}: {
	readonly value: Literal;
	readonly onChange: (wireValue: string) => void;
	readonly inputType: "date" | "datetime-local" | "time";
	readonly nonEmpty: boolean;
	readonly invalid: boolean;
}) {
	const initial = typeof value.value === "string" ? value.value : "";
	const inputRef = useRef<HTMLInputElement>(null);
	const requiredErrorId = useId();
	const [draft, setDraft] = useState(initial);
	const [showRequiredError, setShowRequiredError] = useState(false);
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
			setShowRequiredError(false);
		}
	}, [draft, initial]);
	const effectiveInvalid = invalid || showRequiredError;
	return (
		<div>
			<Input
				ref={inputRef}
				type={inputType}
				value={draft}
				required={nonEmpty}
				onChange={(event) => {
					const next = event.target.value;
					setDraft(next);
					if (
						!event.currentTarget.validity.valid ||
						(nonEmpty && next === "")
					) {
						setShowRequiredError(true);
						return;
					}
					setShowRequiredError(false);
					onChange(next);
				}}
				onBlur={() => {
					if (!inputRef.current?.validity.valid || (nonEmpty && draft === "")) {
						setShowRequiredError(true);
					}
				}}
				autoComplete="off"
				data-1p-ignore
				aria-label={
					inputType === "datetime-local"
						? "Date and time value"
						: inputType === "date"
							? "Date value"
							: "Time value"
				}
				aria-invalid={effectiveInvalid || undefined}
				aria-describedby={showRequiredError ? requiredErrorId : undefined}
				className={literalInputCls(effectiveInvalid)}
			/>
			{showRequiredError ? (
				<FieldError
					id={requiredErrorId}
					className="mt-2 text-[13px] leading-5 text-nova-rose"
				>
					Enter a value
				</FieldError>
			) : null}
		</div>
	);
}

function userFieldIsValid(value: string): boolean {
	return XML_ELEMENT_NAME_PATTERN.test(value);
}

function userFieldError(value: string): string {
	return value.length === 0
		? "Enter a user field name"
		: "Start with a letter or underscore, then use only letters, numbers, and underscores";
}

function userFieldInputClass(invalid: boolean): string {
	return [
		"h-auto min-h-11 w-full rounded-lg border bg-nova-deep/50 px-3 text-sm text-nova-text md:text-sm dark:bg-nova-deep/50",
		invalid
			? "border-nova-rose/40 focus-visible:border-nova-rose/60 focus-visible:ring-nova-rose/30"
			: "border-white/[0.06] focus-visible:border-nova-violet/40 focus-visible:ring-nova-violet/30",
	].join(" ");
}

/** Open-namespace user-data field input. The namespace is open, but the wire
 * path still requires an XML-safe element name. Keep incomplete or malformed
 * typing local and commit only a schema-valid field, so deleting or correcting
 * the name can never send an invalid autosave mutation. */
function UserFieldInput({
	value,
	onChange,
	invalid,
}: {
	readonly value: string;
	readonly onChange: (field: string) => void;
	readonly invalid: boolean;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const helpId = useId();
	const [draft, setDraft] = useState(value);
	const [showDraftError, setShowDraftError] = useState(false);
	useEffect(() => {
		if (value !== draft && document.activeElement !== inputRef.current) {
			setDraft(value);
			setShowDraftError(false);
		}
	}, [draft, value]);
	const commit = () => {
		if (!userFieldIsValid(draft)) {
			setShowDraftError(true);
			return;
		}
		setShowDraftError(false);
		if (draft !== value) onChange(draft);
	};
	const effectiveInvalid = invalid || showDraftError;
	return (
		<div>
			<Input
				ref={inputRef}
				type="text"
				value={draft}
				onChange={(event) => {
					const next = event.target.value;
					setDraft(next);
					if (showDraftError && userFieldIsValid(next)) {
						setShowDraftError(false);
					}
				}}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key !== "Enter") return;
					event.preventDefault();
					commit();
				}}
				autoComplete="off"
				data-1p-ignore
				aria-label="User information field"
				aria-invalid={effectiveInvalid || undefined}
				aria-describedby={helpId}
				className={userFieldInputClass(effectiveInvalid)}
			/>
			{showDraftError ? (
				<FieldError
					id={helpId}
					className="mt-2 text-[13px] leading-5 text-nova-rose"
				>
					{userFieldError(draft)}
				</FieldError>
			) : (
				<p
					id={helpId}
					className="mt-2 text-[13px] leading-5 text-nova-text-secondary"
				>
					Use the field name saved on the user, like assigned_region
				</p>
			)}
		</div>
	);
}
