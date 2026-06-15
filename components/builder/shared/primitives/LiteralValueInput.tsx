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
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
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
	timeLiteral,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
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
	/** Shows the slot in an error state. */
	readonly invalid?: boolean;
	/** Accessibility label override (defaults to "Value"). */
	readonly ariaLabel?: string;
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

	// Override-precedence resolution: caller-supplied `overrideDataType`
	// wins (search-input refs whose declared type lives on
	// `SearchInputDecl`, not on a case property), otherwise the
	// resolved property's effective type. The `(property ?
	// effectiveDataType(property) : "text")` shape routes the
	// `data_type ?? "text"` fallback through the shared helper rather
	// than re-deriving the literal — adding a new fallback rule (e.g.
	// for an `unknown` data-type sentinel) lights up every consumer
	// in one edit.
	const dataType: string =
		overrideDataType ?? (property ? effectiveDataType(property) : "text");

	if (propertyName === undefined) {
		return (
			<div className="text-xs text-nova-text-muted/60 italic px-2 py-1.5 rounded-md border border-dashed border-white/[0.06]">
				Select a property first
			</div>
		);
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
		default:
			return (
				<TextInput
					value={value}
					onChange={onChange}
					invalid={invalid}
					ariaLabel={ariaLabel}
				/>
			);
	}
}

const INPUT_BASE_CLS =
	"w-full px-3 min-h-11 text-[13px] rounded-lg border bg-nova-deep/50 text-nova-text placeholder:text-nova-text-muted/60 focus:outline-none focus:ring-1 transition-colors";
const INPUT_VALID_CLS =
	"border-white/[0.06] focus:border-nova-violet/40 focus:ring-nova-violet/30";
const INPUT_INVALID_CLS =
	"border-nova-rose/40 focus:border-nova-rose/60 focus:ring-nova-rose/30";

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
function TextInput({ value, onChange, invalid, ariaLabel }: ScalarInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const initial = typeof value?.value === "string" ? value.value : "";
	const [draft, setDraft] = useState(initial);
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
		}
	}, [initial, draft]);
	// Commit gating + qualifier preservation:
	//   - The no-op `draft === initial` short-circuit keeps a focus
	//     pulse on an untouched input from re-emitting the AST.
	//   - On a real edit, `rebuildLiteralPreservingDataType` carries
	//     the source's `data_type` qualifier through. A literal
	//     declared `data_type: "date"` (or any other qualifier) at a
	//     text-typed property slot stays declared after the edit;
	//     the bare `literal(draft)` rebuild would drop it.
	//   - When the source is undefined (no prior literal), commit
	//     emits a bare `literal(draft)` — there's no qualifier to
	//     preserve.
	const commit = useCallback(() => {
		if (draft === initial) return;
		onChange(
			value === undefined
				? literal(draft)
				: rebuildLiteralPreservingDataType(value, draft),
		);
	}, [draft, initial, onChange, value]);

	return (
		<input
			ref={inputRef}
			type="text"
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			autoComplete="off"
			data-1p-ignore
			placeholder="Enter text"
			aria-label={ariaLabel}
			aria-invalid={invalid || undefined}
			className={inputCls(invalid)}
		/>
	);
}

interface NumericInputProps extends ScalarInputProps {
	readonly integerOnly: boolean;
}

/**
 * Numeric literal input — int or decimal. Native `<input
 * type="number">` constrains keyboard / paste to numeric values
 * and surfaces the platform's spinner controls. Commits on blur;
 * empty input clears the value (commits a `literal(null)` so the
 * type checker treats the slot as the absent-or-null compatibility
 * case).
 */
function NumericInput({
	value,
	onChange,
	invalid,
	ariaLabel,
	integerOnly,
}: NumericInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const initial = typeof value?.value === "number" ? String(value.value) : "";
	const [draft, setDraft] = useState(initial);
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
		}
	}, [initial, draft]);
	// Commit gating + qualifier preservation: same shape as
	// `TextInput`'s commit. Empty-input emits a `literal(null)`
	// preserving the source's qualifier (the type checker treats
	// null as universally compatible); a real numeric edit emits
	// the parsed number through the qualifier-preserving rebuilder.
	const commit = useCallback(() => {
		if (draft === initial) return;
		const next = (nextValue: string | number | boolean | null) =>
			value === undefined
				? literal(nextValue)
				: rebuildLiteralPreservingDataType(value, nextValue);
		if (draft.trim() === "") {
			onChange(next(null));
			return;
		}
		const parsed = integerOnly
			? Number.parseInt(draft, 10)
			: Number.parseFloat(draft);
		if (Number.isNaN(parsed)) return;
		onChange(next(parsed));
	}, [draft, initial, integerOnly, onChange, value]);

	return (
		<input
			ref={inputRef}
			type="number"
			step={integerOnly ? 1 : "any"}
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			autoComplete="off"
			data-1p-ignore
			placeholder={integerOnly ? "0" : "0.0"}
			aria-label={ariaLabel}
			aria-invalid={invalid || undefined}
			className={`${inputCls(invalid)} font-mono`}
		/>
	);
}

interface DateInputProps {
	readonly value: Literal | undefined;
	readonly onChange: (wireValue: string) => void;
	readonly kind: "date" | "datetime" | "time";
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
 */
function DateInput({
	value,
	onChange,
	kind,
	invalid,
	ariaLabel,
}: DateInputProps) {
	const initial = typeof value?.value === "string" ? value.value : "";
	const inputType =
		kind === "date" ? "date" : kind === "time" ? "time" : "datetime-local";
	return (
		<input
			type={inputType}
			value={initial}
			onChange={(e) => onChange(e.target.value)}
			autoComplete="off"
			data-1p-ignore
			aria-label={ariaLabel}
			aria-invalid={invalid || undefined}
			className={`${inputCls(invalid)} font-mono`}
		/>
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
	const triggerClass = [
		"group w-full flex items-center justify-between px-3 min-h-11 text-[13px] rounded-lg border transition-colors cursor-pointer text-nova-text bg-nova-deep/50",
		invalid
			? "border-nova-rose/40 hover:border-nova-rose/60"
			: "border-white/[0.06] hover:border-nova-violet/30",
	].join(" ");

	if (options.length === 0) {
		return (
			<div className="text-xs text-nova-text-muted/60 italic px-2 py-1.5 rounded-md border border-dashed border-white/[0.06]">
				This property has no declared options
			</div>
		);
	}

	const display =
		options.find((o) => o.value === current)?.label ??
		current ??
		"Pick a value";

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				id={triggerId}
				aria-label={`${ariaLabel}: ${display}`}
				className={triggerClass}
			>
				<span
					className={`truncate ${
						current ? "text-nova-violet-bright" : "text-nova-text-muted"
					}`}
				>
					{display}
				</span>
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
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
					style={{ minWidth: "var(--anchor-width)", maxHeight: 280 }}
				>
					<Menu.Popup className={`${MENU_POPUP_CLS} max-h-72 overflow-y-auto`}>
						{options.map((opt, i) => {
							const isActive = opt.value === current;
							const last = options.length - 1;
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
									className={`${corners} ${
										isActive
											? `${MENU_ITEM_BASE} text-nova-violet-bright bg-nova-violet/10 cursor-pointer`
											: MENU_ITEM_CLS
									}`}
								>
									<span className="flex-1 text-left min-w-0">
										<div className="truncate">{opt.label}</div>
										{opt.label !== opt.value && (
											<div
												className={`text-[10px] font-mono truncate ${
													isActive
														? "text-nova-violet-bright/60"
														: "text-nova-text-muted"
												}`}
											>
												{opt.value}
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
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
