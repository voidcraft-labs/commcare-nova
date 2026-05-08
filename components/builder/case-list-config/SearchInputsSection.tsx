// components/builder/case-list-config/SearchInputsSection.tsx
//
// Drag-orderable list of `SearchInputDef` rows. The schema's
// discriminated union splits authoring into two arms:
//
//   - `kind: "simple"` — `(property, mode, via)` triple. The wire
//     layer derives the predicate from the targeted property + the
//     mode + the optional relation walk.
//   - `kind: "advanced"` — author-defined `predicate` AST. The wire
//     layer emits the predicate verbatim; this row mounts a
//     `PredicateCardEditor`.
//
// Each row carries a "Convert to advanced" / "Convert to simple"
// affordance that flips the discriminator. Converting to advanced
// seeds the predicate from the row's current property + mode (or
// `match-all()` when no property is set); converting back to simple
// drops the predicate and re-exposes the property + mode pickers.
//
// Common slots — `uuid`, `name`, `label`, `type`, `default?` — live
// on both arms. Per-row inline diagnostics surface for empty / dup
// names, empty labels, and (on the simple arm) `(type, mode,
// property)` type-coupling mismatches. The advanced arm bypasses
// type-coupling — its predicate AST has its own type checker.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerArrowsExchange from "@iconify-icons/tabler/arrows-exchange";
import tablerBarcode from "@iconify-icons/tabler/barcode";
import tablerCalendar from "@iconify-icons/tabler/calendar";
import tablerCalendarStats from "@iconify-icons/tabler/calendar-stats";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerExclamationCircle from "@iconify-icons/tabler/exclamation-circle";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerListSearch from "@iconify-icons/tabler/list-search";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerSelect from "@iconify-icons/tabler/select";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useId, useMemo, useRef } from "react";
import {
	advancedSearchInputDef,
	applicableSearchModes,
	type CaseProperty,
	type CaseType,
	effectiveDataType,
	exactMode,
	fuzzyDateMode,
	fuzzyMode,
	type MultiSelectQuantifier,
	multiSelectContainsMode,
	phoneticMode,
	rangeMode,
	SEARCH_INPUT_TYPE_PROPERTY_TYPES,
	SEARCH_INPUT_TYPES,
	SEARCH_MODE_PROPERTY_TYPES,
	type SearchInputDef,
	type SearchInputMode,
	type SearchInputType,
	type SimpleSearchInputDef,
	simpleSearchInputDef,
	startsWithMode,
} from "@/lib/domain";
import {
	literal,
	matchAll,
	type Predicate,
	prop,
	type RelationPath,
	type ResolvedType,
	type SearchInputDecl,
	selfPath,
	term,
	today,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { ExpressionCardEditor } from "./ExpressionCardEditor";
import { buildValidityIndex, PredicateEditProvider } from "./editorContext";
import { PredicateCardEditor } from "./PredicateCardEditor";
import { BlurCommitTextInput } from "./primitives/BlurCommitTextInput";
import { InlineError } from "./primitives/CardShell";
import { PropertyRefPicker } from "./primitives/PropertyRefPicker";
import { RelationPathBuilder } from "./primitives/RelationPathBuilder";
import {
	useInnerValidityShadow,
	useValidityPropagator,
} from "./useInnerValidityShadow";
import { ReorderableRow, useReorderableList } from "./useReorderableList";
import { newUuid } from "./uuid";

// ── Public types ──────────────────────────────────────────────────

export interface SearchInputsSectionProps {
	/** The current case-list config's search inputs. Order matters
	 *  — the runtime renders the search form's inputs in declaration
	 *  order. */
	readonly value: readonly SearchInputDef[];
	readonly onChange: (next: readonly SearchInputDef[]) => void;
	readonly caseTypes: readonly CaseType[];
	/** The case-type the case list runs against. Property pickers
	 *  scope here at the top level; relation walks (`via` on the
	 *  simple arm) navigate to other case types. */
	readonly currentCaseType: string;
	/** Surfaces the editor's overall validity to the parent. The
	 *  aggregated verdict combines:
	 *    - per-row `name` non-empty + unique among siblings.
	 *    - per-row `label` non-empty.
	 *    - simple-arm `(type, mode, property)` type-coupling.
	 *    - per-row inner `default` expression validity (when present).
	 *    - advanced-arm `predicate` validity. */
	readonly onValidityChange?: (valid: boolean) => void;
}

// ── Display labels ────────────────────────────────────────────────

const SEARCH_INPUT_TYPE_LABELS: Record<SearchInputType, string> = {
	text: "Text",
	select: "Select",
	date: "Date",
	"date-range": "Date range",
	barcode: "Barcode",
};

const SEARCH_INPUT_TYPE_ICONS: Record<SearchInputType, IconifyIcon> = {
	text: tablerSearch,
	select: tablerSelect,
	date: tablerCalendar,
	"date-range": tablerCalendarStats,
	barcode: tablerBarcode,
};

const SEARCH_MODE_LABELS: Record<SearchInputMode["kind"], string> = {
	exact: "Exact",
	fuzzy: "Fuzzy",
	"starts-with": "Starts with",
	phonetic: "Phonetic",
	"fuzzy-date": "Fuzzy date",
	range: "Range",
	"multi-select-contains": "Multi-select contains",
};

// ── Per-mode builder lookup ───────────────────────────────────────

function buildMode(
	kind: SearchInputMode["kind"],
	previousQuantifier: MultiSelectQuantifier = "any",
): SearchInputMode {
	switch (kind) {
		case "exact":
			return exactMode();
		case "fuzzy":
			return fuzzyMode();
		case "starts-with":
			return startsWithMode();
		case "phonetic":
			return phoneticMode();
		case "fuzzy-date":
			return fuzzyDateMode();
		case "range":
			return rangeMode();
		case "multi-select-contains":
			return multiSelectContainsMode(previousQuantifier);
	}
}

// ── Row resolution — single source of truth ───────────────────────
//
// One helper computes per-row `{ nameState, labelEmpty,
// typeCouplingErrors }` and is consumed by BOTH the inline-error
// chrome on the row AND the editor's `valid` aggregation —
// display chrome and validity propagation share one source of
// truth.

type NameState =
	/** Non-empty + unique among siblings. */
	| { kind: "ok" }
	/** Empty string — the user hasn't named the input yet. */
	| { kind: "empty" }
	/** Duplicate against an earlier index — first occurrence wins.
	 *  The wire layer binds inputs by name, so duplicates would
	 *  silently overwrite. */
	| { kind: "duplicate"; firstIndex: number };

interface ResolvedRow {
	readonly nameState: NameState;
	readonly labelEmpty: boolean;
	/** Type-coupling diagnostics — empty when the picked
	 *  `(type, mode)` pair is admissible against the targeted
	 *  property's `data_type`. Always empty for `kind: "advanced"`
	 *  (the predicate AST owns property resolution). */
	readonly typeCouplingErrors: readonly string[];
}

/**
 * Resolve every row's status against the sibling list + the editor's
 * `caseTypes` + `currentCaseType` context. Builds the
 * `firstIndexByName` map up-front so the per-row pass stays O(n).
 */
function resolveRows(
	value: readonly SearchInputDef[],
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): readonly ResolvedRow[] {
	const firstIndexByName = new Map<string, number>();
	for (let i = 0; i < value.length; i++) {
		const name = value[i]?.name;
		if (name === undefined || name === "") continue;
		if (!firstIndexByName.has(name)) {
			firstIndexByName.set(name, i);
		}
	}
	return value.map((row, i) => {
		let nameState: NameState;
		if (row.name === "") {
			nameState = { kind: "empty" };
		} else {
			const firstIndex = firstIndexByName.get(row.name);
			if (firstIndex !== undefined && firstIndex < i) {
				nameState = { kind: "duplicate", firstIndex };
			} else {
				nameState = { kind: "ok" };
			}
		}

		// Advanced arm bypasses type-coupling — the predicate AST owns
		// property resolution + has its own type checker.
		const typeCouplingErrors =
			row.kind === "advanced"
				? ([] as const)
				: computeTypeCouplingErrors(
						row,
						resolveProperty(caseTypes, row, currentCaseType),
					);

		return {
			nameState,
			labelEmpty: row.label === "",
			typeCouplingErrors,
		};
	});
}

/**
 * Resolve the targeted property reference against the `caseTypes`
 * graph. Only the simple arm carries a `property`; the advanced arm
 * encodes property references inside its `predicate` AST.
 */
function resolveProperty(
	caseTypes: readonly CaseType[],
	row: SimpleSearchInputDef,
	currentCaseType: string,
): CaseProperty | undefined {
	if (row.property === "") return undefined;
	const destinationCaseType = resolveDestinationCaseType(
		caseTypes,
		row.via,
		currentCaseType,
	);
	const ct = caseTypes.find((c) => c.name === destinationCaseType);
	return ct?.properties.find((p) => p.name === row.property);
}

/**
 * Resolve a relation walk's destination case type. Mirrors the
 * predicate editor's destination resolution: `self` stays at the
 * row's anchor, `ancestor` walks one parent step, `subcase` /
 * `any-relation` fall back to the row's anchor (the editor's
 * single-step `RelationPathBuilder` doesn't surface destination
 * qualifiers; the wire layer's per-mode property-type gate is the
 * runtime authority for stricter resolution).
 */
function resolveDestinationCaseType(
	caseTypes: readonly CaseType[],
	via: RelationPath | undefined,
	currentCaseType: string,
): string {
	if (via === undefined) return currentCaseType;
	switch (via.kind) {
		case "self":
			return currentCaseType;
		case "ancestor": {
			const ct = caseTypes.find((c) => c.name === currentCaseType);
			return ct?.parent_type ?? currentCaseType;
		}
		case "subcase":
			return currentCaseType;
		case "any-relation":
			return currentCaseType;
	}
}

/**
 * Compute the type-coupling diagnostics for a single simple-arm row
 * given the targeted property's `CaseProperty` (when resolvable).
 * Three orthogonal checks combine: widget-kind vs property data-type,
 * mode vs property data-type, mode vs widget-kind (covers persisted
 * docs that drifted past the editor's own picker filtering).
 */
function computeTypeCouplingErrors(
	row: SimpleSearchInputDef,
	property: CaseProperty | undefined,
): readonly string[] {
	const errors: string[] = [];

	// Mode vs widget-kind gate.
	if (row.mode !== undefined) {
		const modeKind = row.mode.kind;
		const applicable = applicableSearchModes(row.type);
		if (!applicable.includes(modeKind)) {
			const allowedLabels = applicable
				.map((m) => SEARCH_MODE_LABELS[m])
				.join(", ");
			errors.push(
				`${SEARCH_MODE_LABELS[modeKind]} mode is not valid for ${SEARCH_INPUT_TYPE_LABELS[row.type]} inputs; pick ${allowedLabels}.`,
			);
		}
	}

	// Property-anchored gates. Skip when property is unresolved.
	if (property === undefined) return errors;
	const dataType = effectiveDataType(property);

	const typeAllowList = SEARCH_INPUT_TYPE_PROPERTY_TYPES[row.type];
	if (typeAllowList !== undefined && !typeAllowList.includes(dataType)) {
		errors.push(
			`${SEARCH_INPUT_TYPE_LABELS[row.type]} input is not valid for ${dataType} property "${row.property}"; pick a ${typeAllowList.join(" / ")} property.`,
		);
	}

	if (row.mode !== undefined) {
		const modeAllowList = SEARCH_MODE_PROPERTY_TYPES[row.mode.kind];
		if (modeAllowList !== undefined && !modeAllowList.includes(dataType)) {
			errors.push(
				`${SEARCH_MODE_LABELS[row.mode.kind]} mode is not valid for ${dataType} property "${row.property}"; pick a ${modeAllowList.join(" / ")} property.`,
			);
		}
	}

	return errors;
}

function rowHasStructuralError(resolved: ResolvedRow): boolean {
	if (resolved.nameState.kind !== "ok") return true;
	if (resolved.labelEmpty) return true;
	if (resolved.typeCouplingErrors.length > 0) return true;
	return false;
}

// ── knownInputs derivation ────────────────────────────────────────
//
// Each row's inner editor sees the SIBLING rows' search-input
// declarations. Lets a row's `default` / advanced predicate
// reference any other input via `input("other_name")` without the
// type checker rejecting the reference. Self-references are
// excluded so a row authoring its own name doesn't see spurious
// "input not declared" errors during the per-keystroke draft phase.

function deriveSearchInputDecl(
	row: SearchInputDef,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): SearchInputDecl {
	switch (row.type) {
		case "text":
		case "barcode":
			return { name: row.name, data_type: "text" };
		case "date":
		case "date-range":
			return { name: row.name, data_type: "date" };
		case "select": {
			// Selects derive the declared `data_type` from the targeted
			// property when resolvable; falls back to `text`. Only the
			// simple arm has a property to consult; advanced rows fall
			// straight through to text.
			if (row.kind !== "simple") {
				return { name: row.name, data_type: "text" };
			}
			const property = resolveProperty(caseTypes, row, currentCaseType);
			if (property === undefined) {
				return { name: row.name, data_type: "text" };
			}
			const dataType = effectiveDataType(property);
			if (dataType === "single_select" || dataType === "multi_select") {
				return { name: row.name, data_type: dataType };
			}
			return { name: row.name, data_type: "text" };
		}
	}
}

function computeKnownInputsForRow(
	rows: readonly SearchInputDef[],
	rowIndex: number,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): readonly SearchInputDecl[] {
	const decls: SearchInputDecl[] = [];
	for (let i = 0; i < rows.length; i++) {
		if (i === rowIndex) continue;
		const sibling = rows[i];
		if (sibling === undefined || sibling.name === "") continue;
		decls.push(deriveSearchInputDecl(sibling, caseTypes, currentCaseType));
	}
	return decls;
}

// ── Default-value expectedType + seed ─────────────────────────────

function expectedTypeForDefault(
	type: SearchInputType,
): ResolvedType | undefined {
	switch (type) {
		case "text":
		case "barcode":
			return "text";
		case "date":
		case "date-range":
			return "date";
		case "select":
			return undefined;
	}
}

function seedDefaultExpression(type: SearchInputType): ValueExpression {
	switch (type) {
		case "date":
		case "date-range":
			return today();
		case "text":
		case "barcode":
		case "select":
			return term(literal(""));
	}
}

// ── Top-level editor ──────────────────────────────────────────────

/**
 * Drag-orderable list of `SearchInputDef` rows. Each row's
 * arm-specific body switches on `kind: "simple"` / `kind:
 * "advanced"`.
 */
export function SearchInputsSection({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	onValidityChange,
}: SearchInputsSectionProps) {
	const containerKey = useId();

	const resolvedPerRow = useMemo(
		() => resolveRows(value, caseTypes, currentCaseType),
		[value, caseTypes, currentCaseType],
	);

	const hasStructuralErrorPerRow = useMemo(
		() => resolvedPerRow.map((r) => rowHasStructuralError(r)),
		[resolvedPerRow],
	);

	const { aggregatedValid: innerAggregatedValid, setRowValid } =
		useInnerValidityShadow<SearchInputDef>(value);

	const isValid = useMemo(() => {
		for (let i = 0; i < value.length; i++) {
			if (hasStructuralErrorPerRow[i] === true) return false;
		}
		return innerAggregatedValid;
	}, [value, hasStructuralErrorPerRow, innerAggregatedValid]);

	useValidityPropagator({ isValid, onValidityChange });

	const { pendingDrop } = useReorderableList<SearchInputDef>({
		containerKey,
		containerKind: "search-inputs",
		items: value,
		onReorder: (next) => onChange(next),
	});

	const replaceRow = (index: number, next: SearchInputDef) => {
		onChange(value.map((r, i) => (i === index ? next : r)));
	};

	const removeRow = (index: number) => {
		onChange(value.filter((_, i) => i !== index));
	};

	const appendRow = () => {
		// Default seed: simple-arm text input with a fresh uuid + a
		// readable auto-generated name. The user renames at will; the
		// `input_` prefix distinguishes auto-generated names from
		// hand-authored ones at-a-glance. The 8-hex-digit suffix keeps
		// the name readable while staying unique.
		const freshName = `input_${crypto.randomUUID().slice(0, 8)}`;
		const seed = simpleSearchInputDef(newUuid(), freshName, "", "text", "");
		onChange([...value, seed]);
	};

	return (
		<div className="space-y-3">
			<header className="flex items-baseline gap-2">
				<div className="w-0.5 h-3 rounded-full bg-nova-violet/40 self-center" />
				<Icon
					icon={tablerListSearch}
					width="14"
					height="14"
					className="text-nova-violet-bright/80 self-center"
				/>
				<h3 className="text-[11px] font-semibold uppercase tracking-widest text-nova-text/90">
					Search inputs
				</h3>
				<span className="ml-1 text-[10px] text-nova-text-muted/70">
					Form fields the user fills in to narrow the case list.
				</span>
			</header>

			<div className="space-y-1.5">
				{value.length === 0 && <EmptyState />}
				{value.map((row, i) => {
					const resolved = resolvedPerRow[i] ?? {
						nameState: { kind: "ok" } as const,
						labelEmpty: row.label === "",
						typeCouplingErrors: [] as readonly string[],
					};
					const hasStructuralError = hasStructuralErrorPerRow[i] === true;
					const knownInputs = computeKnownInputsForRow(
						value,
						i,
						caseTypes,
						currentCaseType,
					);
					return (
						<ReorderableRow
							key={row.uuid}
							index={i}
							containerKey={containerKey}
							containerKind="search-inputs"
							pendingDrop={pendingDrop}
							preview={<SearchInputDragPreview index={i} row={row} />}
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
									<SearchInputRow
										value={row}
										index={i}
										resolved={resolved}
										hasStructuralError={hasStructuralError}
										caseTypes={caseTypes}
										currentCaseType={currentCaseType}
										knownInputs={knownInputs}
										onChange={(next) => replaceRow(i, next)}
										onRemove={() => removeRow(i)}
										onInnerValidityChange={(valid) => setRowValid(row, valid)}
										setHandleEl={setHandleEl}
									/>
									{previewPortal}
								</div>
							)}
						</ReorderableRow>
					);
				})}
				<button
					type="button"
					onClick={appendRow}
					className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
					aria-label="Add search input"
				>
					<Icon icon={tablerPlus} width="11" height="11" />
					<span>Add search input</span>
				</button>
			</div>
		</div>
	);
}

// ── Empty state ────────────────────────────────────────────────────

function EmptyState() {
	return (
		<div className="rounded-md border border-dashed border-white/[0.06] bg-nova-surface/20 px-3 py-3 text-[11px] text-nova-text-muted/70">
			<div className="flex items-center gap-1.5">
				<Icon
					icon={tablerListSearch}
					width="12"
					height="12"
					className="text-nova-text-muted/60"
				/>
				<span>
					No search inputs. Add one to give users a form field for narrowing the
					case list (e.g. patient name, date of birth).
				</span>
			</div>
		</div>
	);
}

// ── Per-row component ─────────────────────────────────────────────

interface SearchInputRowProps {
	readonly value: SearchInputDef;
	readonly index: number;
	readonly resolved: ResolvedRow;
	readonly hasStructuralError: boolean;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
	readonly onChange: (next: SearchInputDef) => void;
	readonly onRemove: () => void;
	/** Combined `default` + `predicate` validity verdict. Fired with
	 *  `false` when EITHER inner editor reports invalid; `true` only
	 *  when both report valid (or aren't mounted). */
	readonly onInnerValidityChange: (valid: boolean) => void;
	readonly setHandleEl: (el: HTMLElement | null) => void;
}

function SearchInputRow({
	value,
	index,
	resolved,
	hasStructuralError,
	caseTypes,
	currentCaseType,
	knownInputs,
	onChange,
	onRemove,
	onInnerValidityChange,
	setHandleEl,
}: SearchInputRowProps) {
	// Track each inner editor's verdict separately so the row can
	// AND them at every transition. Only one of (default, predicate)
	// is mounted at a time depending on `kind`, but the two refs
	// keep the AND operation simple — a missing editor's ref stays
	// at its `true` default and doesn't drag the verdict down.
	const defaultValidRef = useRef(true);
	const predicateValidRef = useRef(true);
	const propagateValidity = () => {
		onInnerValidityChange(defaultValidRef.current && predicateValidRef.current);
	};

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
	const setDefault = (next: ValueExpression | undefined) => {
		if (next === undefined) {
			defaultValidRef.current = true;
			propagateValidity();
		}
		onChange(rebuildRow(value, { default: next }));
	};

	// ── Simple-arm mutators (no-op when row is advanced) ──

	const setProperty = (property: string) => {
		if (value.kind !== "simple") return;
		onChange(rebuildRow(value, { property }));
	};
	const setVia = (via: RelationPath) => {
		if (value.kind !== "simple") return;
		onChange(rebuildRow(value, { via }));
	};
	const setMode = (mode: SearchInputMode | undefined) => {
		if (value.kind !== "simple") return;
		onChange(rebuildRow(value, { mode }));
	};

	// ── Advanced-arm mutators (no-op when row is simple) ──

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
	// seeding the predicate from the simple arm's current property +
	// mode (when set) or `match-all()` otherwise. The `via` slot
	// drops here — the predicate AST encodes relation walks inside
	// its own structure when needed.
	//
	// "Convert to simple" replaces the row with a simple arm,
	// dropping the predicate. The new arm's property is empty (the
	// user picks one); mode and via reset to default. The
	// predicate's structure isn't reverse-engineered into a
	// (property, mode, via) triple — the conversion is a fresh
	// start on the simple arm.

	const convertToAdvanced = () => {
		if (value.kind !== "simple") return;
		const seedPredicate = seedAdvancedPredicate(value, currentCaseType);
		predicateValidRef.current = true;
		onChange(
			advancedSearchInputDef(
				value.uuid,
				value.name,
				value.label,
				value.type,
				seedPredicate,
				{ default: value.default },
			),
		);
	};
	const convertToSimple = () => {
		if (value.kind !== "advanced") return;
		predicateValidRef.current = true;
		onChange(
			simpleSearchInputDef(
				value.uuid,
				value.name,
				value.label,
				value.type,
				"",
				{ default: value.default },
			),
		);
	};

	const emptyValidityIndex = useMemo(() => buildValidityIndex([]), []);

	return (
		<PredicateEditProvider
			caseTypes={caseTypes}
			currentCaseType={currentCaseType}
			knownInputs={knownInputs}
			validityIndex={emptyValidityIndex}
		>
			<div
				className={[
					"group/row relative flex items-stretch gap-2 rounded-md border bg-nova-surface/40 px-2 py-2 transition-colors",
					hasStructuralError
						? "border-nova-error/35 shadow-[inset_0_0_0_1px_rgba(255,90,120,0.12)]"
						: "border-white/[0.04]",
				].join(" ")}
			>
				<div className="flex flex-col items-center gap-1 pt-0.5">
					<button
						type="button"
						ref={setHandleEl}
						aria-label="Reorder search input"
						className="cursor-grab text-nova-text-muted/50 hover:text-nova-text-muted transition-colors"
					>
						<Icon icon={tablerGripVertical} width="14" height="14" />
					</button>
					<span
						aria-hidden="true"
						className="text-[10px] font-mono text-nova-text-muted/40"
					>
						{index + 1}
					</span>
				</div>

				<div className="min-w-0 flex-1 space-y-2">
					{/* Name / label / type / convert affordance — top row.
					    The convert button switches the row's kind in
					    place; its label flips to match the destination. */}
					<div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-1.5">
						<div className="block">
							<div className="block text-[10px] uppercase tracking-widest text-nova-text-muted/60 mb-1">
								Name
							</div>
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
										`Already used by row ${resolved.nameState.firstIndex + 1}.`,
									]}
								/>
							)}
						</div>
						<div className="block">
							<div className="block text-[10px] uppercase tracking-widest text-nova-text-muted/60 mb-1">
								Label
							</div>
							<BlurCommitTextInput
								value={value.label}
								onCommit={setLabel}
								placeholder="Display label"
								ariaLabel={`Search input ${index + 1} label`}
							/>
							{resolved.labelEmpty && (
								<InlineError errors={["Label is required."]} />
							)}
						</div>
						<div className="block">
							<div className="block text-[10px] uppercase tracking-widest text-nova-text-muted/60 mb-1">
								Type
							</div>
							<TypePicker
								value={value.type}
								onChange={setType}
								rowIndex={index}
							/>
						</div>
						<div className="block self-end">
							<ConvertArmButton
								kind={value.kind}
								onConvert={
									value.kind === "simple" ? convertToAdvanced : convertToSimple
								}
								rowIndex={index}
							/>
						</div>
					</div>

					{/* Per-arm body. */}
					{value.kind === "simple" ? (
						<SimpleArmBody
							row={value}
							rowIndex={index}
							currentCaseType={currentCaseType}
							typeCouplingInvalid={resolved.typeCouplingErrors.length > 0}
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
							onValidityChange={(valid) => {
								predicateValidRef.current = valid;
								propagateValidity();
							}}
						/>
					)}

					<InlineError errors={resolved.typeCouplingErrors} />

					{/* Default-value sub-editor (both arms). */}
					<DefaultValueSlot
						value={value.default}
						inputType={value.type}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						knownInputs={knownInputs}
						rowIndex={index}
						onChange={setDefault}
						onValidityChange={(valid) => {
							defaultValidRef.current = valid;
							propagateValidity();
						}}
					/>
				</div>

				<button
					type="button"
					onClick={onRemove}
					aria-label="Remove search input"
					className="self-start rounded p-0.5 text-nova-text-muted/50 hover:text-nova-error transition-colors cursor-pointer"
				>
					<Icon icon={tablerTrash} width="14" height="14" />
				</button>
			</div>
		</PredicateEditProvider>
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
	readonly onSetProperty: (property: string) => void;
	readonly onSetVia: (via: RelationPath) => void;
	readonly onSetMode: (mode: SearchInputMode | undefined) => void;
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
	onSetProperty,
	onSetVia,
	onSetMode,
}: SimpleArmBodyProps) {
	const viaForBuilder = row.via ?? selfPath();
	return (
		<>
			<div className="rounded-md border border-white/[0.04] bg-nova-deep/30 p-2 space-y-1.5">
				<div className="flex items-center gap-1.5">
					<span className="text-[10px] uppercase tracking-widest text-nova-text-muted/60">
						Property
					</span>
				</div>
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

			<div className="flex items-center gap-2">
				<span className="text-[10px] uppercase tracking-widest text-nova-text-muted/60 shrink-0">
					Mode
				</span>
				<div className="flex-1 min-w-0">
					<ModePicker
						value={row.mode}
						type={row.type}
						onChange={onSetMode}
						invalid={typeCouplingInvalid}
						rowIndex={rowIndex}
					/>
				</div>
			</div>
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
	readonly onValidityChange: (valid: boolean) => void;
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
	onValidityChange,
}: AdvancedArmBodyProps) {
	return (
		<div className="rounded-md border border-white/[0.04] bg-nova-deep/30 p-2 space-y-1.5">
			<div className="text-[10px] uppercase tracking-widest text-nova-text-muted/60">
				Predicate
			</div>
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
				knownInputs={knownInputs}
				onValidityChange={onValidityChange}
			/>
		</div>
	);
}

/**
 * Seed an advanced-arm predicate from a simple-arm row. When the
 * simple arm carries a property, the seed is `prop(...) eq ''` so
 * the user immediately sees a meaningful predicate they can edit;
 * when the simple arm has no property, fall back to `match-all()`
 * — the canonical always-true sentinel used elsewhere as the empty
 * predicate seed. The constructed shape parses through the
 * predicate schema's `eq`-arm `comparisonSchema`.
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
	readonly rowIndex: number;
}

function TypePicker({ value, onChange, rowIndex }: TypePickerProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const triggerLabel = SEARCH_INPUT_TYPE_LABELS[value];
	const triggerIcon = SEARCH_INPUT_TYPE_ICONS[value];
	const triggerClass =
		"group flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30 whitespace-nowrap";
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
				<span className="text-nova-text">{triggerLabel}</span>
				<Chevron />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="end"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
				>
					<Menu.Popup className={`${MENU_POPUP_CLS} min-w-[10rem]`}>
						{SEARCH_INPUT_TYPES.map((t, i) => {
							const isActive = t === value;
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
									onClick={() => onChange(t)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									}`}
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
										{SEARCH_INPUT_TYPE_LABELS[t]}
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
	readonly onChange: (next: SearchInputMode | undefined) => void;
	readonly invalid: boolean;
	readonly rowIndex: number;
}

function ModePicker({
	value,
	type,
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
			? "border-nova-error/40 hover:border-nova-error/60"
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
						<span className={invalid ? "text-nova-error/90" : "text-nova-text"}>
							{triggerLabel}
						</span>
						{invalid && (
							<Icon
								icon={tablerExclamationCircle}
								width="14"
								height="14"
								className="text-nova-error/80"
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
									<div>Default</div>
									<div
										className={`text-[10px] uppercase tracking-wider ${
											value === undefined
												? "text-nova-violet-bright/60"
												: "text-nova-text-muted"
										}`}
									>
										Per-type default
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
								const last = applicable.length - 1;
								const corners = i === last ? "rounded-b-xl" : "";
								return (
									<Menu.Item
										key={kind}
										onClick={() => onChange(buildMode(kind))}
										className={`${corners} ${MENU_ITEM_CLS} ${
											isActive
												? "text-nova-violet-bright bg-nova-violet/10"
												: ""
										}`}
									>
										<span className="flex-1 text-left">
											{SEARCH_MODE_LABELS[kind]}
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
	readonly onValidityChange: (valid: boolean) => void;
}

function DefaultValueSlot({
	value,
	inputType,
	caseTypes,
	currentCaseType,
	knownInputs,
	rowIndex,
	onChange,
	onValidityChange,
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
					className="ml-auto text-[10px] uppercase tracking-wider text-nova-text-muted/50 hover:text-nova-error transition-colors cursor-pointer"
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
				onValidityChange={onValidityChange}
			/>
		</div>
	);
}

// ── Drag preview ──────────────────────────────────────────────────

function SearchInputDragPreview({
	index,
	row,
}: {
	readonly index: number;
	readonly row: SearchInputDef;
}) {
	const label = row.label || row.name || `Search input ${index + 1}`;
	return (
		<div className="inline-flex items-center gap-1.5 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-1.5 text-sm text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerGripVertical}
				width="14"
				height="14"
				className="text-nova-text-muted"
			/>
			<Icon
				icon={SEARCH_INPUT_TYPE_ICONS[row.type]}
				width="14"
				height="14"
				className="text-nova-violet-bright/80"
			/>
			<span className="max-w-[240px] truncate">{label}</span>
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
