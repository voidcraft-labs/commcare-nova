// components/preview/shared/SearchInputForm.tsx
//
// Running-app search-input form. Renders one widget per
// `SearchInputDef` mounted at the top of the case list when the
// module's `caseListConfig.searchInputs` is non-empty. The widget
// shape is the same regardless of `input.kind` — a user filling a
// search input doesn't see the simple-vs-advanced distinction; the
// runtime-bindings layer (`composeRuntimeFilter`) handles the
// per-arm value→predicate translation upstream.
//
// The form is fully controlled. `value` flows in from the parent's
// `useState<SearchInputValues>`; local typing buffers in `draft`
// and emits to `onChange` debounced at 300 ms so parent draft state
// stays current without a render per keystroke. When `onSubmit` is
// supplied, the authored button (or Enter) submits the latest local
// draft immediately; the running list does not race the debounce.
//
// Per-type widget dispatch:
//
//   text     → `<Input>` (shadcn Input — Base UI Input under the hood)
//   barcode  → `<Input>` — barcodes scan as plain strings on the
//              wire side; the text input mirrors that shape and
//              accepts pasted scanner output.
//   date     → `<Popover>` + `<Calendar mode="single">` —
//              value emits as ISO `YYYY-MM-DD` to match the
//              runtime-bindings layer's `parseDateBound` shape.
//   date-range → two `<Popover>` + `<Calendar mode="single">`
//                pickers (one per bound). Values emit under
//                `<name>:from` / `<name>:to`. Bounds are
//                independent — clearing one leaves the other
//                intact, mirroring the runtime-bindings layer's
//                per-bound short-circuit.
//   select   → `<Select>` populated from the targeted property's
//              declared options. Options resolve only when the
//              input is on the simple arm AND the property exists
//              on the case type AND the property declares
//              options. Anything else (advanced arm, missing
//              property, no options, undefined caseType) falls
//              back to `<Input>` — the advanced arm's predicate
//              AST is structurally ambiguous about the option-
//              source property, so surfacing a select would lie.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerCalendar from "@iconify-icons/tabler/calendar";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerX from "@iconify-icons/tabler/x";
import { format, isValid, parseISO } from "date-fns";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Calendar } from "@/components/shadcn/calendar";
import { Field, FieldLabel } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { bySortKey } from "@/lib/doc/order/compare";
import type { CaseProperty, CaseType, SearchInputDef } from "@/lib/domain";
import {
	ISO_DATE_PATTERN,
	type SearchInputValues,
} from "@/lib/preview/engine/runtimeBindings";

// ── Public surface ──────────────────────────────────────────────────

interface SearchInputFormProps {
	/** The module's authored search inputs. Iteration order drives the
	 *  rendered field order; sibling uniqueness is enforced upstream
	 *  at the schema layer. */
	readonly searchInputs: ReadonlyArray<SearchInputDef>;
	/** The module's case type — needed to resolve a select-typed
	 *  input's option list off the property's declaration. May be
	 *  undefined during blueprint hydration; select-typed inputs
	 *  fall back to text in that case. */
	readonly caseType: CaseType | undefined;
	/** Controlled per-input value bag. `<name>:from` / `<name>:to`
	 *  for range bounds; bare `<name>` otherwise. Mirrors the
	 *  runtime-bindings layer's input-value contract verbatim. */
	readonly value: SearchInputValues;
	/** Fired with the new draft bag 300 ms after the user pauses typing. */
	readonly onChange: (next: SearchInputValues) => void;
	/** Optional running-app submit action. When present, the form owns the
	 *  button so pressing Enter or clicking submits its latest local draft
	 *  immediately, without waiting for the typing debounce. */
	readonly onSubmit?: (value: SearchInputValues) => void;
	readonly submitLabel?: string;
}

const DEBOUNCE_MS = 300;

/** Wire-form date shape — the literal `date-fns` format string the
 *  form emits and `parseDateBound` reads. Matches the `ISO_DATE_PATTERN`
 *  the binding layer enforces; a drift between the format string
 *  and the pattern would silently drop bounds at parsing. */
const ISO_DATE_FORMAT = "yyyy-MM-dd";

/**
 * Running-app search-input form. Mounts at the top of the case-list
 * screen when the module declares any search inputs; the form is the
 * single point where typed user values flow into the case-list
 * query.
 */
export function SearchInputForm({
	searchInputs,
	caseType,
	value,
	onChange,
	onSubmit,
	submitLabel = "Search",
}: SearchInputFormProps) {
	const titleId = useId();

	// `draft` is the form's local-typing buffer. Per-input change
	// handlers update it synchronously so the rendered inputs stay
	// responsive; one debounced effect emits upward.
	const [draft, setDraft] = useState<SearchInputValues>(value);

	// `lastEmittedRef` carries the value most recently treated as
	// "already emitted" by the form. Two writes land here:
	//   - The sync effect below stamps the parent's incoming `value`
	//     when an external update lands. Without that stamp the
	//     debounce effect would re-emit a fresh-reference Map the
	//     parent just pushed in (the realistic shape: parent calls
	//     `setValues(new Map(...))`), echoing parent updates back as
	//     user typing.
	//   - The debounce effect stamps the draft right before invoking
	//     `onChangeRef.current(draft)` so the parent's controlled
	//     echo doesn't trigger a second emission.
	const lastEmittedRef = useRef<SearchInputValues>(value);

	// Pin the callback in a ref so the debounce effect's deps stay
	// `[draft]` alone. A parent passing an inline arrow
	// `(next) => setValues(next)` produces a fresh `onChange`
	// identity every render; if the debounce effect depended on
	// `onChange`, each parent re-render under 300 ms would clean up
	// and reschedule the pending timer, and the upward emission
	// would never actually fire under sustained re-render pressure.
	const onChangeRef = useRef(onChange);
	useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	// Sync external `value` changes into the local draft AND stamp
	// `lastEmittedRef` so the debounce effect's "draft already
	// emitted" guard recognizes the new reference and skips
	// scheduling. Without the stamp the parent's own `setValues(...)`
	// call would loop back through this form as a synthetic emission
	// 300 ms later.
	useEffect(() => {
		if (value !== lastEmittedRef.current) {
			lastEmittedRef.current = value;
			setDraft(value);
		}
	}, [value]);

	// Debounced upward emission. The cleanup-on-deps-change pattern
	// resets the timer on every keystroke (each render that mutates
	// `draft` reschedules) — exactly the per-keystroke debounce
	// contract. Cleanup on unmount drops any pending fire so the
	// form doesn't emit after teardown.
	useEffect(() => {
		// Skip when `draft` is the same reference as the last upward
		// emission OR the most recent external value. Either way, no
		// real user change occurred — emitting again would loop.
		if (draft === lastEmittedRef.current) return;
		const handle = setTimeout(() => {
			lastEmittedRef.current = draft;
			onChangeRef.current(draft);
		}, DEBOUNCE_MS);
		return () => clearTimeout(handle);
	}, [draft]);

	// One mutator routed through every per-input change handler.
	// Empty values delete the key — the runtime-bindings layer
	// short-circuits absent and empty alike, so dropping the key
	// keeps the emitted map tight + avoids spurious entries that
	// would only ever evaluate to "no clause" downstream.
	const setKey = (key: string, next: string) => {
		setDraft((prev) => {
			const updated = new Map(prev);
			if (next === "") {
				updated.delete(key);
			} else {
				updated.set(key, next);
			}
			return updated;
		});
	};

	// Zero-input modules render nothing — the caller is the
	// case-list screen, which already guards on
	// `caseListConfig.searchInputs.length > 0` before mounting this
	// component. Returning null here makes the contract self-
	// enforcing: a caller that forgets the guard doesn't surface a
	// labelled-but-empty `<search>` landmark to assistive tech.
	if (searchInputs.length === 0) return null;

	return (
		<search
			aria-labelledby={titleId}
			className="rounded-lg border border-border bg-card/30 p-4"
		>
			<h3 id={titleId} className="sr-only">
				Search inputs
			</h3>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					onSubmit?.(draft);
				}}
			>
				<div className="flex flex-col gap-4">
					{[...searchInputs].sort(bySortKey).map((input) => (
						<SearchInputRow
							key={input.uuid}
							input={input}
							caseType={caseType}
							draft={draft}
							setKey={setKey}
						/>
					))}
				</div>
				{onSubmit !== undefined && (
					<button
						type="submit"
						className="mt-4 inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-md bg-pv-accent px-4 text-sm font-semibold text-white transition-all hover:brightness-110"
					>
						<Icon icon={tablerSearch} width="15" height="15" />
						{submitLabel}
					</button>
				)}
			</form>
		</search>
	);
}

// ── Per-row renderer ───────────────────────────────────────────────

interface SearchInputRowProps {
	readonly input: SearchInputDef;
	readonly caseType: CaseType | undefined;
	readonly draft: SearchInputValues;
	readonly setKey: (key: string, next: string) => void;
}

/**
 * Resolves the input's effective widget shape and dispatches the
 * matching control. The widget shape is the same regardless of
 * `input.kind` — the simple/advanced distinction only affects how
 * the value flows into the predicate, which the runtime-bindings
 * layer owns.
 */
function SearchInputRow({
	input,
	caseType,
	draft,
	setKey,
}: SearchInputRowProps) {
	const widget = resolveWidget(input, caseType);

	switch (widget.kind) {
		case "text":
			return (
				<TextRow
					name={input.name}
					label={input.label}
					value={draft.get(input.name) ?? ""}
					onChange={(next) => setKey(input.name, next)}
				/>
			);
		case "date":
			return (
				<DatePopoverField
					label={input.label}
					value={draft.get(input.name) ?? ""}
					onChange={(next) => setKey(input.name, next)}
				/>
			);
		case "date-range":
			return (
				<DateRangeRow
					label={input.label}
					fromValue={draft.get(`${input.name}:from`) ?? ""}
					toValue={draft.get(`${input.name}:to`) ?? ""}
					onChangeFrom={(next) => setKey(`${input.name}:from`, next)}
					onChangeTo={(next) => setKey(`${input.name}:to`, next)}
				/>
			);
		case "select":
			return (
				<SelectRow
					name={input.name}
					label={input.label}
					options={widget.options}
					value={draft.get(input.name) ?? ""}
					onChange={(next) => setKey(input.name, next)}
				/>
			);
	}
}

// ── Widget resolution ──────────────────────────────────────────────

/** Discriminated widget shape. The select arm carries the resolved
 *  options inline so the renderer doesn't re-walk the case type;
 *  text is the unified fallback for every "can't resolve a select"
 *  branch. Barcode collapses into the text arm at this layer — they
 *  share the same control. */
type ResolvedWidget =
	| { readonly kind: "text" }
	| { readonly kind: "date" }
	| { readonly kind: "date-range" }
	| {
			readonly kind: "select";
			readonly options: ReadonlyArray<{
				readonly value: string;
				readonly label: string;
			}>;
	  };

/**
 * Resolves the effective widget for an input given the available
 * case type. Encapsulates the fallback rules — every "can't render a
 * real select" path collapses to text so the renderer is a clean
 * switch with no nested defaults. The select-falls-back-to-text rule
 * holds for: advanced-arm inputs (the predicate AST is structurally
 * ambiguous about the option-source property), missing case type
 * (blueprint mid-hydration), unresolvable property (the property was
 * deleted or renamed without a sweep), and properties that declare
 * no options (an empty Select would be a UX dead-end).
 */
function resolveWidget(
	input: SearchInputDef,
	caseType: CaseType | undefined,
): ResolvedWidget {
	switch (input.type) {
		case "text":
		case "barcode":
			return { kind: "text" };
		case "date":
			return { kind: "date" };
		case "date-range":
			return { kind: "date-range" };
		case "select": {
			if (input.kind !== "simple") return { kind: "text" };
			if (caseType === undefined) return { kind: "text" };
			const property = findProperty(caseType, input.property);
			if (property === undefined) return { kind: "text" };
			const options = property.options ?? [];
			if (options.length === 0) return { kind: "text" };
			return { kind: "select", options };
		}
	}
}

/** Resolves a property by name on the supplied case type. */
function findProperty(
	caseType: CaseType,
	propertyName: string,
): CaseProperty | undefined {
	return caseType.properties.find((p) => p.name === propertyName);
}

// ── Per-widget rows ────────────────────────────────────────────────

interface TextRowProps {
	readonly name: string;
	readonly label: string;
	readonly value: string;
	readonly onChange: (next: string) => void;
}

/**
 * Text-input row. Used for both `type: text` and `type: barcode`
 * inputs (barcodes scan as plain strings) AND for every fallback
 * arm of the select dispatch. The single shape keeps the running-
 * app form layout uniform across the various ways a string-typed
 * value can land here.
 */
function TextRow({ name, label, value, onChange }: TextRowProps) {
	const id = useId();
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Input
				id={id}
				name={name}
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="min-h-11"
				autoComplete="off"
				data-1p-ignore
			/>
		</Field>
	);
}

interface DatePopoverFieldProps {
	readonly label: string;
	readonly value: string;
	readonly onChange: (next: string) => void;
	/** Optional override for the `FieldLabel`'s className — date-range
	 *  bounds shrink their per-bound label so the parent legend reads
	 *  as the primary heading. Top-level single-date pickers omit the
	 *  override and inherit the default `FieldLabel` styling. */
	readonly labelClassName?: string;
	/** Optional explicit `aria-label` on the trigger button. Date-
	 *  range bounds set this to disambiguate "from" vs "to" for
	 *  screen readers — `FieldLabel htmlFor` already wires the
	 *  accessible name, but the trigger's button role benefits from
	 *  an explicit label inside a grid where ATs may flatten the
	 *  visual hierarchy. Top-level pickers omit it and rely on the
	 *  label association alone. */
	readonly ariaLabel?: string;
}

/**
 * Date picker — Popover trigger + `mode="single"` Calendar. The
 * trigger button reads the ISO-formatted value or a placeholder;
 * the popover hosts the Calendar that emits the picked `Date`.
 * `date-fns` `format(..., "yyyy-MM-dd")` lands at local-time
 * midnight — matching the runtime-bindings layer's `parseDateBound`
 * ISO-pattern gate without timezone drift (`new Date("2024-01-01")`
 * would parse as UTC midnight and shift negative offsets back a
 * day).
 *
 * Inbound values flow through two gates before reaching `format`:
 *
 *   - The shape gate (`ISO_DATE_PATTERN.test`) accepts only `YYYY-
 *     MM-DD` strings; everything else resolves to `undefined`.
 *   - The calendar-validity gate (`isValid(parseISO(...))`) catches
 *     shape-conforming-but-calendar-invalid values like
 *     `"2024-13-45"` that `parseISO` returns as Invalid Date. The
 *     gate exists because `format(invalidDate, ...)` throws
 *     `RangeError: Invalid time value` and would crash the entire
 *     `<search>` subtree — the regex alone isn't enough.
 *
 * Used as the single-date row AND as each bound of the date-range
 * row. The two callers differ only in label styling + the explicit
 * trigger `aria-label`; both knobs are optional props on this
 * primitive. Screen-reader accessibility lives on the `FieldLabel
 * htmlFor` association + the optional `aria-label` override.
 *
 * The trigger renders inside `PopoverTrigger`'s `render` prop slot —
 * Base UI's composition pattern. The Button component is a
 * `data-slot=button` shadcn primitive over the Base UI Button so
 * focus + keyboard semantics flow through.
 */
function DatePopoverField({
	label,
	value,
	onChange,
	labelClassName,
	ariaLabel,
}: DatePopoverFieldProps) {
	const id = useId();
	const parsed = ISO_DATE_PATTERN.test(value) ? parseISO(value) : undefined;
	const selected = parsed !== undefined && isValid(parsed) ? parsed : undefined;
	// `open` is lifted into local state so a day-pick or Clear can
	// close the popover programmatically. Base UI's Popover dismisses
	// on outside-press / escape / close-press / focus-out only —
	// none fire when a descendant updates its own state, so an
	// uncontrolled popover stays open after a pick. The expected
	// pick → close → next-action cadence (most visible in the date-
	// range where the from popover would otherwise block the user's
	// reach to the to trigger) routes through `setOpen(false)`
	// inside the relevant handlers.
	const [open, setOpen] = useState(false);
	return (
		<Field>
			<FieldLabel htmlFor={id} className={labelClassName}>
				{label}
			</FieldLabel>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger
					id={id}
					aria-label={ariaLabel}
					render={
						<Button
							variant="outline"
							size="sm"
							className="min-h-11 w-full justify-between font-normal data-placeholder:text-muted-foreground"
							data-placeholder={selected === undefined ? "" : undefined}
						/>
					}
				>
					<span className="truncate">
						{selected === undefined
							? "Pick a date"
							: format(selected, ISO_DATE_FORMAT)}
					</span>
					<Icon
						icon={tablerCalendar}
						className="size-3.5 ml-auto"
						aria-hidden="true"
					/>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-auto p-0">
					<Calendar
						mode="single"
						selected={selected}
						onSelect={(next) => {
							onChange(next === undefined ? "" : format(next, ISO_DATE_FORMAT));
							setOpen(false);
						}}
						autoFocus
					/>
					{selected !== undefined && (
						<div className="flex justify-end border-t border-border p-1.5">
							<Button
								type="button"
								variant="ghost"
								size="xs"
								onClick={() => {
									onChange("");
									setOpen(false);
								}}
							>
								<Icon icon={tablerX} aria-hidden="true" />
								Clear
							</Button>
						</div>
					)}
				</PopoverContent>
			</Popover>
		</Field>
	);
}

interface DateRangeRowProps {
	readonly label: string;
	readonly fromValue: string;
	readonly toValue: string;
	readonly onChangeFrom: (next: string) => void;
	readonly onChangeTo: (next: string) => void;
}

/**
 * Date-range row. Two independent single-date pickers — one per
 * bound — labeled `<label> from` / `<label> to`. The parent
 * dispatcher owns the `<name>:from` / `<name>:to` key shape on the
 * value map; this row only sees per-bound values + change handlers
 * so it can't accidentally drift from the binding layer's key
 * convention.
 *
 * A `mode="range"` Calendar would visually unify the two pickers
 * but couples them at the UX layer — touching only the upper
 * bound would require navigating the range Calendar past the
 * lower-bound's anchor. Two single pickers keep each bound's
 * lifecycle independent and let the test suite assert "clearing
 * one bound leaves the other intact" against the structural
 * shape rather than a runtime invariant.
 */
function DateRangeRow({
	label,
	fromValue,
	toValue,
	onChangeFrom,
	onChangeTo,
}: DateRangeRowProps) {
	const groupId = useId();
	const fromLabel = `${label} from`;
	const toLabel = `${label} to`;
	return (
		<fieldset
			aria-labelledby={groupId}
			className="flex w-full flex-col gap-2 border-0 p-0 m-0"
		>
			<legend id={groupId} className="text-sm leading-none font-medium">
				{label}
			</legend>
			<div className="grid grid-cols-2 gap-2">
				<DatePopoverField
					label={fromLabel}
					value={fromValue}
					onChange={onChangeFrom}
					labelClassName="text-xs font-normal text-muted-foreground"
					ariaLabel={fromLabel}
				/>
				<DatePopoverField
					label={toLabel}
					value={toValue}
					onChange={onChangeTo}
					labelClassName="text-xs font-normal text-muted-foreground"
					ariaLabel={toLabel}
				/>
			</div>
		</fieldset>
	);
}

interface SelectRowProps {
	readonly name: string;
	readonly label: string;
	readonly options: ReadonlyArray<{
		readonly value: string;
		readonly label: string;
	}>;
	readonly value: string;
	readonly onChange: (next: string) => void;
}

/**
 * Option-dropdown row. Renders a shadcn Select (Base UI Select
 * primitive) — keyboard navigation, ARIA combobox semantics, and
 * scroll arrows come from the underlying primitive. Empty-string
 * value renders the placeholder; selecting an option emits the
 * option's wire-form `value`.
 *
 * Base UI's `Select.onValueChange` is
 * `(value: Value | null, ...) => void` in single-mode — `null`
 * lands only on programmatic clear paths. With `value: string` on
 * the trigger, TypeScript infers `Value = string` through shadcn's
 * value-level alias, so `next` arrives as `string | null`. The
 * form coalesces `null` to "" so the binding layer's empty-input
 * short-circuit handles both states uniformly.
 */
function SelectRow({ name, label, options, value, onChange }: SelectRowProps) {
	const id = useId();
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Select
				name={name}
				value={value}
				onValueChange={(next) => onChange(next ?? "")}
			>
				<SelectTrigger id={id} className="min-h-11 w-full">
					<SelectValue placeholder="Select…" />
				</SelectTrigger>
				<SelectContent>
					{options.map((opt) => (
						<SelectItem key={opt.value} value={opt.value}>
							{opt.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</Field>
	);
}
