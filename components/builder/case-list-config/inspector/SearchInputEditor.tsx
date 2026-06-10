// components/builder/case-list-config/inspector/SearchInputEditor.tsx
//
// Properties editor for one `SearchInputDef` — the inspector body
// behind a selected search input on the search canvas. The schema's
// discriminated union splits authoring into two arms:
//
//   - `kind: "simple"` — `(property, mode, via)` triple. The wire
//     layer derives the predicate from the targeted property + the
//     mode + the optional relation walk.
//   - `kind: "advanced"` — author-defined `predicate` AST. The wire
//     layer emits the predicate verbatim; this arm mounts a
//     `PredicateCardEditor`.
//
// A "Convert to advanced" / "Convert to simple" affordance flips the
// discriminator. Converting to advanced seeds the predicate from the
// row's current property (or `match-all()` when none); converting
// back drops the predicate and re-exposes the property + mode
// pickers. Common slots — `uuid`, `name`, `label`, `type`,
// `default?` — live on both arms.
//
// Inline diagnostics (empty / duplicate names, empty labels, simple-
// arm type-coupling mismatches) come from the shared
// `searchInputResolution` derivation — the same source the search
// canvas's error badges and the workspace's preview gate read, so
// the three surfaces can't disagree.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerArrowsExchange from "@iconify-icons/tabler/arrows-exchange";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerExclamationCircle from "@iconify-icons/tabler/exclamation-circle";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useMemo, useRef } from "react";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import {
	buildValidityIndex,
	PredicateEditProvider,
} from "@/components/builder/shared/editorContext";
import { PredicateCardEditor } from "@/components/builder/shared/PredicateCardEditor";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { InlineError } from "@/components/builder/shared/primitives/CardShell";
import { PropertyRefPicker } from "@/components/builder/shared/primitives/PropertyRefPicker";
import { RelationPathBuilder } from "@/components/builder/shared/primitives/RelationPathBuilder";
import {
	advancedSearchInputDef,
	applicableSearchModes,
	type CasePropertyDataType,
	type CaseType,
	DEFAULT_SEARCH_MODE_KIND,
	effectiveDataType,
	fuzzyMode,
	type MultiSelectQuantifier,
	multiSelectContainsMode,
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
	literal,
	matchAll,
	type Predicate,
	prop,
	type RelationPath,
	type SearchInputDecl,
	selfPath,
	term,
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
	computeKnownInputsForRow,
	expectedTypeForDefault,
	type PropertyState,
	type ResolvedRow,
	resolveDestinationCaseType,
	resolveRows,
	SEARCH_INPUT_TYPE_DESCRIPTIONS,
	SEARCH_INPUT_TYPE_ICONS,
	SEARCH_INPUT_TYPE_LABELS,
	SEARCH_MODE_DESCRIPTIONS,
	SEARCH_MODE_LABELS,
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

/**
 * Stacked properties editor for one search input. Field order walks
 * from what workers see (label) to wire identity (name) to widget
 * shape (type / property / mode) to behavior (default value).
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

	const knownInputs = useMemo(
		() => computeKnownInputsForRow(siblings, index, caseTypes, currentCaseType),
		[siblings, index, caseTypes, currentCaseType],
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

	// ── Simple-arm mutators (no-op when row is advanced) ──

	const setProperty = (property: string) => {
		if (value.kind !== "simple") return;
		// The rest of the row follows the property. The widget: picking
		// a date property on a text input would otherwise strand the row
		// in a type-coupling error the author must untangle by hand —
		// and at runtime a mismatched widget silently matches nothing.
		// The label and name: only while they still read as derived from
		// the previous property — a hand-typed label is the author's and
		// is never overwritten.
		const patch: {
			property: string;
			type?: SearchInputType;
			mode?: SearchInputMode | undefined;
			label?: string;
			name?: string;
		} = { property };

		const destination = resolveDestinationCaseType(
			caseTypes,
			value.via,
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
					nextType === "text" && fuzzyAdmitted ? fuzzyMode() : undefined;
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
	const setVia = (via: RelationPath) => {
		if (value.kind !== "simple") return;
		onChange(rebuildRow(value, { via }));
	};
	const setMode = (mode: SearchInputMode | undefined) => {
		if (value.kind !== "simple") return;
		onChange(rebuildRow(value, { mode }));
	};

	// ── Advanced-arm mutator (no-op when row is simple) ──

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

	// ── Arm conversion ──
	//
	// "Convert to advanced" replaces the row with an advanced arm,
	// seeding the predicate from the simple arm's current property
	// (when set) or `match-all()` otherwise. The `via` slot drops here
	// — the predicate AST encodes relation walks inside its own
	// structure when needed.
	//
	// "Convert to simple" replaces the row with a simple arm, dropping
	// the predicate. The new arm's property is empty (the user picks
	// one); mode and via reset to default. The predicate's structure
	// isn't reverse-engineered into a (property, mode, via) triple —
	// the conversion is a fresh start on the simple arm.

	const convertToAdvanced = () => {
		if (value.kind !== "simple") return;
		onChange(
			advancedSearchInputDef(
				value.uuid,
				value.name,
				value.label,
				value.type,
				seedAdvancedPredicate(value, currentCaseType),
				{ default: value.default },
			),
		);
	};
	const convertToSimple = () => {
		if (value.kind !== "advanced") return;
		// Land a WORKING row, same bar as the add seed — an unbound
		// simple row matches nothing at runtime. Recover the property
		// when the predicate is still anchored on a self property (the
		// round-trip shape `convertToAdvanced` seeds); otherwise re-seed
		// the way a fresh input would.
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
		const fuzzyAdmitted =
			propertyDef !== undefined &&
			(SEARCH_MODE_PROPERTY_TYPES.fuzzy?.includes(
				effectiveDataType(propertyDef),
			) ??
				true);
		onChange(
			simpleSearchInputDef(
				value.uuid,
				value.name,
				value.label,
				type,
				propertyDef?.name ?? "",
				{
					default: value.default,
					...(type === "text" && fuzzyAdmitted ? { mode: fuzzyMode() } : {}),
				},
			),
		);
	};

	const emptyValidityIndex = useMemo(() => buildValidityIndex([]), []);

	/* The bound property's effective data type — the mode picker uses
	 * it to disable modes the validator would reject (fuzzy on a
	 * geopoint, say) instead of letting the author pick into an error. */
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

	return (
		<PredicateEditProvider
			caseTypes={caseTypes}
			currentCaseType={currentCaseType}
			knownInputs={knownInputs}
			validityIndex={emptyValidityIndex}
		>
			<div className="space-y-4">
				<InspectorField label="Label" hint="Shown to workers above the field.">
					<BlurCommitTextInput
						value={value.label}
						onCommit={setLabel}
						placeholder="Display label"
						ariaLabel={`Search input ${index + 1} label`}
					/>
					{resolved.labelEmpty && (
						<InlineError errors={["Label is required."]} />
					)}
				</InspectorField>

				<InspectorField
					label="Name"
					hint="Wire identifier — other inputs and predicates reference it."
				>
					<BlurCommitTextInput
						value={value.name}
						onCommit={setName}
						placeholder="input_name"
						ariaLabel={`Search input ${index + 1} name`}
						monospace
					/>
					{resolved.nameState.kind === "empty" && (
						<InlineError errors={["Name is required."]} />
					)}
					{resolved.nameState.kind === "duplicate" && (
						<InlineError
							errors={[
								`Already used by search input ${resolved.nameState.firstIndex + 1}.`,
							]}
						/>
					)}
				</InspectorField>

				<InspectorField label="Type">
					<TypePicker
						value={value.type}
						onChange={setType}
						propertyDataType={propertyDataType}
						rowIndex={index}
					/>
				</InspectorField>

				{value.kind === "simple" ? (
					<SimpleArmBody
						row={value}
						rowIndex={index}
						currentCaseType={currentCaseType}
						typeCouplingInvalid={resolved.typeCouplingErrors.length > 0}
						propertyState={resolved.propertyState}
						propertyDataType={propertyDataType}
						onSetProperty={setProperty}
						onSetVia={setVia}
						onSetMode={setMode}
					/>
				) : (
					<AdvancedArmBody
						value={value.predicate}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						knownInputs={knownInputs}
						onChange={setPredicate}
					/>
				)}

				<InlineError errors={resolved.typeCouplingErrors} />

				<DefaultValueSlot
					value={value.default}
					inputType={value.type}
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					knownInputs={knownInputs}
					rowIndex={index}
					onChange={setDefault}
				/>

				<div className="flex items-center gap-2 pt-2 border-t border-nova-border">
					<ConvertArmButton
						kind={value.kind}
						onConvert={
							value.kind === "simple" ? convertToAdvanced : convertToSimple
						}
						rowIndex={index}
					/>
					<button
						type="button"
						onClick={onRemove}
						className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] rounded-md border border-white/[0.06] text-nova-text-muted hover:text-nova-rose hover:border-nova-rose/40 transition-colors cursor-pointer"
					>
						<Icon icon={tablerTrash} width="12" height="12" />
						<span>Remove input</span>
					</button>
				</div>
			</div>
		</PredicateEditProvider>
	);
}

// ── Inspector field chrome ────────────────────────────────────────

function InspectorField({
	label,
	hint,
	children,
}: {
	readonly label: string;
	readonly hint?: string;
	readonly children: React.ReactNode;
}) {
	return (
		<div className="space-y-1.5">
			<div className="text-[10px] uppercase tracking-widest text-nova-text-muted/70">
				{label}
			</div>
			{children}
			{hint !== undefined && (
				<p className="text-[10px] text-nova-text-muted/60">{hint}</p>
			)}
		</div>
	);
}

// ── Convert-arm button ────────────────────────────────────────────

interface ConvertArmButtonProps {
	readonly kind: SearchInputDef["kind"];
	readonly onConvert: () => void;
	readonly rowIndex: number;
}

/**
 * Single button that flips the row's discriminator. Label and aria
 * text adjust to the destination arm so the affordance reads as
 * "what you're switching to" rather than "what you're switching
 * from".
 */
function ConvertArmButton({
	kind,
	onConvert,
	rowIndex,
}: ConvertArmButtonProps) {
	const targetLabel = kind === "simple" ? "advanced" : "simple";
	return (
		<button
			type="button"
			onClick={onConvert}
			aria-label={`Convert search input ${rowIndex + 1} to ${targetLabel}`}
			title={`Convert to ${targetLabel}`}
			className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-text-muted hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
		>
			<Icon icon={tablerArrowsExchange} width="11" height="11" />
			<span>To {targetLabel}</span>
		</button>
	);
}

// ── Simple arm body ───────────────────────────────────────────────

interface SimpleArmBodyProps {
	readonly row: SimpleSearchInputDef;
	readonly rowIndex: number;
	readonly currentCaseType: string;
	readonly typeCouplingInvalid: boolean;
	readonly propertyState: PropertyState;
	readonly propertyDataType: CasePropertyDataType | undefined;
	readonly onSetProperty: (property: string) => void;
	readonly onSetVia: (via: RelationPath) => void;
	readonly onSetMode: (mode: SearchInputMode | undefined) => void;
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
			return ["Pick a property — an unbound input matches nothing."];
		case "dangling":
			return [
				`"${property}" is not a property of the ${state.destination} case type — pick one from the list.`,
			];
	}
}

/**
 * Body for `kind: "simple"` rows. Property picker (with relation
 * walk builder) + mode picker. The simple arm's `property` slot is
 * required by the schema — there's no escape hatch on this arm
 * (a property-less input belongs on the advanced arm).
 */
function SimpleArmBody({
	row,
	rowIndex,
	currentCaseType,
	typeCouplingInvalid,
	propertyState,
	propertyDataType,
	onSetProperty,
	onSetVia,
	onSetMode,
}: SimpleArmBodyProps) {
	const viaForBuilder = row.via ?? selfPath();
	return (
		<>
			<InspectorField label="Property">
				<div className="rounded-md border border-white/[0.04] bg-nova-deep/30 p-2 space-y-1.5">
					<PropertyRefPicker
						mode="property-only"
						value={prop(currentCaseType, row.property)}
						onChange={(nextRef) => onSetProperty(nextRef.property)}
						ariaLabel={`Search input ${rowIndex + 1} property`}
					/>
					<div className="flex items-center gap-2">
						<span className="text-[10px] uppercase tracking-widest text-nova-text-muted/60 shrink-0">
							Walk
						</span>
						<div className="flex-1 min-w-0">
							<RelationPathBuilder value={viaForBuilder} onChange={onSetVia} />
						</div>
					</div>
				</div>
				<InlineError errors={propertyErrors(propertyState, row.property)} />
			</InspectorField>

			<InspectorField
				label="Match"
				hint={
					SEARCH_MODE_DESCRIPTIONS[
						row.mode?.kind ?? DEFAULT_SEARCH_MODE_KIND[row.type]
					]
				}
			>
				<ModePicker
					value={row.mode}
					type={row.type}
					propertyDataType={propertyDataType}
					onChange={onSetMode}
					invalid={typeCouplingInvalid}
					rowIndex={rowIndex}
				/>
			</InspectorField>
		</>
	);
}

// ── Advanced arm body ─────────────────────────────────────────────

interface AdvancedArmBodyProps {
	readonly value: Predicate;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
	readonly onChange: (next: Predicate) => void;
}

/**
 * Body for `kind: "advanced"` rows. Renders the
 * `PredicateCardEditor` for the row's `predicate` slot. The
 * predicate AST encodes property references, relation walks, and
 * input bindings inline — the simple arm's pickers are inapplicable
 * here.
 */
function AdvancedArmBody({
	value,
	caseTypes,
	currentCaseType,
	knownInputs,
	onChange,
}: AdvancedArmBodyProps) {
	return (
		<InspectorField label="Predicate">
			<div className="rounded-md border border-white/[0.04] bg-nova-deep/30 p-2">
				<PredicateCardEditor
					value={value}
					onChange={onChange}
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					knownInputs={knownInputs}
				/>
			</div>
		</InspectorField>
	);
}

/**
 * Seed an advanced-arm predicate from a simple-arm row. When the
 * simple arm carries a property, the seed is `prop(...) eq ''` so
 * the user immediately sees a meaningful predicate they can edit;
 * when the simple arm has no property, fall back to `match-all()`
 * — the canonical always-true sentinel used elsewhere as the empty
 * predicate seed.
 */
function seedAdvancedPredicate(
	row: SimpleSearchInputDef,
	currentCaseType: string,
): Predicate {
	if (row.property === "") return matchAll();
	return {
		kind: "eq",
		left: term(prop(currentCaseType, row.property)),
		right: term(literal("")),
	};
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

/**
 * The property an advanced predicate is anchored on, when it has the
 * left-anchored shape (`comparison` / `in` / `between` / `is-null` /
 * `is-blank` whose left side reads a self property). Lets a
 * round-tripped advanced→simple conversion land back on the same
 * property rather than re-seeding.
 */
function recoverAnchoredProperty(predicate: Predicate): string | undefined {
	if (!("left" in predicate)) return undefined;
	const left = predicate.left;
	if (left.kind !== "term" || left.term.kind !== "prop") return undefined;
	const ref = left.term;
	if (ref.via !== undefined && ref.via.kind !== "self") return undefined;
	return ref.property;
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

// ── Type picker ───────────────────────────────────────────────────

interface TypePickerProps {
	readonly value: SearchInputType;
	readonly onChange: (next: SearchInputType) => void;
	/** Effective data type of the bound property (simple arm only) —
	 *  gates which widget types are selectable, mirroring the Match
	 *  picker. `undefined` (advanced arm / unresolved property) gates
	 *  nothing, matching the validator's skip. */
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
	const triggerLabel = SEARCH_INPUT_TYPE_LABELS[value];
	const triggerIcon = SEARCH_INPUT_TYPE_ICONS[value];
	const triggerClass =
		"group w-full flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30 whitespace-nowrap";
	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Search input ${rowIndex + 1} type: ${triggerLabel}`}
				className={triggerClass}
			>
				<Icon
					icon={triggerIcon}
					width="14"
					height="14"
					className="text-nova-violet-bright/80"
				/>
				<span className="flex-1 text-left text-nova-text">{triggerLabel}</span>
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
					<Menu.Popup className={`${MENU_POPUP_CLS} min-w-[10rem]`}>
						{SEARCH_INPUT_TYPES.map((t, i) => {
							const isActive = t === value;
							// Property-level gate — a widget the bound property's
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
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									} ${admitted ? "" : "opacity-45"}`}
								>
									<Icon
										icon={SEARCH_INPUT_TYPE_ICONS[t]}
										width="14"
										height="14"
										className={
											isActive
												? "text-nova-violet-bright"
												: "text-nova-text-muted"
										}
									/>
									<span className="flex-1 text-left">
										<div>{SEARCH_INPUT_TYPE_LABELS[t]}</div>
										<div
											className={`text-[10px] ${
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

// ── Mode picker ───────────────────────────────────────────────────

interface ModePickerProps {
	readonly value: SearchInputMode | undefined;
	readonly type: SearchInputType;
	/** Effective data type of the bound property — gates which modes
	 *  are selectable. `undefined` (unresolved property) gates nothing,
	 *  matching the validator's skip. */
	readonly propertyDataType: CasePropertyDataType | undefined;
	readonly onChange: (next: SearchInputMode | undefined) => void;
	readonly invalid: boolean;
	readonly rowIndex: number;
}

function ModePicker({
	value,
	type,
	propertyDataType,
	onChange,
	invalid,
	rowIndex,
}: ModePickerProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const applicable = applicableSearchModes(type);
	const triggerLabel =
		value === undefined ? "Default" : SEARCH_MODE_LABELS[value.kind];
	const triggerClass = [
		"group w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50",
		invalid
			? "border-nova-rose/40 hover:border-nova-rose/60"
			: "border-white/[0.06] hover:border-nova-violet/30",
	].join(" ");

	const setMultiSelectQuantifier = (q: MultiSelectQuantifier) => {
		onChange(multiSelectContainsMode(q));
	};

	const isMultiSelect = value?.kind === "multi-select-contains";

	return (
		<div className="flex items-center gap-1.5">
			<Menu.Root>
				<Menu.Trigger
					ref={triggerRef}
					aria-label={`Search input ${rowIndex + 1} mode: ${triggerLabel}`}
					className={triggerClass}
				>
					<span className="flex items-center gap-1.5 min-w-0">
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
						<Menu.Popup className={MENU_POPUP_CLS}>
							<Menu.Item
								onClick={() => onChange(undefined)}
								className={`rounded-t-xl ${MENU_ITEM_CLS} ${
									value === undefined
										? "text-nova-violet-bright bg-nova-violet/10"
										: ""
								}`}
							>
								<span className="flex-1 text-left">
									<div>
										Default —{" "}
										{SEARCH_MODE_LABELS[DEFAULT_SEARCH_MODE_KIND[type]]}
									</div>
									<div
										className={`text-[10px] ${
											value === undefined
												? "text-nova-violet-bright/60"
												: "text-nova-text-muted"
										}`}
									>
										{SEARCH_MODE_DESCRIPTIONS[DEFAULT_SEARCH_MODE_KIND[type]]}
									</div>
								</span>
								{value === undefined && (
									<Icon
										icon={tablerCheck}
										width="14"
										height="14"
										className="text-nova-violet-bright"
									/>
								)}
							</Menu.Item>
							{applicable.map((kind, i) => {
								const isActive = value !== undefined && value.kind === kind;
								// Property-level gate — picking a mode the bound
								// property's data type can't run would only land the
								// row in a validation error, so the item is disabled
								// and says why instead.
								const admitted =
									propertyDataType === undefined ||
									(SEARCH_MODE_PROPERTY_TYPES[kind]?.includes(
										propertyDataType,
									) ??
										true);
								const last = applicable.length - 1;
								const corners = i === last ? "rounded-b-xl" : "";
								return (
									<Menu.Item
										key={kind}
										disabled={!admitted}
										onClick={() => onChange(buildMode(kind))}
										className={`${corners} ${MENU_ITEM_CLS} ${
											isActive
												? "text-nova-violet-bright bg-nova-violet/10"
												: ""
										} ${admitted ? "" : "opacity-45"}`}
									>
										<span className="flex-1 text-left">
											<div>{SEARCH_MODE_LABELS[kind]}</div>
											<div
												className={`text-[10px] ${
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
							{applicable.length === 0 && (
								<div
									className={`${MENU_ITEM_BASE} text-nova-text-muted italic`}
								>
									No applicable modes
								</div>
							)}
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
			{isMultiSelect && (
				<QuantifierToggle
					value={value.quantifier}
					onChange={setMultiSelectQuantifier}
					rowIndex={rowIndex}
				/>
			)}
		</div>
	);
}

// ── Quantifier toggle ─────────────────────────────────────────────

interface QuantifierToggleProps {
	readonly value: MultiSelectQuantifier;
	readonly onChange: (next: MultiSelectQuantifier) => void;
	readonly rowIndex: number;
}

function QuantifierToggle({
	value,
	onChange,
	rowIndex,
}: QuantifierToggleProps) {
	const segCls = (active: boolean) =>
		[
			"px-2 py-1.5 text-xs transition-colors cursor-pointer",
			active
				? "bg-nova-violet/15 text-nova-violet-bright"
				: "text-nova-text-muted hover:text-nova-text",
		].join(" ");
	return (
		<fieldset className="inline-flex rounded-md border border-white/[0.06] bg-nova-deep/50 overflow-hidden p-0 m-0 min-w-0">
			<legend className="sr-only">
				Search input {rowIndex + 1} multi-select quantifier
			</legend>
			<button
				type="button"
				onClick={() => onChange("any")}
				aria-pressed={value === "any"}
				className={segCls(value === "any")}
			>
				Any
			</button>
			<button
				type="button"
				onClick={() => onChange("all")}
				aria-pressed={value === "all"}
				className={segCls(value === "all")}
			>
				All
			</button>
		</fieldset>
	);
}

// ── Default-value slot ────────────────────────────────────────────

interface DefaultValueSlotProps {
	readonly value: ValueExpression | undefined;
	readonly inputType: SearchInputType;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
	readonly rowIndex: number;
	readonly onChange: (next: ValueExpression | undefined) => void;
}

function DefaultValueSlot({
	value,
	inputType,
	caseTypes,
	currentCaseType,
	knownInputs,
	rowIndex,
	onChange,
}: DefaultValueSlotProps) {
	const expectedType = expectedTypeForDefault(inputType);
	if (value === undefined) {
		return (
			<button
				type="button"
				onClick={() => onChange(seedDefaultExpression(inputType))}
				className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				aria-label={`Add default value for search input ${rowIndex + 1}`}
			>
				<Icon icon={tablerPlus} width="11" height="11" />
				<span>Add default value</span>
			</button>
		);
	}
	return (
		<div className="rounded-md border border-white/[0.04] bg-nova-deep/30 p-2 space-y-1.5">
			<div className="flex items-center gap-1.5">
				<span className="text-[10px] uppercase tracking-widest text-nova-text-muted/60">
					Default value
				</span>
				<button
					type="button"
					onClick={() => onChange(undefined)}
					className="ml-auto text-[10px] uppercase tracking-wider text-nova-text-muted/50 hover:text-nova-rose transition-colors cursor-pointer"
					aria-label={`Remove default value for search input ${rowIndex + 1}`}
				>
					Remove
				</button>
			</div>
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
				knownInputs={knownInputs}
				expectedType={expectedType}
			/>
		</div>
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
