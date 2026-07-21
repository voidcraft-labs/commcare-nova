// components/builder/shared/primitives/LiteralValueInput.tsx
//
// Typed input for a `Literal` AST value. Switches its visual /
// keyboard behavior on the property's declared `data_type` so the
// authoring shape matches the wire form: text → text input;
// int / decimal → numeric input; date / time / datetime → typed
// pickers (rendered as native inputs of the appropriate type so
// the system date / time picker drives the UX); single_select /
// multi_select → option-list dropdown sourced from the property's
// `options`.
//
// The input emits a fully-typed `Literal` (carrying `data_type`
// where applicable) so the type checker validates the round-trip
// without having to format-sniff the literal at every site. Edits
// commit on blur for text / numeric inputs and on selection for
// dropdowns.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { FieldError } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	type CaseProperty,
	type CaseType,
	effectiveDataType,
} from "@/lib/domain";
import {
	dateLiteral,
	datetimeLiteral,
	type Literal,
	literal,
	type ResolvedType,
	timeLiteral,
} from "@/lib/domain/predicate";
import { usePredicateEditContext } from "../editorContext";
import { rebuildLiteralPreservingDataType } from "../literalRebuild";

interface LiteralValueInputProps {
	/** Current literal value, or undefined for "unset". */
	readonly value: Literal | undefined;
	/** Fired when the user commits a new literal. */
	readonly onChange: (next: Literal) => void;
	/**
	 * The case-type-property this input is constrained to. Drives
	 * the `data_type` lookup and the option list (for select-typed
	 * properties). Pass undefined when no property is selected yet
	 * — the input renders a disabled placeholder.
	 */
	readonly caseTypeName: string;
	readonly propertyName: string | undefined;
	/**
	 * Optional override of the data type — used when the surrounding
	 * card knows the type from context other than the property's
	 * declared type (e.g. the input drives a search-input ref whose
	 * declared data type lives on `SearchInputDecl`, not on the case
	 * property).
	 */
	readonly overrideDataType?: string;
	/**
	 * The slot's accepted result types — used to pick the widget's
	 * data type when no property anchor resolves one (a literal-list
	 * value whose `left` isn't a property ref). Ignored once a
	 * property or `overrideDataType` is in play.
	 */
	readonly accepts?: ReadonlySet<ResolvedType>;
	/**
	 * When true, the text widget refuses to commit an empty value —
	 * an emptied draft reverts to the prior value rather than emitting
	 * `literal("")`. Used by slots where the empty string is a
	 * soundness state (a `match` value).
	 */
	readonly nonEmpty?: boolean;
	/** Shows the slot in an error state. */
	readonly invalid?: boolean;
	/** Accessibility label override (defaults to "Value"). */
	readonly ariaLabel?: string;
}

// The literal types a typed widget exists for, in the order a no-anchor
// slot prefers them. A geopoint accept-set (`{geopoint, _any}`) shares
// none of these — there is no geopoint literal widget — so such a slot
// renders the null-only control rather than a free text input that
// could commit a text coordinate the checker rejects.
const WIDGETABLE_TYPES = [
	"text",
	"int",
	"decimal",
	"date",
	"datetime",
	"time",
] as const;

/** Whether the slot accepts any type a typed widget can author. */
function hasWidgetableType(accepts: ReadonlySet<ResolvedType>): boolean {
	return WIDGETABLE_TYPES.some((t) => accepts.has(t));
}

/** The widget data type to render when no property anchors one —
 *  the first concrete type the slot accepts, preferring text. */
function widgetDataTypeFromAccepts(accepts: ReadonlySet<ResolvedType>): string {
	for (const t of WIDGETABLE_TYPES) {
		if (accepts.has(t)) return t;
	}
	return "text";
}

/**
 * Typed literal input. The visual variant is picked from the
 * property's declared `data_type` (or the explicit
 * `overrideDataType` when set). The constructed `Literal` carries
 * `data_type` for date / time / datetime values so the type
 * checker resolves them to the correct ordered types — see
 * `dateLiteral` / `datetimeLiteral` / `timeLiteral` in the
 * predicate builders for the contract.
 */
export function LiteralValueInput({
	value,
	onChange,
	caseTypeName,
	propertyName,
	overrideDataType,
	accepts,
	nonEmpty = false,
	invalid = false,
	ariaLabel = "Value",
}: LiteralValueInputProps) {
	const ctx = usePredicateEditContext();
	const property = useMemo<CaseProperty | undefined>(() => {
		if (propertyName === undefined) return undefined;
		const ct: CaseType | undefined = ctx.caseTypes.find(
			(c) => c.name === caseTypeName,
		);
		if (ct === undefined) return undefined;
		return ct.properties.find((p) => p.name === propertyName);
	}, [ctx.caseTypes, caseTypeName, propertyName]);

	// Widget-type resolution, in precedence order:
	//   1. caller-supplied `overrideDataType` (search-input refs whose
	//      declared type lives on `SearchInputDecl`, not on a case
	//      property);
	//   2. the resolved property's effective type;
	//   3. the slot's accept-set (a literal-list value whose `left`
	//      isn't a property ref — pick a widget the slot accepts);
	//   4. `text` (CommCare's default for un-annotated properties).
	const dataType: string =
		overrideDataType ??
		(property
			? effectiveDataType(property)
			: accepts !== undefined
				? widgetDataTypeFromAccepts(accepts)
				: "text");

	if (propertyName === undefined && accepts === undefined) {
		return (
			<div className="rounded-md border border-dashed border-white/[0.06] px-3 py-2 text-[13px] text-nova-text-muted">
				Choose case information first
			</div>
		);
	}

	// No property / override anchors a widget type, and the slot's
	// accept-set names no type a typed widget can author (a geopoint-only
	// set). The only literal compatible with such a slot is `null`, so
	// render the null-only control rather than a free text input. A
	// pre-existing non-null literal (legacy) still renders read-only so it
	// round-trips — the same current-value exemption the shape menus make.
	if (
		property === undefined &&
		overrideDataType === undefined &&
		accepts !== undefined &&
		!hasWidgetableType(accepts)
	) {
		return <NullOnlyLiteral value={value} />;
	}

	switch (dataType) {
		case "int":
		case "decimal":
			return (
				<NumericInput
					value={value}
					onChange={onChange}
					integerOnly={dataType === "int"}
					invalid={invalid}
					ariaLabel={ariaLabel}
				/>
			);
		case "date":
			return (
				<DateInput
					value={value}
					onChange={(v) => {
						onChange(dateLiteral(v));
					}}
					kind="date"
					nonEmpty={nonEmpty}
					invalid={invalid}
					ariaLabel={ariaLabel}
				/>
			);
		case "datetime":
			return (
				<DateInput
					value={value}
					onChange={(v) => {
						onChange(datetimeLiteral(v));
					}}
					kind="datetime"
					nonEmpty={nonEmpty}
					invalid={invalid}
					ariaLabel={ariaLabel}
				/>
			);
		case "time":
			return (
				<DateInput
					value={value}
					onChange={(v) => {
						onChange(timeLiteral(v));
					}}
					kind="time"
					nonEmpty={nonEmpty}
					invalid={invalid}
					ariaLabel={ariaLabel}
				/>
			);
		case "single_select":
		case "multi_select":
			return (
				<SelectOptionInput
					value={value}
					onChange={onChange}
					options={property?.options ?? []}
					invalid={invalid}
					ariaLabel={ariaLabel}
				/>
			);
		case "geopoint":
			// A geopoint property has no literal widget — the only literal
			// compatible with a place is `null`. Render the null-only
			// control (legacy non-null values still show read-only) rather
			// than a free text input that could commit a text coordinate the
			// checker rejects.
			return <NullOnlyLiteral value={value} />;
		default:
			return (
				<TextInput
					value={value}
					onChange={onChange}
					nonEmpty={nonEmpty}
					invalid={invalid}
					ariaLabel={ariaLabel}
				/>
			);
	}
}

const INPUT_BASE_CLS =
	"h-auto min-h-11 w-full rounded-lg border bg-nova-deep/50 px-3 text-sm text-nova-text placeholder:text-nova-text-muted md:text-sm dark:bg-nova-deep/50";
const INPUT_VALID_CLS =
	"border-white/[0.06] focus-visible:border-nova-violet/40 focus-visible:ring-nova-violet/30";
const INPUT_INVALID_CLS =
	"border-nova-rose/40 focus-visible:border-nova-rose/60 focus-visible:ring-nova-rose/30";

function inputCls(invalid: boolean): string {
	return `${INPUT_BASE_CLS} ${invalid ? INPUT_INVALID_CLS : INPUT_VALID_CLS}`;
}

interface ScalarInputProps {
	readonly value: Literal | undefined;
	readonly onChange: (next: Literal) => void;
	readonly invalid: boolean;
	readonly ariaLabel: string;
}

/**
 * Text-typed literal input. Commits on blur — keystroke commits
 * would re-run the type checker on every character, hammering it.
 * The local draft state preserves the in-flight edit until blur.
 *
 * The draft re-syncs to the external `value` only when the input
 * itself is not focused — comparing the input's own ref against
 * `document.activeElement` (rather than the global tag-only check)
 * keeps a peer input's focus from blocking a re-sync of this one.
 */
function TextInput({
	value,
	onChange,
	nonEmpty = false,
	invalid,
	ariaLabel,
}: ScalarInputProps & { readonly nonEmpty?: boolean }) {
	const inputRef = useRef<HTMLInputElement>(null);
	const requiredErrorId = useId();
	const initial = typeof value?.value === "string" ? value.value : "";
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
	//     pulse on an untouched input from re-emitting the AST.
	//   - A `nonEmpty` slot preserves an emptied draft and explains
	//     how to correct it rather than mysteriously restoring the
	//     prior value or committing `literal("")`.
	//   - On a real edit, `rebuildLiteralPreservingDataType` carries
	//     the source's `data_type` qualifier through. A literal
	//     declared `data_type: "date"` (or any other qualifier) at a
	//     text-typed property slot stays declared after the edit;
	//     the bare `literal(draft)` rebuild would drop it.
	//   - When the source is undefined (no prior literal), commit
	//     emits a bare `literal(draft)` — there's no qualifier to
	//     preserve.
	const commit = useCallback(() => {
		if (nonEmpty && draft === "") {
			setShowRequiredError(true);
			return;
		}
		setShowRequiredError(false);
		if (draft === initial) return;
		onChange(
			value === undefined
				? literal(draft)
				: rebuildLiteralPreservingDataType(value, draft),
		);
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
				placeholder="Enter text"
				aria-label={ariaLabel}
				aria-invalid={effectiveInvalid || undefined}
				aria-describedby={showRequiredError ? requiredErrorId : undefined}
				className={inputCls(effectiveInvalid)}
			/>
			{showRequiredError ? <RequiredValueError id={requiredErrorId} /> : null}
		</div>
	);
}

interface NumericInputProps extends ScalarInputProps {
	readonly integerOnly: boolean;
}

/**
 * Numeric literal input — int or decimal. Integers retain the native
 * number control; decimals use a text control with `inputMode="decimal"`
 * so an incomplete or malformed draft remains visible for correction
 * instead of being sanitized away by the browser. Commits on blur.
 * A decimal may be intentionally cleared to `literal(null)`; every
 * other invalid draft stays local with a friendly correction.
 */
function NumericInput({
	value,
	onChange,
	invalid,
	ariaLabel,
	integerOnly,
}: NumericInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const numberErrorId = useId();
	const initial = typeof value?.value === "number" ? String(value.value) : "";
	const [draft, setDraft] = useState(initial);
	const [showNumberError, setShowNumberError] = useState(false);
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
			setShowNumberError(false);
		}
	}, [initial, draft]);
	// Commit gating + qualifier preservation: same shape as
	// `TextInput`'s commit. Decimal empty-input emits a `literal(null)`
	// preserving the source's qualifier (the type checker treats null
	// as universally compatible). Every non-empty draft must parse as a
	// finite number; integers additionally require a whole number before
	// the qualifier-preserving rebuild runs.
	const commit = useCallback(() => {
		const next = (nextValue: string | number | boolean | null) =>
			value === undefined
				? literal(nextValue)
				: rebuildLiteralPreservingDataType(value, nextValue);
		if (integerOnly) {
			const parsed = finiteInteger(draft);
			if (parsed === undefined) {
				setShowNumberError(true);
				return;
			}
			setShowNumberError(false);
			if (draft === initial) return;
			onChange(next(parsed));
			return;
		}
		if (draft.trim() === "") {
			setShowNumberError(false);
			if (draft !== initial) onChange(next(null));
			return;
		}
		const parsed = finiteNumber(draft);
		if (parsed === undefined) {
			setShowNumberError(true);
			return;
		}
		setShowNumberError(false);
		if (draft === initial) return;
		onChange(next(parsed));
	}, [draft, initial, integerOnly, onChange, value]);
	const effectiveInvalid = invalid || showNumberError;

	return (
		<div>
			<Input
				ref={inputRef}
				type={integerOnly ? "number" : "text"}
				inputMode={integerOnly ? undefined : "decimal"}
				step={integerOnly ? 1 : undefined}
				value={draft}
				onChange={(event) => {
					const next = event.target.value;
					setDraft(next);
					if (
						showNumberError &&
						(integerOnly
							? finiteInteger(next) !== undefined
							: next.trim() === "" || finiteNumber(next) !== undefined)
					) {
						setShowNumberError(false);
					}
				}}
				onBlur={commit}
				autoComplete="off"
				data-1p-ignore
				aria-label={ariaLabel}
				aria-invalid={effectiveInvalid || undefined}
				aria-describedby={showNumberError ? numberErrorId : undefined}
				className={inputCls(effectiveInvalid)}
			/>
			{showNumberError ? (
				<FieldError
					id={numberErrorId}
					className="mt-2 text-[13px] leading-5 text-nova-rose"
				>
					{integerOnly ? "Enter a whole number" : "Enter a number"}
				</FieldError>
			) : null}
		</div>
	);
}

function finiteInteger(draft: string): number | undefined {
	if (draft.trim() === "") return undefined;
	const parsed = Number(draft);
	return Number.isFinite(parsed) && Number.isInteger(parsed)
		? parsed
		: undefined;
}

function finiteNumber(draft: string): number | undefined {
	if (draft.trim() === "") return undefined;
	const parsed = Number(draft);
	return Number.isFinite(parsed) ? parsed : undefined;
}

interface DateInputProps {
	readonly value: Literal | undefined;
	readonly onChange: (wireValue: string) => void;
	readonly kind: "date" | "datetime" | "time";
	readonly nonEmpty?: boolean;
	readonly invalid: boolean;
	readonly ariaLabel: string;
}

/**
 * Native typed-date / typed-time / typed-datetime input. Browsers
 * drive the picker UX; the wire form is the platform's
 * ISO-formatted output, which matches CommCare's date / datetime
 * conventions when truncated to seconds. Commits on change rather
 * than blur — picker commits are atomic events, not in-flight
 * edits.
 *
 * A required `nonEmpty` slot keeps a cleared picker visible with a
 * correction rather than snapping back to the prior value. Optional
 * temporal values retain their existing empty-string commit semantics.
 */
function DateInput({
	value,
	onChange,
	kind,
	nonEmpty = false,
	invalid,
	ariaLabel,
}: DateInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const requiredErrorId = useId();
	const initial = typeof value?.value === "string" ? value.value : "";
	const [draft, setDraft] = useState(initial);
	const [showRequiredError, setShowRequiredError] = useState(false);
	const inputType =
		kind === "date" ? "date" : kind === "time" ? "time" : "datetime-local";
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
				aria-label={ariaLabel}
				aria-invalid={effectiveInvalid || undefined}
				aria-describedby={showRequiredError ? requiredErrorId : undefined}
				className={inputCls(effectiveInvalid)}
			/>
			{showRequiredError ? <RequiredValueError id={requiredErrorId} /> : null}
		</div>
	);
}

function RequiredValueError({ id }: { readonly id: string }) {
	return (
		<FieldError id={id} className="mt-2 text-[13px] leading-5 text-nova-rose">
			Enter a value
		</FieldError>
	);
}

/**
 * Null-only literal control for a slot whose accept-set names no
 * widget-able type (a geopoint membership / discriminator value — no
 * geopoint literal widget exists, and the only literal compatible with
 * a place is the universally-compatible `null`). A pre-existing non-null
 * literal renders read-only (best-effort) so a saved doc still opens and
 * round-trips, exempting the current value the way the shape menus
 * exempt the active shape.
 */
function NullOnlyLiteral({ value }: { readonly value: Literal | undefined }) {
	const nonNull = value !== undefined && value.value !== null;
	// No `aria-label` — the visible text (the value / "null" + the hint)
	// is the accessible name; a label on a non-interactive div isn't
	// supported by its role.
	return (
		<div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-dashed border-white/[0.08] bg-nova-deep/30 px-3 py-2 text-[13px]">
			{nonNull && (
				<span className="text-nova-text-secondary">{String(value.value)}</span>
			)}
			<span className="text-[13px] leading-relaxed text-nova-text-muted">
				{nonNull
					? "This saved value can't be used as a place. Choose other case information"
					: "Compare this place with other case information"}
			</span>
		</div>
	);
}

interface SelectOptionInputProps extends ScalarInputProps {
	readonly options: readonly { value: string; label: string }[];
}

/**
 * Selectable-option dropdown for single_select / multi_select
 * properties. The values come from the property's declared
 * `options`; selecting one commits a string-typed literal whose
 * value is the option's wire-form `value`.
 *
 * Note: this is single-select for the literal value slot —
 * `multi-select-contains` carries multiple literals via the
 * `values` array on its parent, each independently selected here.
 */
function SelectOptionInput({
	value,
	onChange,
	options,
	invalid,
	ariaLabel,
}: SelectOptionInputProps) {
	const triggerId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const current = typeof value?.value === "string" ? value.value : undefined;
	const ambiguousLabels = useMemo(() => {
		const counts = new Map<string, number>();
		for (const option of options) {
			counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
		}
		return new Set(
			[...counts.entries()]
				.filter(([, count]) => count > 1)
				.map(([label]) => label),
		);
	}, [options]);
	const triggerClass = [
		"group h-auto min-h-11 w-full justify-between rounded-lg border bg-nova-deep/50 px-3 py-2 text-sm text-nova-text whitespace-normal dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50",
		invalid
			? "border-nova-rose/40 not-disabled:hover:border-nova-rose/60"
			: "border-white/[0.06] not-disabled:hover:border-nova-violet/30",
	].join(" ");

	if (options.length === 0) {
		return (
			<div className="rounded-lg border border-dashed border-white/[0.06] px-3 py-2.5 text-[13px] text-nova-text-muted">
				No choices have been added for this information
			</div>
		);
	}

	const display =
		options.find((o) => o.value === current)?.label ??
		current ??
		"Pick a value";

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				id={triggerId}
				aria-label={`${ariaLabel}: ${display}`}
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
				<span
					className={`min-w-0 flex-1 break-words text-left ${
						current ? "text-nova-violet-bright" : "text-nova-text-muted"
					}`}
				>
					{display}
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
					style={{ minWidth: "var(--anchor-width)", maxHeight: 280 }}
				>
					<DropdownMenuPopup className="max-h-72 min-w-0 overflow-y-auto">
						{options.map((opt) => {
							const isActive = opt.value === current;
							const labelIsAmbiguous = ambiguousLabels.has(opt.label);
							return (
								<DropdownMenuItem
									key={opt.value}
									onClick={() => {
										// Qualifier-preserving rebuild on selection.
										// A select-typed literal carries its own
										// `data_type` (`single_select` /
										// `multi_select`) which a fresh `literal(opt.value)`
										// rebuild would silently drop on every click.
										onChange(
											value === undefined
												? literal(opt.value)
												: rebuildLiteralPreservingDataType(value, opt.value),
										);
									}}
									className={
										isActive ? "bg-nova-violet/10 text-nova-violet-bright" : ""
									}
								>
									<span className="flex-1 text-left min-w-0">
										<div className="break-words">{opt.label}</div>
										{labelIsAmbiguous && (
											<div
												className={`break-words text-xs ${
													isActive
														? "text-nova-violet-bright"
														: "text-nova-text-muted"
												}`}
											>
												Saved as {opt.value}
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
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}
