// components/builder/shared/cards/expression/TermCard.tsx
//
// Term-arm card for the ValueExpression editor: the universal value
// carrier. Edits the six authorable Term variants:
//
//   - `prop`: case property reference (with optional `via:
//     RelationPath` walk preserved across edits via the shared
//     `PropertyRefPicker`).
//   - `input`: search-input ref (named picker over declared inputs).
//   - `session-context`: closed-namespace session field (`userid` /
//     `username` / `deviceid` / `appversion`).
//   - `session-user-property`: a custom worker-information property by
//     stable UUID (its current slug is resolved only for display/wire output).
//   - `session-user`: an explicit raw built-in/external user-data field.
//   - `field`: stable form-field identity. Offered as a real source only
//     where the edit context supplies `formFields` (today, a case
//     operation); every other context rejects it.
//   - `literal`: primitive constant (string / number / boolean /
//     null) with optional `data_type` qualifier preserved on rebuild.
//   - `table-column`: stable lookup-column identity. Offered only in an
//     explicit table-row scope whose table/column catalog admits it.
//
// The card edits ONLY Term-shaped values: non-Term ValueExpression
// arms route through their own dedicated cards (ArithCard / IfCard /
// etc.) at the `ExpressionPicker` shell's registry-driven dispatch.
//
// Valid by construction: the card takes the slot's `SlotConstraint`
// and gates every value source against it: a source that can't
// produce an accepted type is disabled WITH A REASON (never dimmed),
// the property / search-input dropdowns filter to admissible entries,
// and the literal shape menu offers only shapes whose value type the
// slot accepts. A `nonEmpty` slot refuses to commit an empty literal.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerForms from "@iconify-icons/tabler/forms";
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
	AlertDialogBody,
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
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { FieldError } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	asUuid,
	type CasePropertyDataType,
	type UserProperty,
	type Uuid,
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
	reasonFor,
	SESSION_USER_FIELD_PATTERN,
	type SlotConstraint,
	sessionContext,
	sessionUser,
	sessionUserProperty,
	type Term,
	tableColumn,
	timeLiteral,
	type ValueExpression,
	term as wrapTerm,
} from "@/lib/domain/predicate";
import {
	type AdmitExpressionChange,
	useEditorErrorsAt,
	useEditorErrorsBelow,
	useExpressionFocusTarget,
	usePredicateEditContext,
} from "../../editorContext";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import {
	formFieldDisambiguator,
	formFieldDisplayLabel,
} from "../../formFieldPresentation";
import { rebuildLiteralPreservingDataType } from "../../literalRebuild";
import { lookupColumnDisplayLabel } from "../../lookupTablePresentation";
import type { EditorPath } from "../../path";
import { InlineError } from "../../primitives/CardShell";
import { PropertyRefPicker } from "../../primitives/PropertyRefPicker";
import { searchInputDisplayLabel } from "../../searchInputPresentation";
import {
	buildLiteralForShape,
	buildTermDefault,
	classifyLiteralShape,
	computeModeAdmission,
	constraintAdmitsType,
	describeLiteralShapeReplacement,
	describeTermModeReplacement,
	LITERAL_SHAPE_LABELS,
	LITERAL_SHAPE_TYPE,
	type LiteralShape,
	literalHasMeaningfulContent,
	literalsMatch,
	type ModeAdmission,
	propertyFilterFor,
	type TermMode,
	termHasMeaningfulContent,
	termMode,
	termModeLabel,
	termsMatch,
} from "../../termEditorModel";

export { termHasMeaningfulContent } from "../../termEditorModel";

import { finiteLiteralDraft, planLiteralDraft } from "../../literalDraft";

/** Default Term-arm value: a `term(literal(""))`. The empty literal
 *  renders the typed text input directly; authors who want a different
 *  Term variant flip the mode menu. */
export function termDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "term" }> {
	return wrapTerm(literal(""));
}

/** Term mode discriminator: one per Term arm. Drives the mode menu
 *  in the card's body. */
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
	/** The slot's type constraint: gates the value sources and the
	 *  literal shape menu. Defaults to `ANY_CONSTRAINT`. */
	readonly constraint?: SlotConstraint;
	/** Copy context for the source menu. A predicate's left side is the
	 *  condition subject, so its property source reads "Case information";
	 *  ordinary value slots read "Other case information". The editor and AST
	 *  behavior are identical. */
	readonly sourceContext?: "value" | "subject";
	/** Extra entries the picker shell injects into the source menu:
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
 * to `resolveTermType(...)` with the path UNCHANGED: Term-resolution
 * errors land at the slot path, not at `[..., "term"]`. The card
 * therefore looks up errors at its own path, not at a deeper
 * sub-segment.
 */
export function TermCard(props: TermCardProps) {
	return <EditableTermCard {...props} />;
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
	// Term-side error rendering: two sources:
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
	const userProperties = ctx.userProperties;
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
				next === "session-user" ? userFieldForTerm(savedTarget) : undefined;
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
						userProperties={userProperties}
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
					<AlertDialogBody>
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
									aria-invalid={
										pendingUserFieldError !== undefined || undefined
									}
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
					</AlertDialogBody>
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
											? userFieldTerm(pendingModeChange.userFieldDraft)
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
		if (mode === "field" || ctx.formFields.length > 0) {
			base.push({
				mode: "field",
				label: termModeLabel("field", sourceContext),
				icon: tablerForms,
			});
		}
		if (mode === "input" || ctx.knownInputs.length > 0) {
			base.push({
				mode: "input",
				label: termModeLabel("input", sourceContext),
				icon: tablerSwitch,
			});
		}
		if (mode === "table-column" || ctx.tableScope !== undefined) {
			base.push({
				mode: "table-column",
				label: termModeLabel("table-column", sourceContext),
				icon: tablerDatabase,
			});
		}
		base.push({
			mode: "session-context",
			label: termModeLabel("session-context", sourceContext),
			icon: tablerUser,
		});
		base.push({
			mode: "session-user-property",
			label: termModeLabel("session-user-property", sourceContext),
			icon: tablerSparkles,
		});
		base.push({
			mode: "session-user",
			label: termModeLabel("session-user", sourceContext),
			icon: tablerUser,
		});
		return base;
	}, [
		ctx.formFields.length,
		ctx.knownInputs,
		ctx.tableScope,
		mode,
		sourceContext,
	]);

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
						variant="field"
						className="group justify-start"
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
						<DropdownMenuRadioGroup
							value={mode}
							onValueChange={(next) => setMode(next as TermMode)}
						>
							{items.map((item) => {
								const isActive = item.mode === mode;
								const verdict = admission[item.mode];
								const admitted = verdict.admitted;
								const hasReason = !admitted && verdict.reason !== undefined;
								return (
									<DropdownMenuRadioItem
										key={item.mode}
										value={item.mode}
										disabled={!admitted}
										closeOnClick
										className={
											isActive
												? "bg-nova-violet/10 text-nova-violet-bright"
												: ""
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
											<span className="block break-words">{item.label}</span>
											{hasReason && (
												<span className="block break-words text-xs text-nova-text-muted">
													{verdict.reason}
												</span>
											)}
										</span>
									</DropdownMenuRadioItem>
								);
							})}
						</DropdownMenuRadioGroup>
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
	readonly userProperties: readonly UserProperty[];
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
	userProperties,
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
			// via)` (three-arg form): bypassing this primitive would
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
				<FormFieldRefMenu
					value={term.uuid}
					onChange={(uuid) => onChange(formField(uuid))}
					constraint={constraint}
					invalid={invalid}
				/>
			);
		case "input":
			return (
				<InputRefMenu
					value={term.searchInputUuid}
					onChange={(uuid) => onChange(input(uuid))}
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
					onChange={(field) => onChange(userFieldTerm(field))}
					invalid={invalid}
				/>
			);
		case "session-user-property": {
			const property = userProperties.find(
				(candidate) => candidate.uuid === term.userPropertyUuid,
			);
			if (property === undefined) {
				return (
					<div
						role="alert"
						className="rounded-lg border border-nova-rose/30 bg-nova-rose/[0.05] px-3 py-2.5"
					>
						<p className="text-sm font-medium text-nova-rose">
							Worker information unavailable
						</p>
						<p className="mt-1 text-[13px] leading-5 text-nova-text-secondary">
							This value refers to worker information that is no longer in the
							app. Choose another value source.
						</p>
					</div>
				);
			}
			return (
				<UserPropertyMenu
					value={property.uuid}
					properties={userProperties}
					onChange={(uuid) => onChange(sessionUserProperty(uuid))}
					invalid={invalid}
				/>
			);
		}
		case "table-column":
			return (
				<TableColumnRefMenu
					value={term}
					onChange={onChange}
					constraint={constraint}
					invalid={invalid}
				/>
			);
	}
}

interface TableColumnRefMenuProps {
	readonly value: Extract<Term, { kind: "table-column" }>;
	readonly onChange: (next: Term) => void;
	readonly constraint: SlotConstraint;
	readonly invalid: boolean;
}

function TableColumnRefMenu({
	value,
	onChange,
	constraint,
	invalid,
}: TableColumnRefMenuProps) {
	const ctx = usePredicateEditContext();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const scope = ctx.tableScope;
	const current =
		scope?.tableId === value.tableId
			? scope.columns.find((column) => column.id === value.columnId)
			: undefined;
	const items = (scope?.columns ?? []).filter(
		(column) =>
			constraint.accepts === "any" || acceptsType(constraint, column.dataType),
	);
	const missing = current === undefined;
	const label =
		current === undefined
			? "A column that is no longer available"
			: lookupColumnDisplayLabel(current);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				aria-label={`Data table column: ${label}${missing ? ", no longer available" : ""}`}
				/* A column that no longer exists is an invalid value in this
				 * control, the same as one the checker refused, and the button
				 * draws that state itself. */
				aria-invalid={invalid || missing || undefined}
				render={
					<Button type="button" variant="field" className="group w-full" />
				}
			>
				<span className="min-w-0 flex-1 text-left">
					<span className="block break-words">{label}</span>
					{current !== undefined &&
					current.label.trim() !== current.wireName ? (
						<span className="block break-words text-xs text-nova-text-muted">
							{current.wireName}
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
						{missing ? (
							<div
								className="border-b border-white/[0.06] px-3 py-2.5 text-[13px] leading-5 text-nova-text-secondary"
								role="presentation"
							>
								Choose another column from this table to repair the rule.
							</div>
						) : null}
						{items.map((column) => (
							<DropdownMenuItem
								key={column.id}
								onClick={() => {
									if (scope === undefined) return;
									onChange(tableColumn(scope.tableId, column.id));
								}}
								className={
									column.id === value.columnId
										? "bg-nova-violet/10 text-nova-violet-bright"
										: ""
								}
							>
								<span className="min-w-0 flex-1">
									<span className="block break-words">
										{lookupColumnDisplayLabel(column)}
									</span>
									<span className="block break-words text-xs text-nova-text-muted">
										{column.wireName}
									</span>
								</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}

interface InputRefMenuProps {
	readonly value: Uuid | undefined;
	readonly onChange: (uuid: Uuid) => void;
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

/** Search-input dropdown: picks from declared search inputs in
 *  scope whose declared type the slot accepts. An unresolved identity is
 *  shown only as an ephemeral repair state and is never re-admitted. */
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
					constraint.accepts === "any" ||
					acceptsType(constraint, i.data_type ?? "text"),
			),
		[ctx.knownInputs, constraint],
	);
	const current = items.find((i) => i.uuid === value);
	const hasSavedValue = value !== undefined;
	const currentMissing = hasSavedValue && current === undefined;
	const currentLabel =
		current !== undefined
			? searchInputDisplayLabel(current.uuid, ctx.knownInputs)
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
					<Button type="button" variant="outline" className={triggerClass} />
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
							const isActive = it.uuid === value;
							return (
								<DropdownMenuItem
									key={it.uuid}
									onClick={() => onChange(it.uuid)}
									className={
										isActive ? "bg-nova-violet/10 text-nova-violet-bright" : ""
									}
								>
									<span className="min-w-0 flex-1 break-words">
										{searchInputDisplayLabel(it.uuid, ctx.knownInputs)}
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

/**
 * Form-answer dropdown. The context's decl list IS the admission list:
 * the mounting surface has already dropped every answer this slot may
 * not read, so this menu only narrows further by the slot's own type.
 *
 * A saved answer that has since been deleted keeps its identity visible
 * with a recovery line rather than collapsing to an empty placeholder:
 * the reference is what the author wrote, and silently blanking it would
 * hide the repair.
 */
function FormFieldRefMenu({
	value,
	onChange,
	constraint,
	invalid,
}: {
	readonly value: Uuid;
	readonly onChange: (uuid: Uuid) => void;
	readonly constraint: SlotConstraint;
	readonly invalid: boolean;
}) {
	const ctx = usePredicateEditContext();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const items = useMemo(
		() =>
			ctx.formFields.filter(
				(field) =>
					constraint.accepts === "any" ||
					acceptsType(constraint, field.dataType ?? "text"),
			),
		[ctx.formFields, constraint],
	);
	const current = items.find((field) => field.uuid === value);
	const currentLabel =
		current === undefined
			? undefined
			: formFieldDisplayLabel(current.uuid, ctx.formFields);
	const missing = current === undefined;
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
				aria-label={`Form answer: ${currentLabel ?? "Choose a form answer"}${missing ? ", no longer in this form" : ""}`}
				aria-invalid={invalid || undefined}
				render={
					<Button type="button" variant="outline" className={triggerClass} />
				}
			>
				<span className="min-w-0 flex-1 text-left">
					<span className="block break-words text-nova-violet-bright">
						{currentLabel ?? "Choose a form answer"}
					</span>
					{missing ? (
						<span className="block text-xs font-normal text-nova-rose">
							No longer in this form
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
						{missing ? (
							<div
								className={
									items.length > 0
										? "border-b border-white/[0.06] px-3 py-2.5"
										: "px-3 py-2.5"
								}
								role="presentation"
							>
								<div className="break-words text-sm font-medium text-nova-text">
									That answer is no longer in this form
								</div>
								<div className="mt-1 text-[13px] leading-5 text-nova-text-secondary">
									{items.length > 0
										? "Choose another answer below, or add the question back"
										: "Choose another value source, or add the question back"}
								</div>
							</div>
						) : items.length === 0 ? (
							<div
								className="px-3 py-2.5 text-[13px] leading-5 text-nova-text-secondary"
								role="presentation"
							>
								No form answers fit here. Choose another value source.
							</div>
						) : null}
						{items.map((field) => {
							const isActive = field.uuid === value;
							const disambiguator = formFieldDisambiguator(
								field,
								ctx.formFields,
							);
							return (
								<DropdownMenuItem
									key={field.uuid}
									onClick={() => onChange(field.uuid)}
									className={
										isActive ? "bg-nova-violet/10 text-nova-violet-bright" : ""
									}
								>
									<span className="min-w-0 flex-1 break-words">
										<span className="block">
											{formFieldDisplayLabel(field.uuid, ctx.formFields)}
										</span>
										{disambiguator !== undefined && (
											<span className="block text-xs text-nova-text-muted">
												{disambiguator}
											</span>
										)}
									</span>
									{field.dataType !== undefined && (
										<span className="text-xs text-nova-text-muted">
											{SEARCH_ANSWER_TYPE_LABELS[field.dataType]}
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
					<Button type="button" variant="outline" className={triggerClass} />
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

interface LiteralDraft {
	readonly value: Literal;
	readonly authored: boolean;
}

interface PendingLiteralShapeChange {
	readonly source: Literal;
	readonly targetShape: LiteralShape;
}

/** Literal types are progressive options inside the existing value-source
 * menu. The ordinary comparison path therefore renders one inferred input,
 * while explicitly authored advanced literal shapes remain fully editable. */
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
						const admitted = constraintAdmitsType(
							constraint,
							LITERAL_SHAPE_TYPE[s],
						);
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
	"nova-focusable h-auto min-h-11 w-full rounded-lg border border-white/[0.06] bg-nova-deep/50 px-3 text-sm text-nova-text placeholder:text-nova-text-muted md:text-sm dark:bg-nova-deep/50";
const LITERAL_INPUT_CLS_INVALID =
	"nova-focusable h-auto min-h-11 w-full rounded-lg border border-nova-rose/40 bg-nova-deep/50 px-3 text-sm text-nova-text placeholder:text-nova-text-muted md:text-sm dark:bg-nova-deep/50";

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

/** Text-typed literal input: commits on blur to avoid hammering
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
		const plan = planLiteralDraft({ value, draft, kind: "text", nonEmpty });
		setShowRequiredError(plan.kind === "rejected");
		if (plan.kind === "commit") onChange(plan.value);
	}, [draft, nonEmpty, onChange, value]);
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

/** Numeric literal input: commits on blur, accepting finite integers
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
	// `literal(null)` carrying the source's qualifier: the type
	// checker treats null as universally compatible per
	// `typesCompatible`'s `_any` rule.
	const commit = useCallback(() => {
		const plan = planLiteralDraft({ value, draft, kind: "decimal" });
		setShowNumberError(plan.kind === "rejected");
		if (plan.kind === "commit") onChange(plan.value);
	}, [draft, onChange, value]);
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
						(next.trim() === "" || finiteLiteralDraft(next) !== undefined)
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

/** Boolean literal toggle: segmented control showing both states
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
	// without a separate `role="group"` attribute: biome's
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

/** Null sentinel chip: non-editable, showing the literal resolves
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
 *  than blur: picker commits are atomic events, not in-flight
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
	return SESSION_USER_FIELD_PATTERN.test(value);
}

function userFieldForTerm(term: Term | undefined): string {
	if (term?.kind === "session-user") return term.field;
	return "";
}

/**
 * The raw source is an explicit promise to preserve the authored name. Custom
 * worker information is selected through `UserPropertyMenu` and never inferred
 * from text, so a raw field remains raw even when its spelling happens to equal
 * a current custom slug.
 */
function userFieldTerm(field: string): Term {
	return sessionUser(field);
}

function userFieldError(value: string): string {
	return value.length === 0
		? "Enter a user field name"
		: "Start with a letter or underscore, then use only letters, numbers, underscores, and hyphens";
}

function userFieldInputClass(invalid: boolean): string {
	return [
		"h-auto min-h-11 w-full rounded-lg border bg-nova-deep/50 px-3 text-sm text-nova-text md:text-sm dark:bg-nova-deep/50",
		invalid
			? "nova-focusable border-nova-rose/40"
			: "nova-focusable border-white/[0.06]",
	].join(" ");
}

/**
 * Identity-backed custom worker-information picker. The control submits only
 * the stable UUID; label and slug are live catalog projections, so a peer
 * rename updates this row without rewriting the expression.
 */
function UserPropertyMenu({
	value,
	properties,
	onChange,
	invalid,
}: {
	readonly value: UserProperty["uuid"];
	readonly properties: readonly UserProperty[];
	readonly onChange: (uuid: UserProperty["uuid"]) => void;
	readonly invalid: boolean;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const current = properties.find((property) => property.uuid === value);
	if (current === undefined) {
		throw new Error(
			"UserPropertyMenu requires the selected worker-information identity.",
		);
	}
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
				aria-label={`Worker information: ${current.label}, ${current.slug}`}
				aria-invalid={invalid || undefined}
				render={
					<Button type="button" variant="outline" className={triggerClass} />
				}
			>
				<span className="min-w-0 flex-1 text-left">
					<span className="block break-words text-nova-violet-bright">
						{current.label}
					</span>
					<span className="block break-words font-mono text-xs font-normal text-nova-text-muted">
						{current.slug}
					</span>
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
						<DropdownMenuRadioGroup
							value={value}
							onValueChange={(next) => onChange(asUuid(next))}
						>
							{properties.map((property) => {
								const isActive = property.uuid === value;
								return (
									<DropdownMenuRadioItem
										key={property.uuid}
										value={property.uuid}
										closeOnClick
										className={
											isActive
												? "bg-nova-violet/10 text-nova-violet-bright"
												: ""
										}
									>
										<span className="min-w-0 flex-1 break-words">
											{property.label}
										</span>
										<span className="break-words font-mono text-xs text-nova-text-muted">
											{property.slug}
										</span>
									</DropdownMenuRadioItem>
								);
							})}
						</DropdownMenuRadioGroup>
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
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
