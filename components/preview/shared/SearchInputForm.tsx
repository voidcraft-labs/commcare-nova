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
// and emits to `onChange` debounced at 300 ms so the parent's
// case-list reload trigger fires once per type-burst rather than
// once per keystroke.
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
import { format, parseISO } from "date-fns";
import { CalendarIcon, XIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import type { CaseProperty, CaseType, SearchInputDef } from "@/lib/domain";
import type { SearchInputValues } from "@/lib/preview/engine/runtimeBindings";

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
	/** Fired with the new value bag 300 ms after the user pauses
	 *  typing. The parent's case-list reload trigger keys off this
	 *  reference; debounce in the form keeps the action-call
	 *  cadence sane. */
	readonly onChange: (next: SearchInputValues) => void;
}

const DEBOUNCE_MS = 300;

/** Wire-form date shape — what the runtime-bindings layer's
 *  `parseDateBound` accepts. Centralizing the format string keeps
 *  the running-app form and the SQL emitter speaking the same
 *  shape; a drift here would silently drop bounds at the binding
 *  layer. */
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
}: SearchInputFormProps) {
	const titleId = useId();

	// `draft` is the form's local-typing buffer. Per-input change
	// handlers update it synchronously so the rendered inputs stay
	// responsive; one debounced effect emits upward.
	const [draft, setDraft] = useState<SearchInputValues>(value);

	// `lastEmittedRef` carries the map reference the form most
	// recently handed to `onChange`. The parent's controlled-prop
	// echo lands here too — the sync effect below skips when the
	// incoming `value` matches this ref, so the controlled echo
	// doesn't feed the debounced emitter and produce a runaway loop.
	const lastEmittedRef = useRef<SearchInputValues>(value);

	// Sync external `value` changes into the local draft. Skip when
	// the incoming `value` is the form's own emission echoed back
	// through the parent — that's the steady-state the controlled-
	// component contract creates and is not a real external change.
	useEffect(() => {
		if (value !== lastEmittedRef.current) {
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
		// emission. Two reasons this fires: (a) the controlled echo
		// path above synced `draft = value` where `value` IS the
		// echo; (b) the initial mount where `draft === value === the
		// initial parent map`. Either way, no real user change
		// occurred — emitting again would loop.
		if (draft === lastEmittedRef.current) return;
		const handle = setTimeout(() => {
			lastEmittedRef.current = draft;
			onChange(draft);
		}, DEBOUNCE_MS);
		return () => clearTimeout(handle);
	}, [draft, onChange]);

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

	return (
		<search
			aria-labelledby={titleId}
			className="rounded-lg border border-border bg-card/30 p-4"
		>
			<h3 id={titleId} className="sr-only">
				Search inputs
			</h3>
			<div className="flex flex-col gap-4">
				{searchInputs.map((input) => (
					<SearchInputRow
						key={input.uuid}
						input={input}
						caseType={caseType}
						draft={draft}
						setKey={setKey}
					/>
				))}
			</div>
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
	// Memoize the widget resolution so a parent re-render that
	// doesn't change `(input, caseType)` doesn't force an option-
	// list reconstruction on every keystroke.
	const widget = useMemo(
		() => resolveWidget(input, caseType),
		[input, caseType],
	);

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
				<DateRow
					name={input.name}
					label={input.label}
					value={draft.get(input.name) ?? ""}
					onChange={(next) => setKey(input.name, next)}
				/>
			);
		case "date-range":
			return (
				<DateRangeRow
					name={input.name}
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
				autoComplete="off"
				data-1p-ignore
			/>
		</Field>
	);
}

interface DateRowProps {
	readonly name: string;
	readonly label: string;
	readonly value: string;
	readonly onChange: (next: string) => void;
}

/**
 * Single date-picker row. Trigger reads the ISO-formatted value or
 * a placeholder; the popover hosts a `mode="single"` Calendar that
 * emits the picked `Date`. `date-fns` `format(..., "yyyy-MM-dd")`
 * lands at local-time midnight — matching the runtime-bindings
 * layer's `parseDateBound` ISO-pattern gate without timezone drift
 * (`new Date("2024-01-01")` would parse as UTC midnight and shift
 * negative offsets back a day).
 *
 * The trigger renders inside `PopoverTrigger`'s `render` prop slot
 * — Base UI's composition pattern. The Button component is a
 * `data-slot=button` shadcn primitive over the Base UI Button so
 * focus + keyboard semantics flow through.
 */
function DateRow({ name, label, value, onChange }: DateRowProps) {
	const id = useId();
	const selected = value === "" ? undefined : parseISO(value);
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Popover>
				<PopoverTrigger
					id={id}
					name={name}
					render={
						<Button
							variant="outline"
							size="sm"
							className="w-full justify-between font-normal data-placeholder:text-muted-foreground"
							data-placeholder={selected === undefined ? "" : undefined}
						/>
					}
				>
					<span className="truncate">
						{selected === undefined
							? "Pick a date"
							: format(selected, ISO_DATE_FORMAT)}
					</span>
					<CalendarIcon className="size-3.5 ml-auto" />
				</PopoverTrigger>
				<PopoverContent align="start" className="w-auto p-0">
					<Calendar
						mode="single"
						selected={selected}
						onSelect={(next) => {
							onChange(next === undefined ? "" : format(next, ISO_DATE_FORMAT));
						}}
						autoFocus
					/>
					{selected !== undefined && (
						<div className="flex justify-end border-t border-border p-1.5">
							<Button
								type="button"
								variant="ghost"
								size="xs"
								onClick={() => onChange("")}
							>
								<XIcon />
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
	readonly name: string;
	readonly label: string;
	readonly fromValue: string;
	readonly toValue: string;
	readonly onChangeFrom: (next: string) => void;
	readonly onChangeTo: (next: string) => void;
}

/**
 * Date-range row. Two independent single-date pickers — one per
 * bound — labeled `<name> from` / `<name> to`. Bounds emit under
 * `<name>:from` / `<name>:to`; clearing one bound deletes only
 * that key, mirroring the runtime-bindings layer's per-bound
 * short-circuit.
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
	name,
	label,
	fromValue,
	toValue,
	onChangeFrom,
	onChangeTo,
}: DateRangeRowProps) {
	const groupId = useId();
	return (
		<fieldset
			aria-labelledby={groupId}
			className="flex w-full flex-col gap-2 border-0 p-0 m-0"
		>
			<legend id={groupId} className="text-sm leading-none font-medium">
				{label}
			</legend>
			<div className="grid grid-cols-2 gap-2">
				<DateBoundPicker
					name={`${name}:from`}
					label={`${label} from`}
					value={fromValue}
					onChange={onChangeFrom}
				/>
				<DateBoundPicker
					name={`${name}:to`}
					label={`${label} to`}
					value={toValue}
					onChange={onChangeTo}
				/>
			</div>
		</fieldset>
	);
}

interface DateBoundPickerProps {
	readonly name: string;
	readonly label: string;
	readonly value: string;
	readonly onChange: (next: string) => void;
}

/**
 * One bound of a date-range pair. Structurally identical to
 * `DateRow` but mounted inside a labelled grid cell with a smaller
 * per-bound label — the parent legend names the range, the per-cell
 * label names the bound role. Identity by `name` so screen readers
 * announce "<input> from"/"to" rather than a generic "Pick a date".
 */
function DateBoundPicker({
	name,
	label,
	value,
	onChange,
}: DateBoundPickerProps) {
	const id = useId();
	const selected = value === "" ? undefined : parseISO(value);
	return (
		<Field>
			<FieldLabel
				htmlFor={id}
				className="text-xs font-normal text-muted-foreground"
			>
				{label}
			</FieldLabel>
			<Popover>
				<PopoverTrigger
					id={id}
					name={name}
					render={
						<Button
							variant="outline"
							size="sm"
							className="w-full justify-between font-normal data-placeholder:text-muted-foreground"
							data-placeholder={selected === undefined ? "" : undefined}
						/>
					}
					aria-label={label}
				>
					<span className="truncate">
						{selected === undefined
							? "Pick a date"
							: format(selected, ISO_DATE_FORMAT)}
					</span>
					<CalendarIcon className="size-3.5 ml-auto" />
				</PopoverTrigger>
				<PopoverContent align="start" className="w-auto p-0">
					<Calendar
						mode="single"
						selected={selected}
						onSelect={(next) => {
							onChange(next === undefined ? "" : format(next, ISO_DATE_FORMAT));
						}}
						autoFocus
					/>
					{selected !== undefined && (
						<div className="flex justify-end border-t border-border p-1.5">
							<Button
								type="button"
								variant="ghost"
								size="xs"
								onClick={() => onChange("")}
							>
								<XIcon />
								Clear
							</Button>
						</div>
					)}
				</PopoverContent>
			</Popover>
		</Field>
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
 * Defensive coercion on the trigger's `onValueChange` — the Base UI
 * type system widens the callback's argument when `value` could be
 * `null` in unusual states; we coerce non-string emissions to the
 * empty-string "no selection" wire form so the binding layer's
 * short-circuit fires the same way as a cleared text input.
 */
function SelectRow({ name, label, options, value, onChange }: SelectRowProps) {
	const id = useId();
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Select
				name={name}
				value={value}
				onValueChange={(next) => onChange(typeof next === "string" ? next : "")}
			>
				<SelectTrigger id={id} className="w-full">
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
