// components/builder/case-list-config/inspector/SearchInputEditor.tsx
//
// Inspector body for one search field. ONE view serves every author:
// Label → what it searches → how the field looks → how it matches →
// what it starts with. The internal reference name is still available
// behind one quiet Advanced disclosure; storage vocabulary should not
// compete with the worker-facing choices in the normal flow. Writing a
// custom condition remains the last choice in the Match picker. The rail
// summarizes it and opens the center workbench; picking any standard match
// brings the standard controls back here.
//
// Under the hood the schema still splits into two arms (`simple`
// carries `(property, mode, via)`; `advanced` carries a predicate
// AST), but that split is storage shape, not UI shape. The Match
// picker is the only place the two arms meet:
//
//   - picking "Custom condition" converts to the advanced arm,
//     seeds `property = typed value`, and opens the center workbench so the
//     author edits the behavior they already had;
//   - picking a standard match converts back, recovering the
//     property the condition was anchored on when it still has the
//     round-trip shape.
//
// Inline diagnostics (empty / duplicate names, empty labels, unbound
// or dangling properties, type-coupling mismatches) come from the
// shared `searchInputResolution` derivation: the same source the
// search canvas's error badges and the workspace's preview gate
// read, so the three surfaces can't disagree.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerExclamationCircle from "@iconify-icons/tabler/exclamation-circle";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerWand from "@iconify-icons/tabler/wand";
import { type RefObject, useMemo, useRef, useState } from "react";
import {
	type SearchableChoice,
	SearchableChoiceCombobox,
} from "@/components/builder/case-list-config/SearchableChoiceCombobox";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import {
	buildValidityIndex,
	PredicateEditProvider,
} from "@/components/builder/shared/editorContext";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { InlineError } from "@/components/builder/shared/primitives/CardShell";
import {
	friendlyPropertyDisambiguator,
	propertyDisplayLabel,
	propertyDisplayLabelForName,
	propertyFallbackDisplayLabel,
	propertyTypeLabel,
} from "@/components/builder/shared/primitives/propertyDisplay";
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
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import {
	advancedSearchInputDef,
	applicableSearchModes,
	type CaseProperty,
	type CasePropertyDataType,
	type CaseType,
	DEFAULT_SEARCH_MODE_KIND,
	effectiveDataType,
	SEARCH_INPUT_TYPE_PROPERTY_TYPES,
	SEARCH_INPUT_TYPES,
	SEARCH_MODE_PROPERTY_TYPES,
	type SearchInputDef,
	type SearchInputMode,
	type SearchInputType,
	type SimpleSearchInputDef,
	searchInputDefault,
	simpleSearchInputDef,
	type UserProperty,
} from "@/lib/domain";
import {
	acceptsType,
	ancestorPath,
	checkExpression,
	type RelationPath,
	relationStep,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { DISCLOSURE_ROW_CLS } from "@/lib/styles";
import { summarizeFilter } from "../predicateSummary";
import {
	buildMode,
	canSeedCustomConditionFaithfully,
	constraintForDefault,
	effectiveModeKind,
	NO_SEARCH_INPUTS,
	type PropertyState,
	type ResolvedRow,
	recoverAnchoredProperty,
	resolveDestinationCaseType,
	resolveProperty,
	resolveRows,
	type ScalarDefaultSearchInputType,
	SEARCH_INPUT_TYPE_DESCRIPTIONS,
	SEARCH_INPUT_TYPE_ICONS,
	SEARCH_INPUT_TYPE_LABELS,
	SEARCH_MODE_DESCRIPTIONS,
	SEARCH_MODE_LABELS,
	searchInputDecls,
	seedCustomCondition,
	seedDefaultExpression,
} from "../searchInputResolution";
import {
	labelFromProperty,
	pickSeedProperty,
	uniqueInputName,
	widgetTypeForProperty,
	xmlNameFromProperty,
} from "../seeds";

// ── Public types ──────────────────────────────────────────────────

export interface SearchInputEditorProps {
	/** The input being edited. Must be a member of `siblings`. */
	readonly value: SearchInputDef;
	/** Position of `value` within `siblings`: drives the duplicate-
	 *  name diagnostic and aria labels. */
	readonly index: number;
	/** The full search-input list. Sibling names feed the duplicate
	 *  check and the `input(...)` references the inner editors may
	 *  resolve. */
	readonly siblings: readonly SearchInputDef[];
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly userProperties?: readonly UserProperty[];
	readonly onChange: (next: SearchInputDef) => void;
	/** Opens this field's custom condition in the center-canvas workbench. */
	readonly onEditCondition: () => void;
}

/** Where a simple row's property lives: this case, the parent case,
 *  or a non-canonical relation walk authored elsewhere (chat, MCP). */
type BindingScope = "self" | "parent" | "custom";

type TransitionFocus = "binding" | "type" | "match";

interface PendingInputTransition {
	readonly source: SearchInputDef;
	readonly next: SearchInputDef;
	readonly focus: TransitionFocus;
	readonly title: string;
	readonly description: string;
}

interface PendingStandardReplacement {
	readonly source: SearchInputDef;
	readonly next: SimpleSearchInputDef;
	readonly resultingMode: SearchInputMode["kind"];
	readonly modeAdjustment?: string;
	readonly meaningfulDefaultRemoved: boolean;
}

const PICKER_TRIGGER_CLS =
	"nova-focusable flex h-auto min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg border border-white/[0.08] bg-nova-deep/30 px-3 py-2 text-[14px] text-nova-text-secondary whitespace-normal transition-colors outline-none not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-violet/[0.04]";

function classifyVia(via: RelationPath | undefined): BindingScope {
	if (via === undefined || via.kind === "self") return "self";
	if (
		via.kind === "ancestor" &&
		via.via.length === 1 &&
		via.via[0].throughCaseType === undefined
	) {
		return "parent";
	}
	return "custom";
}

/**
 * Inspector body for one search field. Every control labeled, every
 * target full-size, one view for all authors.
 */
export function SearchInputEditor({
	value,
	index,
	siblings,
	caseTypes,
	currentCaseType,
	userProperties = [],
	onChange,
	onEditCondition,
}: SearchInputEditorProps) {
	const [pendingStandardReplacement, setPendingStandardReplacement] =
		useState<PendingStandardReplacement | null>(null);
	const [pendingInputTransition, setPendingInputTransition] =
		useState<PendingInputTransition | null>(null);
	const [pendingCustomConversion, setPendingCustomConversion] =
		useState<SimpleSearchInputDef | null>(null);
	const bindingTriggerRef = useRef<HTMLButtonElement>(null);
	const typeTriggerRef = useRef<HTMLButtonElement>(null);
	const matchTriggerRef = useRef<HTMLButtonElement>(null);
	const projectProse = useProseProjection();
	const transitionFocusRef = useRef<TransitionFocus>("type");
	const resolved: ResolvedRow = useMemo(() => {
		const rows = resolveRows(
			siblings,
			caseTypes,
			currentCaseType,
			projectProse,
		);
		return (
			rows[index] ?? {
				nameState: { kind: "ok" } as const,
				labelEmpty: value.label === "",
				propertyState: { kind: "ok" } as const,
				typeCouplingErrors: [] as readonly string[],
			}
		);
	}, [siblings, index, caseTypes, currentCaseType, projectProse, value.label]);

	// Every named row is in scope: the edited row included. A custom
	// condition is keyed to its OWN input via the when-input-present
	// envelope `seedCustomCondition` produces, so the row must resolve
	// its own `input(name)`. Matches the validator's full-list
	// `moduleTypeContext`; see `searchInputDecls`.
	const knownInputs = useMemo(() => searchInputDecls(siblings), [siblings]);

	// ── Common-slot mutators ──

	const setName = (name: string) => onChange(rebuildRow(value, { name }));
	const setLabel = (label: string) => onChange(rebuildRow(value, { label }));
	const requestInputTransition = (
		next: SearchInputDef,
		focus: TransitionFocus,
		targetDescription: string,
	) => {
		if (searchInputsMatch(value, next)) return;
		const currentDefault = searchInputDefault(value);
		const nextDefault = searchInputDefault(next);
		const modeChanged =
			value.kind === "simple" &&
			next.kind === "simple" &&
			value.mode !== undefined &&
			!searchModesMatch(value.mode, next.mode);
		const meaningfulDefaultRemoved =
			currentDefault !== undefined &&
			nextDefault === undefined &&
			expressionHasMeaningfulContent(currentDefault);
		if (!modeChanged && !meaningfulDefaultRemoved) {
			onChange(next);
			return;
		}
		transitionFocusRef.current = focus;

		const consequences: string[] = [];
		if (modeChanged && value.kind === "simple" && next.kind === "simple") {
			consequences.push(
				`“${searchModeDescription(value.mode, value.type)}” will become “${searchModeDescription(next.mode, next.type)}”.`,
			);
		}
		if (meaningfulDefaultRemoved) {
			consequences.push(
				`The starting value will be removed because ${targetDescription} can't use it.`,
			);
		}
		consequences.push("You can undo this change.");
		setPendingInputTransition({
			source: value,
			next,
			focus,
			title: `Change to “${targetDescription}”?`,
			description: consequences.join(" "),
		});
	};

	const setType = (type: SearchInputType) => {
		if (type === value.type) return;
		const keepMode =
			value.kind !== "simple" ||
			value.mode === undefined ||
			applicableSearchModes(type).includes(value.mode.kind);
		const currentDefault = searchInputDefault(value);
		const keepDefault =
			currentDefault === undefined ||
			defaultFitsInputType(currentDefault, type, caseTypes, currentCaseType);
		const next = rebuildRow(value, {
			type,
			...(keepMode ? {} : { mode: undefined }),
			...(keepDefault ? {} : { default: undefined }),
		});
		requestInputTransition(next, "type", SEARCH_INPUT_TYPE_LABELS[type]);
	};
	const setDefault = (next: ValueExpression | undefined) =>
		onChange(rebuildRow(value, { default: next }));

	// ── Simple-arm mutators ──

	/**
	 * Bind the row to `(property, scope)` in one write. The rest of
	 * the row follows the property: a widget the property can't run
	 * (a calendar over a text property, say) self-corrects to one it
	 * can, an inadmissible match drops back to the type's default,
	 * and the label / name update only while they still read as
	 * derived from the previous property: hand-typed values are the
	 * author's and are never overwritten.
	 */
	const setBinding = (property: string, scope: "self" | "parent") => {
		if (value.kind !== "simple") return;
		const via: RelationPath | undefined =
			scope === "self"
				? undefined
				: classifyVia(value.via) === "parent"
					? value.via
					: ancestorPath(relationStep("parent"));

		const patch: {
			property: string;
			via: RelationPath | undefined;
			type?: SearchInputType;
			mode?: SearchInputMode | undefined;
			default?: ValueExpression | undefined;
			label?: string;
			name?: string;
		} = { property, via };
		let nextType = value.type;

		const destination = resolveDestinationCaseType(
			caseTypes,
			via,
			currentCaseType,
		);
		const propertyDef = (
			caseTypes.find((c) => c.name === destination)?.properties ?? []
		).find((p) => p.name === property);
		if (propertyDef !== undefined) {
			const dataType = effectiveDataType(propertyDef);
			const typeAllowed =
				SEARCH_INPUT_TYPE_PROPERTY_TYPES[value.type]?.includes(dataType) ??
				true;
			nextType = typeAllowed ? value.type : widgetTypeForProperty(propertyDef);
			if (nextType !== value.type) patch.type = nextType;
			const modeAllowed =
				value.mode === undefined ||
				(applicableSearchModes(nextType).includes(value.mode.kind) &&
					(SEARCH_MODE_PROPERTY_TYPES[value.mode.kind]?.includes(dataType) ??
						true));
			if (!modeAllowed) {
				const fuzzyAdmitted =
					SEARCH_MODE_PROPERTY_TYPES.fuzzy?.includes(dataType) ?? true;
				patch.mode =
					nextType === "text" && fuzzyAdmitted ? buildMode("fuzzy") : undefined;
			}
		}
		const currentDefault = searchInputDefault(value);
		if (
			currentDefault !== undefined &&
			!defaultFitsInputType(
				currentDefault,
				nextType,
				caseTypes,
				currentCaseType,
			)
		) {
			patch.default = undefined;
		}

		if (
			value.label === "" ||
			value.label === labelFromProperty(value.property)
		) {
			patch.label =
				propertyDef !== undefined
					? propertyDisplayLabel(propertyDef, projectProse)
					: labelFromProperty(property);
		}
		const oldBase = xmlNameFromProperty(value.property);
		const nameDerived =
			value.name === "" ||
			value.name === oldBase ||
			new RegExp(`^${oldBase}_\\d+$`).test(value.name);
		if (nameDerived) {
			patch.name = uniqueInputName(
				xmlNameFromProperty(property),
				siblings.filter((s) => s.uuid !== value.uuid),
			);
		}

		const next = rebuildRow(value, patch);
		const targetLabel =
			propertyDef === undefined
				? propertyFallbackDisplayLabel(property)
				: propertyDisplayLabel(propertyDef, projectProse);
		requestInputTransition(next, "binding", targetLabel);
	};

	/** Store the picked match. The type's own default stores as an
	 *  absent slot so the saved doc stays minimal; everything else
	 *  stores explicitly. */
	const setModeKind = (kind: SearchInputMode["kind"]) => {
		if (value.kind !== "simple") return;
		// Between dates consumes the date-range widget's paired answer. Keep
		// that coupling structural: choosing the match behavior changes the
		// widget in the same row replacement instead of saving a date+range
		// combination that Preview and CommCare interpret differently.
		if (kind === "range" && value.type !== "date-range") {
			const next = rebuildRow(value, {
				type: "date-range",
				mode: undefined,
				default: undefined,
			});
			requestInputTransition(next, "match", SEARCH_MODE_LABELS.range);
			return;
		}
		const mode =
			kind === DEFAULT_SEARCH_MODE_KIND[value.type]
				? undefined
				: buildMode(kind);
		onChange(rebuildRow(value, { mode }));
	};

	// ── Match-picker arm conversion ──
	//
	// "Custom condition" replaces the row with the advanced arm,
	// seeding `property = typed value` (the behavior the row already
	// had) so the author edits forward rather than starting blank.
	// The `via` slot drops: the condition AST encodes relation walks
	// inside its own structure when needed.
	//
	// Picking a standard match from the custom state converts back,
	// recovering the property when the condition is still anchored on
	// a self property (the round-trip shape the seed produces).

	const applyCustomConversion = (source: SimpleSearchInputDef) => {
		if (!searchInputsMatch(source, value)) return;
		onChange(
			advancedSearchInputDef(
				source.uuid,
				source.name,
				source.label,
				source.type,
				seedCustomCondition(source, currentCaseType),
				{
					default: searchInputDefault(source),
				},
			),
		);
		onEditCondition();
	};

	const toCustomCondition = () => {
		if (value.kind === "advanced") {
			onEditCondition();
			return;
		}
		if (!canSeedCustomConditionFaithfully(value)) {
			setPendingCustomConversion(value);
			return;
		}
		applyCustomConversion(value);
	};

	const buildStandardReplacement = (
		kind: SearchInputMode["kind"],
	): PendingStandardReplacement | null => {
		if (value.kind !== "advanced") return null;
		// Land a WORKING row, same bar as the add seed: an unbound
		// row matches nothing at runtime. Recover the condition's
		// anchor property when it has the round-trip shape; otherwise
		// seed the way a fresh field would.
		const ct = caseTypes.find((c) => c.name === currentCaseType);
		const properties = ct?.properties ?? [];
		const used = new Set(
			siblings.flatMap((s) =>
				s.kind === "simple" && s.uuid !== value.uuid ? [s.property] : [],
			),
		);
		const recovered = recoverAnchoredProperty(value.predicate);
		const propertyDef =
			(recovered !== undefined
				? properties.find((p) => p.name === recovered)
				: undefined) ?? pickSeedProperty(ct, used);
		if (propertyDef === undefined) return null;
		const inferredType = widgetTypeForProperty(propertyDef);
		const dataType = effectiveDataType(propertyDef);
		const type =
			kind === "range" &&
			(dataType === undefined || dataType === "date" || dataType === "datetime")
				? "date-range"
				: inferredType;
		const kindAdmitted =
			applicableSearchModes(type).includes(kind) &&
			(dataType === undefined ||
				(SEARCH_MODE_PROPERTY_TYPES[kind]?.includes(dataType) ?? true));
		const mode = !kindAdmitted
			? undefined
			: kind === DEFAULT_SEARCH_MODE_KIND[type]
				? undefined
				: buildMode(kind);
		const currentDefault = searchInputDefault(value);
		const keepDefault =
			currentDefault === undefined ||
			defaultFitsInputType(currentDefault, type, caseTypes, currentCaseType);
		const next =
			type === "date-range"
				? simpleSearchInputDef(
						value.uuid,
						value.name,
						value.label,
						type,
						propertyDef.name,
						{ mode: { kind: "range" } },
					)
				: simpleSearchInputDef(
						value.uuid,
						value.name,
						value.label,
						type,
						propertyDef.name,
						{
							default: keepDefault ? currentDefault : undefined,
							...(mode !== undefined && mode.kind !== "range" ? { mode } : {}),
						},
					);
		const resultingMode = effectiveModeKind(next);
		const targetPropertyLabel = propertyDisplayLabel(propertyDef, projectProse);
		return {
			source: value,
			next,
			resultingMode,
			...(resultingMode === kind
				? {}
				: {
						modeAdjustment: `“${SEARCH_MODE_LABELS[kind]}” can't search ${targetPropertyLabel}, so the replacement will use “${SEARCH_MODE_LABELS[resultingMode]}”.`,
					}),
			meaningfulDefaultRemoved:
				!keepDefault &&
				currentDefault !== undefined &&
				expressionHasMeaningfulContent(currentDefault),
		};
	};

	const requestStandardMode = (kind: SearchInputMode["kind"]) => {
		const pending = buildStandardReplacement(kind);
		if (pending !== null) setPendingStandardReplacement(pending);
	};

	const emptyValidityIndex = useMemo(() => buildValidityIndex([]), []);

	/* The bound property's effective data type: the Field type and
	 * Match pickers use it to disable choices the validator would
	 * reject (fuzzy on a number, say) instead of letting the author
	 * pick into an error. */
	const propertyDataType = useMemo<CasePropertyDataType | undefined>(() => {
		if (value.kind !== "simple") return undefined;
		const def = resolveProperty(caseTypes, value, currentCaseType);
		return def === undefined ? undefined : effectiveDataType(def);
	}, [value, caseTypes, currentCaseType]);

	const duplicateOf =
		resolved.nameState.kind === "duplicate"
			? siblings[resolved.nameState.firstIndex]
			: undefined;

	return (
		<PredicateEditProvider
			caseTypes={caseTypes}
			currentCaseType={currentCaseType}
			knownInputs={knownInputs}
			userProperties={userProperties}
			validityIndex={emptyValidityIndex}
		>
			<div className="space-y-5">
				<FieldRow label="Label" hint="Shown above the field">
					<BlurCommitTextInput
						value={value.label}
						onCommit={setLabel}
						ariaLabel={`Search field ${index + 1} label`}
					/>
					{resolved.labelEmpty && <InlineError errors={["Enter a label"]} />}
				</FieldRow>

				{value.kind === "simple" && (
					<FieldRow label="Case information">
						<BindingPicker
							row={value}
							caseTypes={caseTypes}
							currentCaseType={currentCaseType}
							onPick={setBinding}
							rowIndex={index}
							triggerRef={bindingTriggerRef}
						/>
						<InlineError errors={propertyErrors(resolved.propertyState)} />
					</FieldRow>
				)}

				<FieldRow label="Field type">
					<TypePicker
						value={value.type}
						onChange={setType}
						propertyDataType={propertyDataType}
						rowIndex={index}
						triggerRef={typeTriggerRef}
					/>
				</FieldRow>

				<FieldRow
					label="How it matches"
					hint={
						value.kind === "advanced"
							? "The condition below decides which cases match"
							: SEARCH_MODE_DESCRIPTIONS[effectiveModeKind(value)]
					}
				>
					<MatchPicker
						value={value}
						propertyDataType={propertyDataType}
						invalid={resolved.typeCouplingErrors.length > 0}
						rowIndex={index}
						triggerRef={matchTriggerRef}
						onPickMode={
							value.kind === "simple" ? setModeKind : requestStandardMode
						}
						onPickCustom={toCustomCondition}
					/>
				</FieldRow>

				{value.kind === "advanced" && (
					<FieldRow
						label="Custom condition"
						hint="Use what the person enters to decide which cases match"
					>
						<div className="rounded-xl border border-white/[0.07] bg-nova-deep/30 p-3">
							<p className="text-[13px] leading-relaxed text-nova-text-secondary">
								{summarizeFilter(value.predicate, {
									caseTypes,
									currentCaseType,
									knownInputs,
									projectProse,
								}) ?? "Every case matches"}
							</p>
							<Button
								data-condition-origin
								type="button"
								variant="outline"
								onClick={onEditCondition}
								className="mt-3 w-full"
							>
								Edit condition
							</Button>
						</div>
					</FieldRow>
				)}

				<InlineError errors={resolved.typeCouplingErrors} />

				{value.type === "date-range" ? null : (
					<DefaultValueSlot
						value={searchInputDefault(value)}
						inputType={value.type}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						userProperties={userProperties}
						rowIndex={index}
						onChange={setDefault}
					/>
				)}

				<AdvancedInputSettings active={resolved.nameState.kind !== "ok"}>
					<FieldRow
						label="Name used in other conditions"
						hint="A unique name for this search answer"
					>
						<BlurCommitTextInput
							value={value.name}
							onCommit={setName}
							ariaLabel={`Search field ${index + 1} name used in other conditions`}
						/>
						{resolved.nameState.kind === "empty" && (
							<InlineError errors={["Enter a name used in other conditions"]} />
						)}
						{duplicateOf !== undefined && (
							<InlineError
								errors={[
									`That name is already used by “${duplicateOf.label || duplicateOf.name}”. Choose another name`,
								]}
							/>
						)}
					</FieldRow>
				</AdvancedInputSettings>
			</div>
			<AlertDialog
				open={pendingStandardReplacement !== null}
				onOpenChange={(open) => {
					if (open) return;
					setPendingStandardReplacement(null);
				}}
			>
				<AlertDialogContent finalFocus={matchTriggerRef} className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display tracking-tighter">
							{pendingStandardReplacement === null
								? "Replace the custom condition?"
								: `Replace the custom condition with “${SEARCH_MODE_LABELS[pendingStandardReplacement.resultingMode]}”?`}
						</AlertDialogTitle>
						<AlertDialogDescription className="text-left">
							{standardReplacementConsequence(pendingStandardReplacement)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								const pending = pendingStandardReplacement;
								setPendingStandardReplacement(null);
								if (
									pending !== null &&
									searchInputsMatch(pending.source, value)
								) {
									onChange(pending.next);
								}
							}}
						>
							Replace
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog
				open={pendingCustomConversion !== null}
				onOpenChange={(open) => {
					if (open) return;
					setPendingCustomConversion(null);
				}}
			>
				<AlertDialogContent finalFocus={matchTriggerRef} className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle>
							{pendingCustomConversion === null
								? "Use a custom condition?"
								: `Replace ${customConversionModeLabel(pendingCustomConversion)} with a custom condition?`}
						</AlertDialogTitle>
						<AlertDialogDescription className="text-left">
							{customConversionConsequence(pendingCustomConversion)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								const pending = pendingCustomConversion;
								setPendingCustomConversion(null);
								if (pending !== null) applyCustomConversion(pending);
							}}
						>
							Replace
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog
				open={pendingInputTransition !== null}
				onOpenChange={(open) => {
					if (open) return;
					setPendingInputTransition(null);
				}}
			>
				<AlertDialogContent
					finalFocus={
						transitionFocusRef.current === "binding"
							? bindingTriggerRef
							: transitionFocusRef.current === "match"
								? matchTriggerRef
								: typeTriggerRef
					}
					className="text-left"
				>
					<AlertDialogHeader>
						<AlertDialogTitle>{pendingInputTransition?.title}</AlertDialogTitle>
						<AlertDialogDescription className="text-left">
							{pendingInputTransition?.description}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								const pending = pendingInputTransition;
								setPendingInputTransition(null);
								if (
									pending !== null &&
									searchInputsMatch(pending.source, value)
								) {
									onChange(pending.next);
								}
							}}
						>
							Change
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</PredicateEditProvider>
	);
}

function AdvancedInputSettings({
	active,
	children,
}: {
	readonly active: boolean;
	readonly children: React.ReactNode;
}) {
	const [opened, setOpened] = useState(false);
	const open = opened || active;
	return (
		<section className="border-t border-white/[0.06] pt-1">
			<Collapsible
				open={open}
				onOpenChange={(nextOpen) => {
					if (!active) setOpened(nextOpen);
				}}
			>
				<CollapsibleTrigger
					render={<button type="button" className={DISCLOSURE_ROW_CLS} />}
				>
					<Icon
						icon={tablerChevronRight}
						width="13"
						height="13"
						className="shrink-0 text-nova-text-muted transition-transform group-data-[panel-open]:rotate-90"
					/>
					<span className="text-[14px] font-medium text-nova-text-secondary transition-colors group-hover:text-nova-text">
						More settings
					</span>
					{active && (
						<span className="ml-auto text-[12px] text-nova-rose">
							Needs attention
						</span>
					)}
				</CollapsibleTrigger>
				<CollapsibleContent className="pb-1 pt-2">
					{children}
				</CollapsibleContent>
			</Collapsible>
		</section>
	);
}

// ── Field chrome ──────────────────────────────────────────────────

/** Friendly sentence-case label + control + quiet hint. */
function FieldRow({
	label,
	hint,
	children,
}: {
	readonly label: string;
	readonly hint?: string;
	readonly children: React.ReactNode;
}) {
	return (
		/* `gap`, not `space-y`. This row holds popup TRIGGERS, and Base UI mounts
		 * `position: fixed` focus guards as their siblings while a popup is open.
		 * Tailwind's space utilities are sibling-counting (`> :not(:last-child)`),
		 * so those guards change which children are "last" and the spacing moves
		 * under the open popup. `gap` spaces the children of a flex container
		 * without reference to their count or order, so an out-of-flow helper
		 * appearing mid-row cannot shift anything. */
		<div className="flex flex-col gap-2">
			<div className="text-[13px] font-medium leading-5 text-nova-text-secondary">
				{label}
			</div>
			{children}
			{hint !== undefined && (
				<p className="text-[13px] leading-relaxed text-nova-text-muted">
					{hint}
				</p>
			)}
		</div>
	);
}

/** The person-to-person line under a dangling property:
 *  names what's wrong AND what it costs at runtime. */
function propertyErrors(state: PropertyState): readonly string[] {
	switch (state.kind) {
		case "ok":
			return [];
		case "dangling":
			return [
				"That information is no longer available. Choose something else.",
			];
	}
}

// ── Binding picker: property + where it lives, one control ───────

interface BindingPickerProps {
	readonly row: SimpleSearchInputDef;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly onPick: (property: string, scope: "self" | "parent") => void;
	readonly rowIndex: number;
	readonly triggerRef: RefObject<HTMLButtonElement | null>;
}

/**
 * One picker answers "what does this field search?": the case's own
 * properties, and the parent case's when the case type has a parent.
 * Picking a parent property carries the relation walk implicitly; no
 * separate control, no walk vocabulary.
 *
 * A row whose walk was authored elsewhere with a shape this picker
 * can't express (a child-case walk, a multi-step walk) keeps working:
 * the picker says so in plain words and offers the way back.
 */
function BindingPicker({
	row,
	caseTypes,
	currentCaseType,
	onPick,
	rowIndex,
	triggerRef,
}: BindingPickerProps) {
	const projectProse = useProseProjection();
	const scope = classifyVia(row.via);
	const ct = caseTypes.find((c) => c.name === currentCaseType);
	const parentCt =
		ct?.parent_type !== undefined
			? caseTypes.find((c) => c.name === ct.parent_type)
			: undefined;

	const thisCaseProperties = ct?.properties ?? [];
	const parentCaseProperties = parentCt?.properties ?? [];
	const hasAnyProperties =
		thisCaseProperties.length + parentCaseProperties.length > 0;
	const destinationProperties =
		scope === "parent" ? parentCaseProperties : thisCaseProperties;
	const selectedDef = destinationProperties.find(
		(p) => p.name === row.property,
	);
	const selectedPropertyName = row.property;
	const selectedLabel =
		scope === "custom"
			? propertyFallbackDisplayLabel(row.property)
			: selectedDef === undefined
				? propertyDisplayLabelForName(
						row.property,
						destinationProperties,
						projectProse,
					)
				: propertyDisplayLabel(selectedDef, projectProse);
	const selectedQualifier =
		scope === "custom" || selectedDef === undefined
			? undefined
			: friendlyPropertyDisambiguator(
					selectedDef,
					destinationProperties,
					projectProse,
				);
	const sourceLabel =
		scope === "custom"
			? "Linked case"
			: scope === "parent"
				? "Parent case"
				: "This case";
	const choices = useMemo<
		readonly SearchableChoice<{
			readonly property: CaseProperty;
			readonly scope: "self" | "parent";
		}>[]
	>(
		() => [
			...thisCaseProperties.map((property) => ({
				id: `self:${property.name}`,
				label: propertyDisplayLabel(property, projectProse),
				detail: [
					friendlyPropertyDisambiguator(
						property,
						thisCaseProperties,
						projectProse,
					),
					propertyTypeLabel(property),
				]
					.filter((part): part is string => part !== undefined)
					.join(" · "),
				group: "This case",
				icon: tablerDatabase,
				searchText: property.name,
				value: { property, scope: "self" as const },
			})),
			...parentCaseProperties.map((property) => ({
				id: `parent:${property.name}`,
				label: propertyDisplayLabel(property, projectProse),
				detail: [
					friendlyPropertyDisambiguator(
						property,
						parentCaseProperties,
						projectProse,
					),
					propertyTypeLabel(property),
				]
					.filter((part): part is string => part !== undefined)
					.join(" · "),
				group: "Parent case",
				icon: tablerDatabase,
				searchText: property.name,
				value: { property, scope: "parent" as const },
			})),
		],
		[thisCaseProperties, parentCaseProperties, projectProse],
	);
	const selectedId =
		scope === "self" || scope === "parent"
			? `${scope}:${selectedPropertyName}`
			: undefined;

	return (
		<SearchableChoiceCombobox
			choices={choices}
			onChoose={(choice) =>
				onPick(choice.value.property.name, choice.value.scope)
			}
			selectedId={selectedId}
			trigger={
				<Button
					ref={triggerRef}
					type="button"
					variant="outline"
					className={PICKER_TRIGGER_CLS}
				/>
			}
			triggerLabel={`Search field ${rowIndex + 1} information`}
			triggerContent={
				<>
					<Icon
						icon={tablerDatabase}
						width="16"
						height="16"
						className="text-nova-violet-bright shrink-0"
					/>
					<span className="flex-1 min-w-0 text-left">
						<span className="block break-words font-medium text-nova-text">
							{selectedLabel}
						</span>
						<span className="block break-words text-[12px] text-nova-text-muted">
							{[
								sourceLabel,
								selectedQualifier,
								scope === "custom" || selectedDef === undefined
									? undefined
									: propertyTypeLabel(selectedDef),
							]
								.filter(Boolean)
								.join(" · ")}
						</span>
					</span>
				</>
			}
			heading="Choose information"
			description="Choose what this field searches"
			searchLabel="Search information"
			searchPlaceholder="Search information"
			emptyTitle={
				hasAnyProperties ? "No matching information" : "No case information yet"
			}
			emptyDescription={
				hasAnyProperties
					? "Try a different search"
					: "Add case information before choosing what this field searches"
			}
			contentClassName="max-h-[min(20rem,var(--available-height))]"
		/>
	);
}

function searchInputsMatch(
	left: SearchInputDef,
	right: SearchInputDef,
): boolean {
	if (left === right) return true;
	return JSON.stringify(left) === JSON.stringify(right);
}

function searchModesMatch(
	left: SearchInputMode | undefined,
	right: SearchInputMode | undefined,
): boolean {
	if (left === right) return true;
	return JSON.stringify(left) === JSON.stringify(right);
}

function expressionHasMeaningfulContent(value: ValueExpression): boolean {
	if (value.kind !== "term") return true;
	switch (value.term.kind) {
		case "literal":
			return typeof value.term.value === "string"
				? value.term.value.length > 0
				: true;
		case "prop":
			return value.term.property.length > 0 || value.term.via !== undefined;
		case "field":
			return true;
		case "input":
			return true;
		case "session-context":
			return true;
		case "session-user":
			return value.term.field.length > 0;
		case "session-user-property":
			return true;
		case "table-column":
			throw new Error(
				"Lookup table columns are dormant and cannot reach the search-input editor.",
			);
	}
}

function defaultFitsInputType(
	value: ValueExpression,
	type: SearchInputType,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): boolean {
	if (type === "date-range") return false;
	const resolved = checkExpression(
		value,
		{
			caseTypes: [...caseTypes],
			knownInputs: [],
			currentCaseType,
		},
		[],
		[],
	);
	if (resolved === undefined) return false;
	const constraint = constraintForDefault(type);
	return constraint.accepts === "any" || acceptsType(constraint, resolved);
}

function searchModeDescription(
	mode: SearchInputMode | undefined,
	type: SearchInputType,
): string {
	const kind = mode?.kind ?? DEFAULT_SEARCH_MODE_KIND[type];
	return SEARCH_MODE_LABELS[kind];
}

function customConversionModeLabel(row: SimpleSearchInputDef | null): string {
	if (row === null) return "saved match";
	return `“${searchModeDescription(row.mode, row.type)}”`;
}

function standardReplacementConsequence(
	pending: PendingStandardReplacement | null,
): string {
	if (pending === null) {
		return "The custom condition will be removed. You can undo this change.";
	}
	const match = SEARCH_MODE_LABELS[pending.resultingMode];
	const modeAdjustment = pending.modeAdjustment ?? "";
	const defaultConsequence = pending.meaningfulDefaultRemoved
		? ` The starting value will also be removed because ${SEARCH_INPUT_TYPE_LABELS[pending.next.type]} can't use it.`
		: "";
	return `${modeAdjustment}${modeAdjustment === "" ? "" : " "}Some parts of the custom condition don't fit “${match}” and will be removed.${defaultConsequence} You can undo this change.`;
}

function customConversionConsequence(row: SimpleSearchInputDef | null): string {
	if (row === null) {
		return "This replaces the saved match. You can undo this change.";
	}
	if (effectiveModeKind(row) === "range") {
		return "The new condition will start with “Exact value” because it can't keep both dates in the range. You can edit it next. You can undo this change.";
	}
	return `The new condition will start with “Exact value” because it can't keep the full list from ${customConversionModeLabel(row)}. You can edit it next. You can undo this change.`;
}

// ── Row rebuild helper ────────────────────────────────────────────
//
// Single shape every per-slot mutator routes through. The simple +
// advanced arms have different per-arm slots; the helper preserves
// the row's existing arm and threads the patch through the matching
// builder so the output shape stays in lockstep with the schema.

interface RowPatch {
	readonly name?: string;
	readonly label?: string;
	readonly type?: SearchInputType;
	readonly property?: string;
	readonly via?: RelationPath | undefined;
	readonly mode?: SearchInputMode | undefined;
	readonly default?: ValueExpression | undefined;
}

function rebuildRow(value: SearchInputDef, patch: RowPatch): SearchInputDef {
	const type = patch.type ?? value.type;
	if (value.kind === "simple") {
		const property = patch.property ?? value.property;
		const via = "via" in patch ? patch.via : value.via;
		const mode = "mode" in patch ? patch.mode : value.mode;
		const dflt = "default" in patch ? patch.default : searchInputDefault(value);
		return type === "date-range"
			? simpleSearchInputDef(
					value.uuid,
					patch.name ?? value.name,
					patch.label ?? value.label,
					type,
					property,
					{ via, mode: { kind: "range" } },
				)
			: simpleSearchInputDef(
					value.uuid,
					patch.name ?? value.name,
					patch.label ?? value.label,
					type,
					property,
					{
						via,
						...(mode !== undefined && mode.kind !== "range" ? { mode } : {}),
						default: dflt,
					},
				);
	}
	const dflt = "default" in patch ? patch.default : searchInputDefault(value);
	return type === "date-range"
		? advancedSearchInputDef(
				value.uuid,
				patch.name ?? value.name,
				patch.label ?? value.label,
				type,
				value.predicate,
			)
		: advancedSearchInputDef(
				value.uuid,
				patch.name ?? value.name,
				patch.label ?? value.label,
				type,
				value.predicate,
				{ default: dflt },
			);
}

// ── Field-type picker ─────────────────────────────────────────────

interface TypePickerProps {
	readonly value: SearchInputType;
	readonly onChange: (next: SearchInputType) => void;
	/** Effective data type of the bound property (simple arm only):
	 *  gates which field types are selectable, mirroring the Match
	 *  picker. `undefined` (custom condition / unresolved property)
	 *  gates nothing, matching the validator's skip. */
	readonly propertyDataType: CasePropertyDataType | undefined;
	readonly rowIndex: number;
	readonly triggerRef: RefObject<HTMLButtonElement | null>;
}

function TypePicker({
	value,
	onChange,
	propertyDataType,
	rowIndex,
	triggerRef,
}: TypePickerProps) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				render={<Button type="button" variant="outline" />}
				aria-label={`Search field ${rowIndex + 1} type: ${SEARCH_INPUT_TYPE_LABELS[value]}`}
				className={PICKER_TRIGGER_CLS}
			>
				<Icon
					icon={SEARCH_INPUT_TYPE_ICONS[value]}
					width="16"
					height="16"
					className="text-nova-violet-bright shrink-0"
				/>
				<span className="flex-1 min-w-0 text-left">
					<span className="block text-nova-text">
						{SEARCH_INPUT_TYPE_LABELS[value]}
					</span>
					<span className="block break-words text-[13px] text-nova-text-muted">
						{SEARCH_INPUT_TYPE_DESCRIPTIONS[value]}
					</span>
				</span>
				<Icon
					icon={tablerChevronDown}
					width="15"
					height="15"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" preferredMinWidth="16rem">
				<DropdownMenuRadioGroup
					value={value}
					onValueChange={(next) => onChange(next as SearchInputType)}
				>
					{SEARCH_INPUT_TYPES.map((t) => {
						const isActive = t === value;
						// Property-level gate: a field the bound property's
						// data type can't run (a calendar over a text
						// property, say) is disabled with the reason rather
						// than selectable into a validation error.
						const admitted =
							propertyDataType === undefined ||
							(SEARCH_INPUT_TYPE_PROPERTY_TYPES[t]?.includes(
								propertyDataType,
							) ??
								true);
						return (
							<DropdownMenuRadioItem
								key={t}
								value={t}
								disabled={!admitted}
								className={
									isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
								}
							>
								<Icon
									icon={SEARCH_INPUT_TYPE_ICONS[t]}
									width="15"
									height="15"
									className={
										isActive
											? "text-nova-violet-bright"
											: "text-nova-text-muted"
									}
								/>
								<span className="flex-1 text-left">
									<div>{SEARCH_INPUT_TYPE_LABELS[t]}</div>
									<div
										className={`text-[13px] leading-relaxed ${
											isActive
												? "text-nova-violet-bright"
												: "text-nova-text-muted"
										}`}
									>
										{admitted
											? SEARCH_INPUT_TYPE_DESCRIPTIONS[t]
											: "This field type doesn't work with this information"}
									</div>
								</span>
							</DropdownMenuRadioItem>
						);
					})}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// ── Match picker: standard modes + the custom arm, one menu ──────

interface MatchPickerProps {
	readonly value: SearchInputDef;
	/** Effective data type of the bound property: gates which modes
	 *  are selectable. `undefined` (unresolved property / custom
	 *  condition) gates nothing, matching the validator's skip. */
	readonly propertyDataType: CasePropertyDataType | undefined;
	readonly invalid: boolean;
	readonly rowIndex: number;
	readonly triggerRef: RefObject<HTMLButtonElement | null>;
	readonly onPickMode: (kind: SearchInputMode["kind"]) => void;
	readonly onPickCustom: () => void;
}

function MatchPicker({
	value,
	propertyDataType,
	invalid,
	rowIndex,
	triggerRef,
	onPickMode,
	onPickCustom,
}: MatchPickerProps) {
	const isCustom = value.kind === "advanced";
	const applicable = applicableSearchModes(value.type);
	const choices =
		value.type === "date" ? ([...applicable, "range"] as const) : applicable;
	const effectiveKind =
		value.kind === "simple" ? effectiveModeKind(value) : null;
	const triggerLabel = isCustom
		? "Custom condition"
		: SEARCH_MODE_LABELS[effectiveKind ?? "exact"];

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				render={<Button type="button" variant="outline" />}
				aria-label={`Search field ${rowIndex + 1} match: ${triggerLabel}`}
				className={`${PICKER_TRIGGER_CLS} ${
					invalid ? "border-nova-rose/40 hover:border-nova-rose/60" : ""
				}`}
			>
				<span className="flex-1 min-w-0 text-left flex items-center gap-2">
					<span className={invalid ? "text-nova-rose" : "text-nova-text"}>
						{triggerLabel}
					</span>
					{invalid && (
						<Icon
							icon={tablerExclamationCircle}
							width="14"
							height="14"
							className="text-nova-rose"
							aria-hidden="true"
						/>
					)}
				</span>
				<Icon
					icon={tablerChevronDown}
					width="15"
					height="15"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" preferredMinWidth="17rem">
				<DropdownMenuRadioGroup
					value={isCustom ? "custom" : (effectiveKind ?? "exact")}
					onValueChange={(next) => {
						if (next === "custom") onPickCustom();
						else onPickMode(next as SearchInputMode["kind"]);
					}}
				>
					{choices.map((kind) => {
						const isActive = !isCustom && effectiveKind === kind;
						// Property-level gate: picking a match the bound
						// property's data type can't run would only land the
						// row in a validation error, so the item is disabled
						// and says why instead.
						const admitted =
							propertyDataType === undefined ||
							(SEARCH_MODE_PROPERTY_TYPES[kind]?.includes(propertyDataType) ??
								true);
						return (
							<DropdownMenuRadioItem
								key={kind}
								value={kind}
								disabled={!admitted}
								className={
									isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
								}
							>
								<span className="flex-1 text-left">
									<div>{SEARCH_MODE_LABELS[kind]}</div>
									<div
										className={`text-[13px] leading-relaxed ${
											isActive
												? "text-nova-violet-bright"
												: "text-nova-text-muted"
										}`}
									>
										{admitted
											? SEARCH_MODE_DESCRIPTIONS[kind]
											: "This match doesn't work with this information"}
									</div>
								</span>
							</DropdownMenuRadioItem>
						);
					})}
					<DropdownMenuSeparator />
					<DropdownMenuRadioItem
						value="custom"
						className={
							isCustom ? "text-nova-violet-bright bg-nova-violet/10" : ""
						}
					>
						<Icon
							icon={tablerWand}
							width="15"
							height="15"
							className={
								isCustom ? "text-nova-violet-bright" : "text-nova-text-muted"
							}
						/>
						<span className="flex-1 text-left">
							<div>Custom condition</div>
							<div
								className={`text-[13px] leading-relaxed ${
									isCustom ? "text-nova-violet-bright" : "text-nova-text-muted"
								}`}
							>
								Combine case information to decide what matches
							</div>
						</span>
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// ── Default-value slot ────────────────────────────────────────────

interface DefaultValueSlotProps {
	readonly value: ValueExpression | undefined;
	readonly inputType: ScalarDefaultSearchInputType;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly userProperties: readonly UserProperty[];
	readonly rowIndex: number;
	readonly onChange: (next: ValueExpression | undefined) => void;
}

function DefaultValueSlot({
	value,
	inputType,
	caseTypes,
	currentCaseType,
	userProperties,
	rowIndex,
	onChange,
}: DefaultValueSlotProps) {
	const constraint = constraintForDefault(inputType);
	return (
		<FieldRow
			label="Starting value"
			hint="Pre-fills the field, and people can change it before searching"
		>
			{value === undefined ? (
				<Button
					type="button"
					onClick={() => onChange(seedDefaultExpression(inputType))}
					variant="ghost"
					className="nova-add-slot w-full"
					aria-label={`Add a starting value for search field ${rowIndex + 1}`}
				>
					<Icon icon={tablerPlus} width="13" height="13" />
					<span>Add starting value</span>
				</Button>
			) : (
				<div className="space-y-3 rounded-xl border border-white/[0.06] bg-nova-deep/30 p-3">
					{/* Forbids input refs: the default fills the field before
				    the search screen opens. See NO_SEARCH_INPUTS. */}
					<ExpressionCardEditor
						value={value}
						onChange={onChange}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						knownInputs={NO_SEARCH_INPUTS}
						userProperties={userProperties}
						caseDataScope="global"
						constraint={constraint}
					/>
					<Button
						type="button"
						onClick={() => onChange(undefined)}
						variant="destructive"
						className="w-full px-3 text-[14px]"
						aria-label={`Remove the starting value for search field ${rowIndex + 1}`}
					>
						Remove starting value
					</Button>
				</div>
			)}
		</FieldRow>
	);
}
