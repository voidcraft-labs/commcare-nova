// components/builder/case-list-config/inspector/SearchInputEditor.tsx
//
// Inspector body for one search field. ONE view serves every author:
// Label → what it searches → how the field looks → how it matches →
// what it starts with → its reference name. There is no separate
// "advanced mode" — writing custom matching logic is just the last
// choice in the Match picker, and picking any standard match brings
// the standard controls back.
//
// Under the hood the schema still splits into two arms (`simple`
// carries `(property, mode, via)`; `advanced` carries a predicate
// AST), but that split is storage shape, not UI shape. The Match
// picker is the only place the two arms meet:
//
//   - picking "Custom condition" converts to the advanced arm,
//     seeding `property = typed value` so the author edits the
//     behavior they already had;
//   - picking a standard match converts back, recovering the
//     property the condition was anchored on when it still has the
//     round-trip shape.
//
// Inline diagnostics (empty / duplicate names, empty labels, unbound
// or dangling properties, type-coupling mismatches) come from the
// shared `searchInputResolution` derivation — the same source the
// search canvas's error badges and the workspace's preview gate
// read, so the three surfaces can't disagree.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerExclamationCircle from "@iconify-icons/tabler/exclamation-circle";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerWand from "@iconify-icons/tabler/wand";
import { useMemo, useRef } from "react";
import {
	CONSOLE_MENU_ITEM_MIN,
	CONSOLE_TRIGGER_CLS,
	RemoveRow,
	SegmentedRow,
} from "@/components/builder/inspector/inspectorChrome";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import {
	buildValidityIndex,
	PredicateEditProvider,
} from "@/components/builder/shared/editorContext";
import { PredicateCardEditor } from "@/components/builder/shared/PredicateCardEditor";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { InlineError } from "@/components/builder/shared/primitives/CardShell";
import {
	advancedSearchInputDef,
	applicableSearchModes,
	type CaseProperty,
	type CasePropertyDataType,
	type CaseType,
	DEFAULT_SEARCH_MODE_KIND,
	effectiveDataType,
	type MultiSelectQuantifier,
	SEARCH_INPUT_TYPE_PROPERTY_TYPES,
	SEARCH_INPUT_TYPES,
	SEARCH_MODE_PROPERTY_TYPES,
	type SearchInputDef,
	type SearchInputMode,
	type SearchInputType,
	type SimpleSearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	type Predicate,
	type RelationPath,
	relationStep,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import {
	buildMode,
	constraintForDefault,
	effectiveModeKind,
	NO_SEARCH_INPUTS,
	type PropertyState,
	type ResolvedRow,
	recoverAnchoredProperty,
	resolveDestinationCaseType,
	resolveRows,
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
	/** Position of `value` within `siblings` — drives the duplicate-
	 *  name diagnostic and aria labels. */
	readonly index: number;
	/** The full search-input list. Sibling names feed the duplicate
	 *  check and the `input(...)` references the inner editors may
	 *  resolve. */
	readonly siblings: readonly SearchInputDef[];
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly onChange: (next: SearchInputDef) => void;
	readonly onRemove: () => void;
}

/** Where a simple row's property lives — this case, the parent case,
 *  or a non-canonical relation walk authored elsewhere (chat, MCP). */
type BindingScope = "self" | "parent" | "custom";

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
	onChange,
	onRemove,
}: SearchInputEditorProps) {
	const resolved: ResolvedRow = useMemo(() => {
		const rows = resolveRows(siblings, caseTypes, currentCaseType);
		return (
			rows[index] ?? {
				nameState: { kind: "ok" } as const,
				labelEmpty: value.label === "",
				propertyState: { kind: "ok" } as const,
				typeCouplingErrors: [] as readonly string[],
			}
		);
	}, [siblings, index, caseTypes, currentCaseType, value.label]);

	// Every named row is in scope — the edited row included. A custom
	// condition is keyed to its OWN input via the when-input-present
	// envelope `seedCustomCondition` produces, so the row must resolve
	// its own `input(name)`. Matches the validator's full-list
	// `moduleTypeContext`; see `searchInputDecls`.
	const knownInputs = useMemo(
		() => searchInputDecls(siblings, caseTypes, currentCaseType),
		[siblings, caseTypes, currentCaseType],
	);

	// ── Common-slot mutators ──

	const setName = (name: string) => onChange(rebuildRow(value, { name }));
	const setLabel = (label: string) => onChange(rebuildRow(value, { label }));
	const setType = (type: SearchInputType) => {
		// Only the simple arm carries a `mode`. When type changes on
		// the simple arm and the new type narrows the admitted modes
		// past the current one, drop the mode so the saved doc stays
		// admissible against `applicableSearchModes(type)`.
		if (value.kind === "simple") {
			const applicable = applicableSearchModes(type);
			const keepMode =
				value.mode !== undefined && applicable.includes(value.mode.kind);
			onChange(
				rebuildRow(value, {
					type,
					...(keepMode ? {} : { mode: undefined }),
				}),
			);
			return;
		}
		onChange(rebuildRow(value, { type }));
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
	 * derived from the previous property — hand-typed values are the
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
			label?: string;
			name?: string;
		} = { property, via };

		const destination = resolveDestinationCaseType(
			caseTypes,
			via,
			currentCaseType,
		);
		const propertyDef = caseTypes
			.find((c) => c.name === destination)
			?.properties.find((p) => p.name === property);
		if (propertyDef !== undefined) {
			const dataType = effectiveDataType(propertyDef);
			const typeAllowed =
				SEARCH_INPUT_TYPE_PROPERTY_TYPES[value.type]?.includes(dataType) ??
				true;
			const nextType = typeAllowed
				? value.type
				: widgetTypeForProperty(propertyDef);
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

		if (
			value.label === "" ||
			value.label === labelFromProperty(value.property)
		) {
			patch.label = labelFromProperty(property);
		}
		const oldBase =
			value.property === "" ? "" : xmlNameFromProperty(value.property);
		const nameDerived =
			value.name === "" ||
			(oldBase !== "" &&
				(value.name === oldBase ||
					new RegExp(`^${oldBase}_\\d+$`).test(value.name)));
		if (nameDerived) {
			patch.name = uniqueInputName(
				xmlNameFromProperty(property),
				siblings.filter((s) => s.uuid !== value.uuid),
			);
		}

		onChange(rebuildRow(value, patch));
	};

	/** Store the picked match. The type's own default stores as an
	 *  absent slot so the saved doc stays minimal; everything else
	 *  stores explicitly. */
	const setModeKind = (kind: SearchInputMode["kind"]) => {
		if (value.kind !== "simple") return;
		const isParameterless = kind !== "multi-select-contains";
		const mode =
			isParameterless && kind === DEFAULT_SEARCH_MODE_KIND[value.type]
				? undefined
				: buildMode(kind);
		onChange(rebuildRow(value, { mode }));
	};
	const setQuantifier = (quantifier: MultiSelectQuantifier) => {
		if (value.kind !== "simple") return;
		onChange(
			rebuildRow(value, {
				mode: buildMode("multi-select-contains", quantifier),
			}),
		);
	};

	// ── Advanced-arm mutator ──

	const setPredicate = (next: Predicate) => {
		if (value.kind !== "advanced") return;
		onChange(
			advancedSearchInputDef(
				value.uuid,
				value.name,
				value.label,
				value.type,
				next,
				{ default: value.default },
			),
		);
	};

	// ── Match-picker arm conversion ──
	//
	// "Custom condition" replaces the row with the advanced arm,
	// seeding `property = typed value` (the behavior the row already
	// had) so the author edits forward rather than starting blank.
	// The `via` slot drops — the condition AST encodes relation walks
	// inside its own structure when needed.
	//
	// Picking a standard match from the custom state converts back,
	// recovering the property when the condition is still anchored on
	// a self property (the round-trip shape the seed produces).

	const toCustomCondition = () => {
		if (value.kind !== "simple") return;
		onChange(
			advancedSearchInputDef(
				value.uuid,
				value.name,
				value.label,
				value.type,
				seedCustomCondition(value, currentCaseType),
				{ default: value.default },
			),
		);
	};

	const toStandardMode = (kind: SearchInputMode["kind"]) => {
		if (value.kind !== "advanced") return;
		// Land a WORKING row, same bar as the add seed — an unbound
		// row matches nothing at runtime. Recover the condition's
		// anchor property when it has the round-trip shape; otherwise
		// seed the way a fresh field would.
		const ct = caseTypes.find((c) => c.name === currentCaseType);
		const used = new Set(
			siblings.flatMap((s) =>
				s.kind === "simple" && s.uuid !== value.uuid && s.property !== ""
					? [s.property]
					: [],
			),
		);
		const recovered = recoverAnchoredProperty(value.predicate);
		const propertyDef =
			(recovered !== undefined
				? ct?.properties.find((p) => p.name === recovered)
				: undefined) ?? pickSeedProperty(ct, used);
		const type =
			propertyDef !== undefined
				? widgetTypeForProperty(propertyDef)
				: value.type;
		const dataType =
			propertyDef !== undefined ? effectiveDataType(propertyDef) : undefined;
		const kindAdmitted =
			applicableSearchModes(type).includes(kind) &&
			(dataType === undefined ||
				(SEARCH_MODE_PROPERTY_TYPES[kind]?.includes(dataType) ?? true));
		const isParameterless = kind !== "multi-select-contains";
		const mode = !kindAdmitted
			? undefined
			: isParameterless && kind === DEFAULT_SEARCH_MODE_KIND[type]
				? undefined
				: buildMode(kind);
		onChange(
			simpleSearchInputDef(
				value.uuid,
				value.name,
				value.label,
				type,
				propertyDef?.name ?? recovered ?? "",
				{ default: value.default, ...(mode !== undefined ? { mode } : {}) },
			),
		);
	};

	const emptyValidityIndex = useMemo(() => buildValidityIndex([]), []);

	/* The bound property's effective data type — the Field type and
	 * Match pickers use it to disable choices the validator would
	 * reject (fuzzy on a number, say) instead of letting the author
	 * pick into an error. */
	const propertyDataType = useMemo<CasePropertyDataType | undefined>(() => {
		if (value.kind !== "simple") return undefined;
		const destination = resolveDestinationCaseType(
			caseTypes,
			value.via,
			currentCaseType,
		);
		const def = caseTypes
			.find((c) => c.name === destination)
			?.properties.find((p) => p.name === value.property);
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
			validityIndex={emptyValidityIndex}
		>
			<div className="space-y-5">
				<FieldRow label="Label" hint="Shown above the field.">
					<BlurCommitTextInput
						value={value.label}
						onCommit={setLabel}
						placeholder="Client name"
						ariaLabel={`Search field ${index + 1} label`}
					/>
					{resolved.labelEmpty && (
						<InlineError errors={["Give the field a label."]} />
					)}
				</FieldRow>

				{value.kind === "simple" && (
					<FieldRow label="Searches">
						<BindingPicker
							row={value}
							caseTypes={caseTypes}
							currentCaseType={currentCaseType}
							onPick={setBinding}
							rowIndex={index}
						/>
						<InlineError
							errors={propertyErrors(resolved.propertyState, value.property)}
						/>
					</FieldRow>
				)}

				<FieldRow label="Field type">
					<TypePicker
						value={value.type}
						onChange={setType}
						propertyDataType={propertyDataType}
						rowIndex={index}
					/>
				</FieldRow>

				<FieldRow
					label="Match"
					hint={
						value.kind === "advanced"
							? "The condition below decides which cases match."
							: SEARCH_MODE_DESCRIPTIONS[effectiveModeKind(value)]
					}
				>
					<MatchPicker
						value={value}
						propertyDataType={propertyDataType}
						invalid={resolved.typeCouplingErrors.length > 0}
						rowIndex={index}
						onPickMode={value.kind === "simple" ? setModeKind : toStandardMode}
						onPickCustom={toCustomCondition}
					/>
					{value.kind === "simple" &&
						value.mode?.kind === "multi-select-contains" && (
							<SegmentedRow
								legend="How many of the chosen options a case needs"
								options={[
									{ value: "any", label: "Any of them" },
									{ value: "all", label: "All of them" },
								]}
								value={value.mode.quantifier}
								onChange={setQuantifier}
							/>
						)}
				</FieldRow>

				{value.kind === "advanced" && (
					<FieldRow
						label="Condition"
						hint="The typed value is available to the condition as this field."
					>
						<div className="rounded-lg border border-white/[0.04] bg-nova-deep/30 p-2.5">
							<PredicateCardEditor
								value={value.predicate}
								onChange={setPredicate}
								caseTypes={caseTypes}
								currentCaseType={currentCaseType}
								knownInputs={knownInputs}
							/>
						</div>
					</FieldRow>
				)}

				<InlineError errors={resolved.typeCouplingErrors} />

				<DefaultValueSlot
					value={value.default}
					inputType={value.type}
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					rowIndex={index}
					onChange={setDefault}
				/>

				<FieldRow
					label="Reference name"
					hint="How conditions and other fields refer to this one."
				>
					<BlurCommitTextInput
						value={value.name}
						onCommit={setName}
						placeholder="client_name"
						ariaLabel={`Search field ${index + 1} reference name`}
						monospace
					/>
					{resolved.nameState.kind === "empty" && (
						<InlineError errors={["Give the field a reference name."]} />
					)}
					{duplicateOf !== undefined && (
						<InlineError
							errors={[
								`Already used by “${duplicateOf.label || duplicateOf.name}” — names must be unique.`,
							]}
						/>
					)}
				</FieldRow>

				<RemoveRow label="Remove Search Field" onClick={onRemove} />
			</div>
		</PredicateEditProvider>
	);
}

// ── Field chrome ──────────────────────────────────────────────────

/** Etched console label + control + quiet hint. */
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
		<div className="space-y-2">
			<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted">
				{label}
			</div>
			{children}
			{hint !== undefined && (
				<p className="text-[11px] leading-relaxed text-nova-text-muted">
					{hint}
				</p>
			)}
		</div>
	);
}

/** The person-to-person line under an unbound / dangling property —
 *  names what's wrong AND what it costs at runtime. */
function propertyErrors(
	state: PropertyState,
	property: string,
): readonly string[] {
	switch (state.kind) {
		case "ok":
			return [];
		case "empty":
			return ["Pick a property — until then, this field matches nothing."];
		case "dangling":
			return [
				`"${property}" is not a property of the ${state.destination} case type — pick one from the list.`,
			];
	}
}

// ── Binding picker — property + where it lives, one control ───────

interface BindingPickerProps {
	readonly row: SimpleSearchInputDef;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly onPick: (property: string, scope: "self" | "parent") => void;
	readonly rowIndex: number;
}

/**
 * One picker answers "what does this field search?" — the case's own
 * properties, and the parent case's when the case type has a parent.
 * Picking a parent property carries the relation walk implicitly; no
 * separate control, no walk vocabulary.
 *
 * A row whose walk was authored elsewhere with a shape this picker
 * can't express (a child-case walk, a multi-step walk) keeps working
 * — the picker says so in plain words and offers the way back.
 */
function BindingPicker({
	row,
	caseTypes,
	currentCaseType,
	onPick,
	rowIndex,
}: BindingPickerProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const scope = classifyVia(row.via);
	const ct = caseTypes.find((c) => c.name === currentCaseType);
	const parentCt =
		ct?.parent_type !== undefined
			? caseTypes.find((c) => c.name === ct.parent_type)
			: undefined;

	if (scope === "custom") {
		return (
			<div className="flex items-center gap-3 w-full min-h-11 px-3 py-2 rounded-lg border border-white/[0.06] bg-nova-deep/30">
				<span className="flex-1 min-w-0">
					<span className="block text-[13px] text-nova-text font-mono truncate">
						{row.property || "—"}
					</span>
					<span className="block text-[11px] text-nova-text-muted">
						On a linked case, through a custom connection.
					</span>
				</span>
				<button
					type="button"
					onClick={() => onPick(row.property, "self")}
					className="shrink-0 px-3 min-h-11 text-xs rounded-lg border border-white/[0.08] text-nova-text-secondary hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				>
					Search This Case Instead
				</button>
			</div>
		);
	}

	const destination = scope === "parent" ? parentCt : ct;
	const selectedDef = destination?.properties.find(
		(p) => p.name === row.property,
	);
	const scopeLabel = scope === "parent" ? "On the parent case" : "On this case";

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Search field ${rowIndex + 1} property`}
				className={CONSOLE_TRIGGER_CLS}
			>
				<Icon
					icon={tablerDatabase}
					width="16"
					height="16"
					className="text-nova-violet-bright/80 shrink-0"
				/>
				<span className="flex-1 min-w-0 text-left">
					{row.property === "" ? (
						<span className="block text-nova-text-muted">Pick a property</span>
					) : (
						<>
							<span className="block font-mono text-nova-text truncate">
								{row.property}
							</span>
							<span className="block text-[11px] text-nova-text-muted truncate">
								{scopeLabel}
								{selectedDef !== undefined
									? ` · ${effectiveDataType(selectedDef)}`
									: ""}
							</span>
						</>
					)}
				</span>
				<Chevron />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<Menu.Popup
						className={`${MENU_POPUP_CLS} max-h-80 overflow-y-auto min-w-[16rem]`}
					>
						<PropertyGroup
							heading={`This Case — ${ct?.name ?? currentCaseType}`}
							properties={ct?.properties ?? []}
							isSelected={(p) => scope === "self" && p.name === row.property}
							onPick={(p) => onPick(p.name, "self")}
							roundTop
							roundBottom={parentCt === undefined}
						/>
						{parentCt !== undefined && (
							<PropertyGroup
								heading={`Parent Case — ${parentCt.name}`}
								properties={parentCt.properties}
								isSelected={(p) =>
									scope === "parent" && p.name === row.property
								}
								onPick={(p) => onPick(p.name, "parent")}
								roundTop={false}
								roundBottom
							/>
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

function PropertyGroup({
	heading,
	properties,
	isSelected,
	onPick,
	roundTop,
	roundBottom,
}: {
	readonly heading: string;
	readonly properties: readonly CaseProperty[];
	readonly isSelected: (p: CaseProperty) => boolean;
	readonly onPick: (p: CaseProperty) => void;
	readonly roundTop: boolean;
	readonly roundBottom: boolean;
}) {
	return (
		<Menu.Group>
			<Menu.GroupLabel
				className={`px-3 pt-2.5 pb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-nova-text-muted ${roundTop ? "rounded-t-xl" : ""}`}
			>
				{heading}
			</Menu.GroupLabel>
			{properties.length === 0 && (
				<div className={`${MENU_ITEM_BASE} text-nova-text-muted italic`}>
					No properties yet
				</div>
			)}
			{properties.map((p, i) => {
				const active = isSelected(p);
				const isLast = roundBottom && i === properties.length - 1;
				return (
					<Menu.Item
						key={p.name}
						onClick={() => onPick(p)}
						className={`${isLast ? "rounded-b-xl" : ""} ${MENU_ITEM_CLS} ${CONSOLE_MENU_ITEM_MIN} ${
							active ? "text-nova-violet-bright bg-nova-violet/10" : ""
						}`}
					>
						<span className="flex-1 text-left min-w-0 font-mono truncate">
							{p.name}
						</span>
						<span
							className={`text-[10px] uppercase tracking-wider ${
								active ? "text-nova-violet-bright/60" : "text-nova-text-muted"
							}`}
						>
							{effectiveDataType(p)}
						</span>
						{active && (
							<Icon
								icon={tablerCheck}
								width="14"
								height="14"
								className="text-nova-violet-bright"
							/>
						)}
					</Menu.Item>
				);
			})}
		</Menu.Group>
	);
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
	readonly property?: string | undefined;
	readonly via?: RelationPath | undefined;
	readonly mode?: SearchInputMode | undefined;
	readonly default?: ValueExpression | undefined;
}

function rebuildRow(value: SearchInputDef, patch: RowPatch): SearchInputDef {
	if (value.kind === "simple") {
		const property = "property" in patch ? patch.property : value.property;
		const via = "via" in patch ? patch.via : value.via;
		const mode = "mode" in patch ? patch.mode : value.mode;
		const dflt = "default" in patch ? patch.default : value.default;
		return simpleSearchInputDef(
			value.uuid,
			patch.name ?? value.name,
			patch.label ?? value.label,
			patch.type ?? value.type,
			property ?? "",
			{ via, mode, default: dflt },
		);
	}
	const dflt = "default" in patch ? patch.default : value.default;
	return advancedSearchInputDef(
		value.uuid,
		patch.name ?? value.name,
		patch.label ?? value.label,
		patch.type ?? value.type,
		value.predicate,
		{ default: dflt },
	);
}

// ── Field-type picker ─────────────────────────────────────────────

interface TypePickerProps {
	readonly value: SearchInputType;
	readonly onChange: (next: SearchInputType) => void;
	/** Effective data type of the bound property (simple arm only) —
	 *  gates which field types are selectable, mirroring the Match
	 *  picker. `undefined` (custom condition / unresolved property)
	 *  gates nothing, matching the validator's skip. */
	readonly propertyDataType: CasePropertyDataType | undefined;
	readonly rowIndex: number;
}

function TypePicker({
	value,
	onChange,
	propertyDataType,
	rowIndex,
}: TypePickerProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Search field ${rowIndex + 1} type: ${SEARCH_INPUT_TYPE_LABELS[value]}`}
				className={CONSOLE_TRIGGER_CLS}
			>
				<Icon
					icon={SEARCH_INPUT_TYPE_ICONS[value]}
					width="16"
					height="16"
					className="text-nova-violet-bright/80 shrink-0"
				/>
				<span className="flex-1 min-w-0 text-left">
					<span className="block text-nova-text">
						{SEARCH_INPUT_TYPE_LABELS[value]}
					</span>
					<span className="block text-[11px] text-nova-text-muted truncate">
						{SEARCH_INPUT_TYPE_DESCRIPTIONS[value]}
					</span>
				</span>
				<Chevron />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<Menu.Popup className={`${MENU_POPUP_CLS} min-w-[13rem]`}>
						{SEARCH_INPUT_TYPES.map((t, i) => {
							const isActive = t === value;
							// Property-level gate — a field the bound property's
							// data type can't run (a calendar over a text
							// property, say) is disabled with the reason rather
							// than selectable into a validation error.
							const admitted =
								propertyDataType === undefined ||
								(SEARCH_INPUT_TYPE_PROPERTY_TYPES[t]?.includes(
									propertyDataType,
								) ??
									true);
							const last = SEARCH_INPUT_TYPES.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							return (
								<Menu.Item
									key={t}
									disabled={!admitted}
									onClick={() => onChange(t)}
									className={`${corners} ${MENU_ITEM_CLS} ${CONSOLE_MENU_ITEM_MIN} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									} ${admitted ? "" : "opacity-45"}`}
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
											className={`text-[11px] ${
												isActive
													? "text-nova-violet-bright/60"
													: "text-nova-text-muted"
											}`}
										>
											{admitted
												? SEARCH_INPUT_TYPE_DESCRIPTIONS[t]
												: `Not available for ${propertyDataType} properties.`}
										</div>
									</span>
									{isActive && (
										<Icon
											icon={tablerCheck}
											width="14"
											height="14"
											className="text-nova-violet-bright"
										/>
									)}
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

// ── Match picker — standard modes + the custom arm, one menu ──────

interface MatchPickerProps {
	readonly value: SearchInputDef;
	/** Effective data type of the bound property — gates which modes
	 *  are selectable. `undefined` (unresolved property / custom
	 *  condition) gates nothing, matching the validator's skip. */
	readonly propertyDataType: CasePropertyDataType | undefined;
	readonly invalid: boolean;
	readonly rowIndex: number;
	readonly onPickMode: (kind: SearchInputMode["kind"]) => void;
	readonly onPickCustom: () => void;
}

function MatchPicker({
	value,
	propertyDataType,
	invalid,
	rowIndex,
	onPickMode,
	onPickCustom,
}: MatchPickerProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const isCustom = value.kind === "advanced";
	const applicable = applicableSearchModes(value.type);
	const effectiveKind =
		value.kind === "simple" ? effectiveModeKind(value) : null;
	const triggerLabel = isCustom
		? "Custom Condition"
		: SEARCH_MODE_LABELS[effectiveKind ?? "exact"];

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Search field ${rowIndex + 1} match: ${triggerLabel}`}
				className={`${CONSOLE_TRIGGER_CLS} ${
					invalid ? "border-nova-rose/40 hover:border-nova-rose/60" : ""
				}`}
			>
				<span className="flex-1 min-w-0 text-left flex items-center gap-2">
					<span className={invalid ? "text-nova-rose/90" : "text-nova-text"}>
						{triggerLabel}
					</span>
					{invalid && (
						<Icon
							icon={tablerExclamationCircle}
							width="14"
							height="14"
							className="text-nova-rose/80"
							aria-hidden="true"
						/>
					)}
				</span>
				<Chevron />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<Menu.Popup className={`${MENU_POPUP_CLS} min-w-[16rem]`}>
						{applicable.map((kind, i) => {
							const isActive = !isCustom && effectiveKind === kind;
							// Property-level gate — picking a match the bound
							// property's data type can't run would only land the
							// row in a validation error, so the item is disabled
							// and says why instead.
							const admitted =
								propertyDataType === undefined ||
								(SEARCH_MODE_PROPERTY_TYPES[kind]?.includes(propertyDataType) ??
									true);
							return (
								<Menu.Item
									key={kind}
									disabled={!admitted}
									onClick={() => onPickMode(kind)}
									className={`${i === 0 ? "rounded-t-xl" : ""} ${MENU_ITEM_CLS} ${CONSOLE_MENU_ITEM_MIN} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									} ${admitted ? "" : "opacity-45"}`}
								>
									<span className="flex-1 text-left">
										<div>{SEARCH_MODE_LABELS[kind]}</div>
										<div
											className={`text-[11px] ${
												isActive
													? "text-nova-violet-bright/60"
													: "text-nova-text-muted"
											}`}
										>
											{admitted
												? SEARCH_MODE_DESCRIPTIONS[kind]
												: `Not available for ${propertyDataType} properties.`}
										</div>
									</span>
									{isActive && (
										<Icon
											icon={tablerCheck}
											width="14"
											height="14"
											className="text-nova-violet-bright"
										/>
									)}
								</Menu.Item>
							);
						})}
						<Menu.Item
							onClick={onPickCustom}
							className={`rounded-b-xl border-t border-white/[0.06] ${MENU_ITEM_CLS} ${CONSOLE_MENU_ITEM_MIN} ${
								isCustom ? "text-nova-violet-bright bg-nova-violet/10" : ""
							}`}
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
								<div>Custom Condition</div>
								<div
									className={`text-[11px] ${
										isCustom
											? "text-nova-violet-bright/60"
											: "text-nova-text-muted"
									}`}
								>
									Write the matching logic yourself — any properties, any
									comparison.
								</div>
							</span>
							{isCustom && (
								<Icon
									icon={tablerCheck}
									width="14"
									height="14"
									className="text-nova-violet-bright"
								/>
							)}
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

// ── Default-value slot ────────────────────────────────────────────

interface DefaultValueSlotProps {
	readonly value: ValueExpression | undefined;
	readonly inputType: SearchInputType;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly rowIndex: number;
	readonly onChange: (next: ValueExpression | undefined) => void;
}

function DefaultValueSlot({
	value,
	inputType,
	caseTypes,
	currentCaseType,
	rowIndex,
	onChange,
}: DefaultValueSlotProps) {
	const constraint = constraintForDefault(inputType);
	if (value === undefined) {
		return (
			<button
				type="button"
				onClick={() => onChange(seedDefaultExpression(inputType))}
				className="w-full inline-flex items-center justify-center gap-2 px-3 min-h-11 text-[13px] rounded-lg border border-dashed border-white/[0.10] text-nova-text-muted hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				aria-label={`Add a default value for search field ${rowIndex + 1}`}
			>
				<Icon icon={tablerPlus} width="13" height="13" />
				<span>Add a Default Value</span>
			</button>
		);
	}
	return (
		<FieldRow
			label="Default value"
			hint="The field starts out filled with this — anyone can change it."
		>
			<div className="rounded-lg border border-white/[0.04] bg-nova-deep/30 p-2.5 space-y-2">
				{/* Forbids input refs — the default fills the field before
				    the search screen opens. See NO_SEARCH_INPUTS. */}
				<ExpressionCardEditor
					value={value}
					onChange={onChange}
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					knownInputs={NO_SEARCH_INPUTS}
					constraint={constraint}
				/>
				<button
					type="button"
					onClick={() => onChange(undefined)}
					className="w-full min-h-11 px-3 text-[13px] rounded-lg border border-white/[0.06] text-nova-text-muted hover:text-nova-rose hover:border-nova-rose/40 transition-colors cursor-pointer"
					aria-label={`Remove the default value for search field ${rowIndex + 1}`}
				>
					Remove Default Value
				</button>
			</div>
		</FieldRow>
	);
}

// ── Helpers ───────────────────────────────────────────────────────

function Chevron() {
	return (
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
	);
}
