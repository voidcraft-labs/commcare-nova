// components/builder/case-list-config/inspector/SearchInputEditor.tsx
//
// Inspector body for one search field. ONE view serves every author:
// Label and hint → what it searches → how the field looks → how it matches →
// what it starts with → whether an answer is required → one check on the
// answer. The internal reference name is still available behind one quiet
// Advanced disclosure; storage vocabulary should not compete with the
// worker-facing choices in the normal flow. Writing a custom condition
// remains the last choice in the Match picker. The rail summarizes it and
// opens the center workbench; picking any standard match brings the standard
// controls back here. The required condition and the check rule follow the
// same rule: a summary here, the full editor in the center.
//
// A hidden value is a different thing (no widget, no match, never shown), so
// a row of that kind renders `HiddenSearchValueEditor` instead of this view.
//
// A choice widget (`select` / `multi-select`) needs a Project data table
// before it can exist, so choosing one for a field that has no choices yet
// STAGES the type change: the table and columns are chosen first and the
// field changes type in one commit once they are complete. Cancel leaves the
// field as it was. Nothing here can land a choice field without its table.
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
import { firstComparisonDefault } from "@/components/builder/shared/cards/comparisonSeed";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import {
	buildValidityIndex,
	PredicateEditProvider,
} from "@/components/builder/shared/editorContext";
import type { PredicateEditContext } from "@/components/builder/shared/editorSchemas";
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
	isSelectSearchInputType,
	type LookupOptionsSource,
	multiSelectSearchInputRefusal,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	SEARCH_INPUT_TYPE_PROPERTY_TYPES,
	SEARCH_INPUT_TYPES,
	SEARCH_MODE_PROPERTY_TYPES,
	type SearchInputDef,
	type SearchInputMode,
	type SearchInputRequired,
	type SearchInputType,
	type SearchInputValidation,
	type SelectSearchInputType,
	type SimpleSearchInputDef,
	searchInputDefault,
	searchInputOptions,
	simpleSearchInputDef,
	type UserProperty,
	type VisibleSearchInputDef,
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
import {
	type PredicateSummaryContext,
	summarizeFilter,
} from "../predicateSummary";
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
import type { SearchConditionSlot } from "../workspaceSelection";
import { HiddenSearchValueEditor } from "./HiddenSearchValueEditor";
import { SearchChoiceSourceEditor } from "./SearchChoiceSourceEditor";
import { FieldRow } from "./searchInputFieldRow";

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
	/** Opens one of this field's conditions in the center-canvas workbench:
	 *  the custom match, the required condition, or the check rule. */
	readonly onEditCondition: (slot: SearchConditionSlot) => void;
}

/** Placeholder a fresh check carries until the author writes the real one. */
export const SEARCH_INPUT_CHECK_SEED_MESSAGE =
	"Check this answer and try again";

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
 * target full-size, one view for all authors. A hidden value is its own
 * surface; every visible widget shares the one below.
 */
export function SearchInputEditor(props: SearchInputEditorProps) {
	if (props.value.kind === "hidden") {
		return (
			<HiddenSearchValueEditor
				value={props.value}
				index={props.index}
				siblings={props.siblings}
				caseTypes={props.caseTypes}
				currentCaseType={props.currentCaseType}
				userProperties={props.userProperties}
				onChange={props.onChange}
			/>
		);
	}
	return <VisibleSearchInputEditor {...props} value={props.value} />;
}

interface VisibleSearchInputEditorProps
	extends Omit<SearchInputEditorProps, "value"> {
	readonly value: VisibleSearchInputDef;
}

function VisibleSearchInputEditor({
	value,
	index,
	siblings,
	caseTypes,
	currentCaseType,
	userProperties = [],
	onChange,
	onEditCondition,
}: VisibleSearchInputEditorProps) {
	const [pendingStandardReplacement, setPendingStandardReplacement] =
		useState<PendingStandardReplacement | null>(null);
	const [pendingInputTransition, setPendingInputTransition] =
		useState<PendingInputTransition | null>(null);
	const [pendingCustomConversion, setPendingCustomConversion] =
		useState<SimpleSearchInputDef | null>(null);
	/* A choice widget chosen for a field that has no choice list yet. The type
	 * picker shows it while the table is being chosen; the field itself does
	 * not change until the source is complete. */
	const [pendingChoiceType, setPendingChoiceType] =
		useState<SelectSearchInputType | null>(null);
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

	/* A multiple-choice field matches only when its reference name IS the
	 * property it searches (`multiSelectSearchInputRefusal`), so a rename that
	 * breaks that is held with the reason instead of bouncing off the gate. */
	const [nameRefusal, setNameRefusal] = useState<string | null>(null);
	const setName = (name: string) => {
		if (value.kind === "simple" && value.type === "multi-select") {
			const refusal = multiSelectSearchInputRefusal({ ...value, name });
			if (refusal !== undefined) {
				setNameRefusal(refusal);
				return;
			}
		}
		setNameRefusal(null);
		onChange(rebuildRow(value, { name }));
	};
	/* The reason a multiple-choice widget is withheld from this row, if any:
	 * the same verdict the commit gate applies. */
	const multiSelectRefusal =
		value.kind === "simple" && value.type !== "multi-select"
			? multiSelectSearchInputRefusal(value)
			: undefined;
	const setLabel = (label: string) => onChange(rebuildRow(value, { label }));
	const requestInputTransition = (
		next: VisibleSearchInputDef,
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
		const choicesRemoved =
			searchInputOptions(value) !== undefined &&
			searchInputOptions(next) === undefined;
		if (!modeChanged && !meaningfulDefaultRemoved && !choicesRemoved) {
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
		if (choicesRemoved) {
			consequences.push(
				`The choice list will be removed because ${targetDescription} doesn't offer choices.`,
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

	const applyType = (type: SearchInputType, options?: LookupOptionsSource) => {
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
			...(options === undefined ? {} : { options }),
			...(keepMode ? {} : { mode: undefined }),
			...(keepDefault ? {} : { default: undefined }),
		});
		requestInputTransition(next, "type", SEARCH_INPUT_TYPE_LABELS[type]);
	};
	const setType = (type: SearchInputType) => {
		if (type === value.type) {
			setPendingChoiceType(null);
			return;
		}
		// A choice widget cannot exist without its table. When the field already
		// offers choices the list carries over; otherwise the change waits for
		// the source editor to complete it.
		if (
			isSelectSearchInputType(type) &&
			searchInputOptions(value) === undefined
		) {
			setPendingChoiceType(type);
			return;
		}
		setPendingChoiceType(null);
		applyType(type);
	};
	const setDefault = (next: ValueExpression | undefined) =>
		onChange(rebuildRow(value, { default: next }));
	const setHint = (hint: string) =>
		onChange(rebuildRow(value, { hint: hint === "" ? undefined : hint }));
	const setRequired = (required: SearchInputRequired | undefined) =>
		onChange(rebuildRow(value, { required }));
	const setValidation = (validation: SearchInputValidation | undefined) =>
		onChange(rebuildRow(value, { validation }));
	const setOptions = (options: LookupOptionsSource) =>
		onChange(rebuildRow(value, { options }));

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

		if (propertyDef !== undefined) {
			const dataType = effectiveDataType(propertyDef);
			// A multiple-choice field also has to keep riding the bare prompt
			// (this case, a name equal to the property); a binding that breaks
			// that falls back to the property's natural widget, and the
			// transition names the choice list it drops.
			const typeAllowed =
				(SEARCH_INPUT_TYPE_PROPERTY_TYPES[value.type]?.includes(dataType) ??
					true) &&
				(value.type !== "multi-select" ||
					multiSelectSearchInputRefusal({
						name: patch.name ?? value.name,
						property,
						via,
					}) === undefined);
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
		const options = searchInputOptions(source);
		onChange(
			advancedSearchInputDef(
				source.uuid,
				source.name,
				source.label,
				source.type,
				seedCustomCondition(source, currentCaseType),
				{
					...visibleSlotsOf(source),
					default: searchInputDefault(source),
					...(options === undefined ? {} : { options }),
				},
			),
		);
		onEditCondition("match");
	};

	const toCustomCondition = () => {
		if (value.kind === "advanced") {
			onEditCondition("match");
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
		const dataType = effectiveDataType(propertyDef);
		const currentOptions = searchInputOptions(value);
		// A choice list survives the conversion while the recovered property can
		// still hold a chosen token; otherwise the widget follows the property.
		const keepChoices =
			currentOptions !== undefined &&
			isSelectSearchInputType(value.type) &&
			(SEARCH_INPUT_TYPE_PROPERTY_TYPES[value.type]?.includes(dataType) ??
				true);
		const inferredType = keepChoices
			? value.type
			: widgetTypeForProperty(propertyDef);
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
		const visible = visibleSlotsOf(value);
		const next =
			type === "date-range"
				? simpleSearchInputDef(
						value.uuid,
						value.name,
						value.label,
						type,
						propertyDef.name,
						{ ...visible, mode: { kind: "range" } },
					)
				: isSelectSearchInputType(type) && currentOptions !== undefined
					? simpleSearchInputDef(
							value.uuid,
							value.name,
							value.label,
							type,
							propertyDef.name,
							{
								...visible,
								options: currentOptions,
								default: keepDefault ? currentDefault : undefined,
							},
						)
					: simpleSearchInputDef(
							value.uuid,
							value.name,
							value.label,
							type,
							propertyDef.name,
							{
								...visible,
								default: keepDefault ? currentDefault : undefined,
								...(mode !== undefined && mode.kind !== "range"
									? { mode }
									: {}),
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

				<FieldRow label="Hint" hint="A short line under the label, if it helps">
					<BlurCommitTextInput
						value={value.hint ?? ""}
						onCommit={setHint}
						placeholder="Optional"
						ariaLabel={`Search field ${index + 1} hint`}
					/>
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

				<FieldRow
					label="Field type"
					hint={
						pendingChoiceType === null
							? undefined
							: "Choose the table the choices come from to finish this change"
					}
				>
					<TypePicker
						value={pendingChoiceType ?? value.type}
						onChange={setType}
						propertyDataType={propertyDataType}
						multiSelectRefusal={multiSelectRefusal}
						rowIndex={index}
						triggerRef={typeTriggerRef}
					/>
				</FieldRow>

				{pendingChoiceType !== null ? (
					<FieldRow label="Choices">
						<SearchChoiceSourceEditor
							value={undefined}
							caseTypes={caseTypes}
							userProperties={userProperties}
							rowIndex={index}
							onCommit={(options) => {
								setPendingChoiceType(null);
								applyType(pendingChoiceType, options);
							}}
							onCancel={() => setPendingChoiceType(null)}
						/>
					</FieldRow>
				) : isSelectSearchInputType(value.type) ? (
					<FieldRow
						label="Choices"
						hint={
							value.type === "multi-select"
								? "People tick any that apply, and a case matches when it holds one of them"
								: "People pick one, and a case matches when it holds that value"
						}
					>
						<SearchChoiceSourceEditor
							value={searchInputOptions(value)}
							caseTypes={caseTypes}
							userProperties={userProperties}
							rowIndex={index}
							onCommit={setOptions}
						/>
					</FieldRow>
				) : null}

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
								onClick={() => onEditCondition("match")}
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

				<RequiredSlot
					value={value.required}
					rowIndex={index}
					summaryContext={{
						caseTypes,
						currentCaseType,
						knownInputs,
						projectProse,
					}}
					onChange={setRequired}
					onEditCondition={() => onEditCondition("required")}
				/>

				<CheckSlot
					value={value.validation}
					rowIndex={index}
					summaryContext={{
						caseTypes,
						currentCaseType,
						knownInputs,
						projectProse,
					}}
					onChange={setValidation}
					onEditRule={() => onEditCondition("validation")}
				/>

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
						{nameRefusal !== null && <InlineError errors={[nameRefusal]} />}
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

// ── Required + check slots ────────────────────────────────────────
//
// Both evaluate on the Search screen itself, where every sibling answer is
// readable, and both are enforced by Web Apps only: Android never checks a
// prompt before it searches. The rail holds the choice and the message; a
// condition or rule opens in the center canvas like the custom match does.

type RequiredChoice = "optional" | "always" | "conditional";

function requiredChoiceOf(
	required: SearchInputRequired | undefined,
): RequiredChoice {
	if (required === undefined) return "optional";
	return required.when === undefined ? "always" : "conditional";
}

const REQUIRED_CHOICE_LABELS: Record<RequiredChoice, string> = {
	optional: "Optional",
	always: "Always required",
	conditional: "Required under a condition",
};

const REQUIRED_CHOICE_DESCRIPTIONS: Record<RequiredChoice, string> = {
	optional: "People can search without answering",
	always: "People must answer before they search",
	conditional: "Required only while a condition holds",
};

const REQUIRED_CHOICES: readonly RequiredChoice[] = [
	"optional",
	"always",
	"conditional",
];

interface RequiredSlotProps {
	readonly value: SearchInputRequired | undefined;
	readonly rowIndex: number;
	readonly summaryContext: PredicateSummaryContext;
	readonly onChange: (next: SearchInputRequired | undefined) => void;
	readonly onEditCondition: () => void;
}

function RequiredSlot({
	value,
	rowIndex,
	summaryContext,
	onChange,
	onEditCondition,
}: RequiredSlotProps) {
	const choice = requiredChoiceOf(value);
	const pick = (next: RequiredChoice) => {
		if (next === choice) return;
		switch (next) {
			case "optional":
				onChange(undefined);
				return;
			case "always":
				onChange(
					value?.message === undefined ? {} : { message: value.message },
				);
				return;
			case "conditional": {
				const when = firstComparisonDefault({
					...summaryContextToEditContext(summaryContext),
					caseDataScope: "global",
				});
				onChange({
					...(value?.message === undefined ? {} : { message: value.message }),
					when,
				});
				onEditCondition();
				return;
			}
		}
	};
	return (
		<FieldRow
			label="Required"
			hint={
				choice === "optional"
					? undefined
					: "Checked in the browser app. On a phone the search runs either way"
			}
		>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={<Button type="button" variant="outline" />}
					aria-label={`Search field ${rowIndex + 1} required: ${REQUIRED_CHOICE_LABELS[choice]}`}
					className={PICKER_TRIGGER_CLS}
				>
					<span className="flex-1 min-w-0 text-left">
						<span className="block text-nova-text">
							{REQUIRED_CHOICE_LABELS[choice]}
						</span>
						<span className="block break-words text-[13px] text-nova-text-muted">
							{REQUIRED_CHOICE_DESCRIPTIONS[choice]}
						</span>
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
						value={choice}
						onValueChange={(next) => pick(next as RequiredChoice)}
					>
						{REQUIRED_CHOICES.map((candidate) => {
							const isActive = candidate === choice;
							return (
								<DropdownMenuRadioItem
									key={candidate}
									value={candidate}
									className={
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									}
								>
									<span className="flex-1 text-left">
										<div>{REQUIRED_CHOICE_LABELS[candidate]}</div>
										<div
											className={`text-[13px] leading-relaxed ${
												isActive
													? "text-nova-violet-bright"
													: "text-nova-text-muted"
											}`}
										>
											{REQUIRED_CHOICE_DESCRIPTIONS[candidate]}
										</div>
									</span>
								</DropdownMenuRadioItem>
							);
						})}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>

			{value !== undefined && (
				<div className="space-y-3 rounded-xl border border-white/[0.06] bg-nova-deep/30 p-3">
					{value.when !== undefined && (
						<div>
							<p className="text-[13px] leading-relaxed text-nova-text-secondary">
								{summarizeFilter(value.when, summaryContext) ??
									"Always, until the condition is edited"}
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
					)}
					<div className="flex flex-col gap-2">
						<div className="text-[13px] font-medium leading-5 text-nova-text-secondary">
							Message when unanswered
						</div>
						<BlurCommitTextInput
							value={value.message ?? ""}
							onCommit={(message) =>
								onChange({
									...(value.when === undefined ? {} : { when: value.when }),
									...(message === "" ? {} : { message }),
								})
							}
							placeholder={SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE}
							ariaLabel={`Search field ${rowIndex + 1} required message`}
						/>
						<p className="text-[13px] leading-relaxed text-nova-text-muted">
							Leave it blank to use the standard message
						</p>
					</div>
				</div>
			)}
		</FieldRow>
	);
}

interface CheckSlotProps {
	readonly value: SearchInputValidation | undefined;
	readonly rowIndex: number;
	readonly summaryContext: PredicateSummaryContext;
	readonly onChange: (next: SearchInputValidation | undefined) => void;
	readonly onEditRule: () => void;
}

function CheckSlot({
	value,
	rowIndex,
	summaryContext,
	onChange,
	onEditRule,
}: CheckSlotProps) {
	const [messageError, setMessageError] = useState<string | null>(null);
	return (
		<FieldRow
			label="Check on the answer"
			hint={
				value === undefined
					? "One rule an answer must pass before the search runs"
					: "Checked in the browser app once an answer is given. On a phone the search runs either way"
			}
		>
			{value === undefined ? (
				<Button
					type="button"
					onClick={() => {
						onChange({
							rule: firstComparisonDefault({
								...summaryContextToEditContext(summaryContext),
								caseDataScope: "global",
							}),
							message: SEARCH_INPUT_CHECK_SEED_MESSAGE,
						});
						onEditRule();
					}}
					variant="ghost"
					className="nova-add-slot w-full"
					aria-label={`Add a check for search field ${rowIndex + 1}`}
				>
					<Icon icon={tablerPlus} width="13" height="13" />
					<span>Add check</span>
				</Button>
			) : (
				<div className="space-y-3 rounded-xl border border-white/[0.06] bg-nova-deep/30 p-3">
					<div>
						<p className="text-[13px] leading-relaxed text-nova-text-secondary">
							{summarizeFilter(value.rule, summaryContext) ??
								"Every answer passes, until the rule is edited"}
						</p>
						<Button
							data-condition-origin
							type="button"
							variant="outline"
							onClick={onEditRule}
							className="mt-3 w-full"
						>
							Edit rule
						</Button>
					</div>
					<div className="flex flex-col gap-2">
						<div className="text-[13px] font-medium leading-5 text-nova-text-secondary">
							Message when the check fails
						</div>
						<BlurCommitTextInput
							value={value.message}
							onCommit={(message) => {
								if (message === "") {
									setMessageError(
										"Enter the message people read when the check fails",
									);
									return;
								}
								setMessageError(null);
								onChange({ rule: value.rule, message });
							}}
							ariaLabel={`Search field ${rowIndex + 1} check message`}
						/>
						{messageError !== null && <InlineError errors={[messageError]} />}
					</div>
					<Button
						type="button"
						onClick={() => onChange(undefined)}
						variant="destructive"
						className="w-full px-3 text-[14px]"
						aria-label={`Remove the check for search field ${rowIndex + 1}`}
					>
						Remove check
					</Button>
				</div>
			)}
		</FieldRow>
	);
}

/** The seed context for a Search-screen condition: every named sibling is
 *  readable, case data is not (nothing has been selected yet). */
function summaryContextToEditContext(
	context: PredicateSummaryContext,
): Omit<PredicateEditContext, "caseDataScope"> {
	return {
		caseTypes: context.caseTypes ?? [],
		currentCaseType: context.currentCaseType ?? "",
		knownInputs: context.knownInputs ?? [],
	};
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
		case "fixed-location":
		case "owner-location-at-level":
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
	readonly hint?: string | undefined;
	readonly required?: SearchInputRequired | undefined;
	readonly validation?: SearchInputValidation | undefined;
	readonly options?: LookupOptionsSource;
}

/** The slots every visible prompt carries beside its widget. */
function visibleSlotsOf(value: VisibleSearchInputDef): {
	readonly hint?: string;
	readonly required?: SearchInputRequired;
	readonly validation?: SearchInputValidation;
} {
	return {
		...(value.hint === undefined ? {} : { hint: value.hint }),
		...(value.required === undefined ? {} : { required: value.required }),
		...(value.validation === undefined ? {} : { validation: value.validation }),
	};
}

function rebuildRow(
	value: VisibleSearchInputDef,
	patch: RowPatch,
): VisibleSearchInputDef {
	const type = patch.type ?? value.type;
	const name = patch.name ?? value.name;
	const label = patch.label ?? value.label;
	const hint = "hint" in patch ? patch.hint : value.hint;
	const required = "required" in patch ? patch.required : value.required;
	const validation =
		"validation" in patch ? patch.validation : value.validation;
	const visible = {
		...(hint === undefined ? {} : { hint }),
		...(required === undefined ? {} : { required }),
		...(validation === undefined ? {} : { validation }),
	};
	const dflt = "default" in patch ? patch.default : searchInputDefault(value);
	// A choice widget's list rides along whenever the target is still a choice
	// widget; every other widget drops it. The type picker stages a choice
	// widget until a list exists, so a select without options never reaches here.
	const options = isSelectSearchInputType(type)
		? (patch.options ?? searchInputOptions(value))
		: undefined;
	if (isSelectSearchInputType(type) && options === undefined) {
		throw new Error(
			"A choice search field cannot be rebuilt without its lookup source.",
		);
	}
	if (value.kind === "simple") {
		const property = patch.property ?? value.property;
		const via = "via" in patch ? patch.via : value.via;
		const mode = "mode" in patch ? patch.mode : value.mode;
		if (type === "date-range") {
			return simpleSearchInputDef(value.uuid, name, label, type, property, {
				...visible,
				via,
				mode: { kind: "range" },
			});
		}
		if (isSelectSearchInputType(type) && options !== undefined) {
			return simpleSearchInputDef(value.uuid, name, label, type, property, {
				...visible,
				via,
				options,
				default: dflt,
			});
		}
		return simpleSearchInputDef(value.uuid, name, label, type, property, {
			...visible,
			via,
			...(mode !== undefined && mode.kind !== "range" ? { mode } : {}),
			default: dflt,
		});
	}
	if (type === "date-range") {
		return advancedSearchInputDef(
			value.uuid,
			name,
			label,
			type,
			value.predicate,
			visible,
		);
	}
	return advancedSearchInputDef(
		value.uuid,
		name,
		label,
		type,
		value.predicate,
		{
			...visible,
			default: dflt,
			...(options === undefined ? {} : { options }),
		},
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
	/** Why a multiple-choice widget is withheld from this row, when it is:
	 *  the commit gate's own reason, shown on the disabled item. */
	readonly multiSelectRefusal?: string;
	readonly rowIndex: number;
	readonly triggerRef: RefObject<HTMLButtonElement | null>;
}

function TypePicker({
	value,
	onChange,
	propertyDataType,
	multiSelectRefusal,
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
						const refusal =
							t === "multi-select" ? multiSelectRefusal : undefined;
						const admitted =
							refusal === undefined &&
							(propertyDataType === undefined ||
								(SEARCH_INPUT_TYPE_PROPERTY_TYPES[t]?.includes(
									propertyDataType,
								) ??
									true));
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
											: (refusal ??
												"This field type doesn't work with this information")}
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
	readonly value: VisibleSearchInputDef;
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
