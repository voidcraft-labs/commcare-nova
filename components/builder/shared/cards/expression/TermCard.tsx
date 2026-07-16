// components/builder/shared/cards/expression/TermCard.tsx
//
// Term-arm card for the ValueExpression editor — the universal value
// carrier. Edits any of the five Term variants:
//
//   - `prop` — case property reference (with optional `via:
//     RelationPath` walk preserved across edits via the shared
//     `PropertyRefPicker`).
//   - `input` — search-input ref (named picker over declared inputs).
//   - `session-context` — closed-namespace session field (`userid` /
//     `username` / `deviceid` / `appversion`).
//   - `session-user` — open-namespace user-data field (free-text).
//   - `literal` — primitive constant (string / number / boolean /
//     null) with optional `data_type` qualifier preserved on rebuild.
//
// The card edits ONLY Term-shaped values — non-Term ValueExpression
// arms route through their own dedicated cards (ArithCard / IfCard /
// etc.) at the `ExpressionPicker` shell's registry-driven dispatch.
//
// Valid by construction: the card takes the slot's `SlotConstraint`
// and gates every value source against it — a source that can't
// produce an accepted type is disabled WITH A REASON (never dimmed),
// the property / search-input dropdowns filter to admissible entries,
// and the literal shape menu offers only shapes whose value type the
// slot accepts. A `nonEmpty` slot refuses to commit an empty literal.
// The current source / shape stays selectable even when the constraint
// no longer admits it (legacy-open backstop).

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import tablerSwitch from "@iconify-icons/tabler/switch";
import tablerUser from "@iconify-icons/tabler/user";
import tablerVariable from "@iconify-icons/tabler/variable";
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
	canonicalCasePropertyName,
	effectiveDataType,
} from "@/lib/domain";
import {
	ANY_CONSTRAINT,
	acceptsType,
	dateLiteral,
	datetimeLiteral,
	input,
	type Literal,
	literal,
	prop,
	type ResolvedType,
	reasonFor,
	type SlotConstraint,
	sessionContext,
	sessionUser,
	type Term,
	timeLiteral,
	type ValueExpression,
	term as wrapTerm,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import {
	useEditorErrorsAt,
	useEditorErrorsBelow,
	usePredicateEditContext,
} from "../../editorContext";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { rebuildLiteralPreservingDataType } from "../../literalRebuild";
import type { EditorPath } from "../../path";
import { InlineError } from "../../primitives/CardShell";
import { PropertyRefPicker } from "../../primitives/PropertyRefPicker";
import { reseedLiteralForConstraint } from "../reseed";

/** Default Term-arm value — a `term(literal(""))`. The empty literal
 *  renders the typed text input directly; authors who want a different
 *  Term variant flip the mode menu. */
export function termDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "term" }> {
	return wrapTerm(literal(""));
}

/** Term mode discriminator — one per Term arm. Drives the mode menu
 *  in the card's body. */
type TermMode =
	| "literal"
	| "property"
	| "input"
	| "session-context"
	| "session-user";

interface TermCardProps {
	readonly value: Extract<ValueExpression, { kind: "term" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
	/** The slot's type constraint — gates the value sources and the
	 *  literal shape menu. Defaults to `ANY_CONSTRAINT`. */
	readonly constraint?: SlotConstraint;
	/** Extra entries the picker shell injects into the source menu —
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
 * to `resolveTermType(...)` with the path UNCHANGED — Term-resolution
 * errors land at the slot path, not at `[..., "term"]`. The card
 * therefore looks up errors at its own path, not at a deeper
 * sub-segment.
 */
export function TermCard({
	value,
	onChange,
	path,
	constraint = ANY_CONSTRAINT,
	computedItems,
}: TermCardProps) {
	const ctx = usePredicateEditContext();
	// Term-side error rendering — two sources:
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

	const modeAdmission = useMemo(
		() => computeModeAdmission(ctx, constraint),
		[ctx, constraint],
	);

	const setMode = (next: TermMode) => {
		// Rebuild via the matching builder so the constructed shape
		// stays canonical. The mode switch resets the inner Term to a
		// per-mode default chosen valid for the slot's constraint;
		// preserving the source content across modes would require a
		// per-mode coercion table that doesn't exist (a literal text "5"
		// doesn't naturally become `prop("patient", "5")`).
		onChange(wrapTerm(buildTermDefault(next, ctx, constraint)));
	};

	return (
		<div className="space-y-1">
			<div className="grid grid-cols-1 @md:grid-cols-[auto_1fr] gap-2 items-start">
				<ModeMenu
					mode={mode}
					setMode={setMode}
					admission={modeAdmission}
					computedItems={computedItems}
				/>
				<TermBodyInput
					term={term}
					onChange={(t) => onChange(wrapTerm(t))}
					constraint={constraint}
					invalid={errors.length > 0 || descendantErrors.length > 0}
				/>
			</div>
			{descendantErrors.length > 0 && <InlineError errors={descendantErrors} />}
		</div>
	);
}

/** Read the mode discriminator from the Term's `kind`. Maps `prop`
 *  to "property" because the user-facing label is "Case property"
 *  rather than "Prop"; every other kind reads through unchanged. */
function termMode(term: Term): TermMode {
	switch (term.kind) {
		case "literal":
			return "literal";
		case "prop":
			return "property";
		case "input":
			return "input";
		case "session-context":
			return "session-context";
		case "session-user":
			return "session-user";
	}
}

/** Whether the slot accepts a value of type `t` — `ANY_CONSTRAINT`
 *  admits everything. */
function constraintAdmitsType(
	constraint: SlotConstraint,
	t: ResolvedType,
): boolean {
	return constraint.accepts === "any" || acceptsType(constraint, t);
}

/** A property filter derived from the slot constraint — `undefined`
 *  (no narrowing) when the constraint is unconstrained. Memoize at the
 *  call site so `PropertyPicker`'s `[caseType, filter]` memo stays
 *  stable across renders with the same constraint. */
function propertyFilterFor(
	constraint: SlotConstraint,
): ((p: CaseProperty) => boolean) | undefined {
	if (constraint.accepts === "any") return undefined;
	return (p) => acceptsType(constraint, effectiveDataType(p));
}

/** Per-mode admission verdict + reason for the source menu. */
type ModeAdmission = Record<TermMode, { admitted: boolean; reason?: string }>;

/**
 * Resolve which Term sources can produce a value the slot accepts:
 *   - `literal` — always admitted; a literal can be `null`, which is
 *     compatible with every type, and the shape menu does the
 *     fine-grained gating per accepted type.
 *   - `property` — admitted when a property of an accepted type
 *     exists on the current case type.
 *   - `input` — admitted when a declared search input of an accepted
 *     type is in scope.
 *   - `session-context` / `session-user` — resolve to `text`, so
 *     admitted only when the slot accepts text.
 */
function computeModeAdmission(
	ctx: ExpressionEditContext,
	constraint: SlotConstraint,
): ModeAdmission {
	const reason = reasonFor(constraint);
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const hasAcceptedProperty =
		constraint.accepts === "any" ||
		(ct?.properties.some((p) =>
			acceptsType(constraint, effectiveDataType(p)),
		) ??
			false);
	const hasAcceptedInput =
		constraint.accepts === "any" ||
		ctx.knownInputs.some((i) => acceptsType(constraint, i.data_type ?? "text"));
	const textAdmitted = constraintAdmitsType(constraint, "text");
	return {
		literal: { admitted: true },
		property: hasAcceptedProperty
			? { admitted: true }
			: { admitted: false, reason },
		input: hasAcceptedInput ? { admitted: true } : { admitted: false, reason },
		"session-context": textAdmitted
			? { admitted: true }
			: { admitted: false, reason },
		"session-user": textAdmitted
			? { admitted: true }
			: { admitted: false, reason },
	};
}

/** Build the per-mode default Term used when the user flips modes.
 *  Each mode's default is chosen valid for the slot's constraint — a
 *  property / input of an accepted type, an empty literal of an
 *  accepted shape — so picking an enabled source never lands a type
 *  error. The type checker still surfaces "fill this in" for an unbound
 *  placeholder (an empty property name). */
function buildTermDefault(
	mode: TermMode,
	ctx: ExpressionEditContext,
	constraint: SlotConstraint,
): Term {
	switch (mode) {
		case "literal":
			return constraint.accepts === "any"
				? literal("")
				: reseedLiteralForConstraint(literal(""), constraint.accepts);
		case "property": {
			const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
			const filter = propertyFilterFor(constraint);
			const property = ct?.properties.find((p) => (filter ? filter(p) : true));
			// Default to a placeholder property name — the picker surfaces
			// "Pick a property" until the author picks one, and the type
			// checker surfaces "Unknown property ''" inline.
			return prop(
				ctx.currentCaseType,
				canonicalCasePropertyName(property?.name ?? ""),
			);
		}
		case "input": {
			const matching = ctx.knownInputs.find((i) =>
				constraint.accepts === "any"
					? true
					: acceptsType(constraint, i.data_type ?? "text"),
			);
			return input(matching?.name ?? ctx.knownInputs[0]?.name ?? "");
		}
		case "session-context":
			// `userid` is the most authored choice ("owned by me"
			// filters in the case-list); other fields require an
			// explicit pick.
			return sessionContext("userid");
		case "session-user":
			// Open-namespace user-data field — defaults to a placeholder.
			// The card surfaces a per-slot error until the author types
			// a real field name.
			return sessionUser("");
	}
}

interface ModeMenuProps {
	readonly mode: TermMode;
	readonly setMode: (mode: TermMode) => void;
	readonly admission: ModeAdmission;
	readonly computedItems?: React.ReactNode;
}

function ModeMenu({ mode, setMode, admission, computedItems }: ModeMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const triggerId = useId();
	const ctx = usePredicateEditContext();

	const items = useMemo<
		readonly { mode: TermMode; label: string; icon: IconifyIcon }[]
	>(() => {
		const base: { mode: TermMode; label: string; icon: IconifyIcon }[] = [
			{ mode: "literal", label: "Typed Value", icon: tablerVariable },
			{ mode: "property", label: "Case Property", icon: tablerDatabase },
		];
		if (ctx.knownInputs.length > 0) {
			base.push({
				mode: "input",
				label: "Search Field",
				icon: tablerSwitch,
			});
		}
		base.push({
			mode: "session-context",
			label: "Session Field",
			icon: tablerUser,
		});
		base.push({
			mode: "session-user",
			label: "User-Data Field",
			icon: tablerSparkles,
		});
		return base;
	}, [ctx.knownInputs]);

	const activeItem = items.find((i) => i.mode === mode) ?? items[0];

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				id={triggerId}
				aria-label={`Term source: ${activeItem.label}`}
				className="group flex items-center gap-1.5 px-3 min-h-11 text-[13px] rounded-lg border border-white/[0.06] bg-nova-deep/50 text-nova-text-muted hover:border-nova-violet/30 hover:text-nova-text transition-colors cursor-pointer"
			>
				<Icon
					icon={activeItem.icon}
					width="14"
					height="14"
					className="text-nova-violet-bright"
				/>
				<span>{activeItem.label}</span>
				<svg
					aria-hidden="true"
					width="10"
					height="10"
					viewBox="0 0 10 10"
					className="shrink-0 transition-transform group-data-[popup-open]:rotate-180"
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
				>
					<Menu.Popup className={MENU_POPUP_CLS}>
						{items.map((item, i) => {
							const isActive = item.mode === mode;
							// The active source stays selectable even when the
							// constraint no longer admits it (legacy-open backstop);
							// every other inadmissible source is disabled with its
							// reason rather than dimmed-but-clickable.
							const verdict = admission[item.mode];
							const admitted = isActive || verdict.admitted;
							const last = items.length - 1;
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
									key={item.mode}
									disabled={!admitted}
									onClick={() => setMode(item.mode)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									} ${admitted ? "" : "opacity-45"}`}
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
										<div className="truncate">{item.label}</div>
										{!admitted && verdict.reason !== undefined && (
											<div className="text-[11px] truncate text-nova-text-muted">
												{verdict.reason}
											</div>
										)}
									</span>
								</Menu.Item>
							);
						})}
						{computedItems !== undefined && (
							<>
								<div
									className="px-3 pt-2.5 pb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-nova-text-muted border-t border-white/[0.06] mt-1"
									role="presentation"
								>
									Computed
								</div>
								{computedItems}
							</>
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

interface TermBodyInputProps {
	readonly term: Term;
	readonly onChange: (next: Term) => void;
	readonly constraint: SlotConstraint;
	readonly invalid: boolean;
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
	constraint,
	invalid,
}: TermBodyInputProps) {
	const propertyFilter = useMemo(
		() => propertyFilterFor(constraint),
		[constraint],
	);
	switch (term.kind) {
		case "literal":
			// Free-form literal — no anchor property to derive the input
			// variant from. `LiteralCardEditor` reads the literal's own
			// `data_type` qualifier (or the JS-runtime type of `value` as
			// a fallback) to pick text / number / boolean / null / typed-
			// date inputs, gating the shape menu to the constraint's
			// accepted types. Unlike `LiteralValueInput` (which short-
			// circuits on missing propertyName), this inline editor
			// supports the bare-literal case so authors can author a
			// literal at any value slot without a property anchor.
			return (
				<LiteralCardEditor
					value={term}
					onChange={onChange}
					constraint={constraint}
					invalid={invalid}
				/>
			);
		case "prop":
			// Routes through `PropertyRefPicker` so the prop's optional
			// `via: RelationPath` walk round-trips on every property name
			// change. The picker handles the canonical-vs-non-canonical
			// branch internally and rebuilds via `prop(caseType, name,
			// via)` (three-arg form) — bypassing this primitive would
			// silently drop authored relation walks on first user click.
			// The constraint filter narrows the dropdown to properties of
			// an accepted type.
			return (
				<PropertyRefPicker
					mode="property-only"
					value={term}
					onChange={(next) => onChange(next)}
					filter={propertyFilter}
					invalid={invalid}
				/>
			);
		case "input":
			return (
				<InputRefMenu
					value={term.name}
					onChange={(name) => onChange(input(name))}
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
					onChange={(field) => onChange(sessionUser(field))}
					invalid={invalid}
				/>
			);
	}
}

interface InputRefMenuProps {
	readonly value: string | undefined;
	readonly onChange: (name: string) => void;
	readonly constraint: SlotConstraint;
	readonly invalid: boolean;
}

/** Search-input dropdown — picks from declared search inputs in
 *  scope whose declared type the slot accepts. Empty when no
 *  admissible inputs exist; the editor surfaces a hint and the type
 *  checker emits the resolution error. The currently-selected input
 *  always shows (legacy-open backstop) even when its type is no longer
 *  admitted. */
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
					i.name === value ||
					constraint.accepts === "any" ||
					acceptsType(constraint, i.data_type ?? "text"),
			),
		[ctx.knownInputs, constraint, value],
	);
	const current = items.find((i) => i.name === value);
	const triggerClass = [
		"group w-full flex items-center justify-between px-3 min-h-11 text-[13px] rounded-lg border transition-colors cursor-pointer text-nova-text bg-nova-deep/50",
		invalid
			? "border-nova-rose/40"
			: "border-white/[0.06] hover:border-nova-violet/30",
	].join(" ");

	if (items.length === 0) {
		return (
			<div className="text-xs text-nova-text-muted italic px-2 py-1.5 rounded-md border border-dashed border-white/[0.06]">
				No matching search inputs
			</div>
		);
	}

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				className={triggerClass}
				aria-label={`Search input: ${current?.name ?? "Pick an input"}`}
			>
				<span className="font-mono truncate text-nova-violet-bright">
					{current?.name ?? "Pick an input"}
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
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<Menu.Popup className={MENU_POPUP_CLS}>
						{items.map((it, i) => {
							const isActive = it.name === value;
							const last = items.length - 1;
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
									key={it.name}
									onClick={() => onChange(it.name)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									}`}
								>
									<span className="font-mono">{it.name}</span>
									{it.data_type && (
										<span className="text-[10px] uppercase tracking-wider text-nova-text-muted">
											{it.data_type}
										</span>
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
		{ field: "userid", label: "User ID" },
		{ field: "username", label: "Username" },
		{ field: "deviceid", label: "Device ID" },
		{ field: "appversion", label: "App Version" },
	];
	const current = items.find((i) => i.field === value) ?? items[0];
	const triggerClass = [
		"group w-full flex items-center justify-between px-3 min-h-11 text-[13px] rounded-lg border transition-colors cursor-pointer text-nova-text bg-nova-deep/50",
		invalid
			? "border-nova-rose/40"
			: "border-white/[0.06] hover:border-nova-violet/30",
	].join(" ");

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				className={triggerClass}
				aria-label={`Session field: ${current.label}`}
			>
				<span className="text-nova-violet-bright">{current.label}</span>
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
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<Menu.Popup className={MENU_POPUP_CLS}>
						{items.map((it, i) => {
							const isActive = it.field === value;
							const last = items.length - 1;
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
									key={it.field}
									onClick={() => onChange(it.field)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									}`}
								>
									<span>{it.label}</span>
									<span className="text-[10px] font-mono text-nova-text-muted">
										{it.field}
									</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

/** Free-form literal editor — reads the existing literal's
 *  `data_type` qualifier (or its JS-runtime value type when no
 *  qualifier is set) to pick the input shape. Five shapes:
 *    - `data_type === "date" / "datetime" / "time"` → typed-date
 *      input. The wire form is the platform's ISO-formatted string.
 *      Edits commit through the matching `dateLiteral` /
 *      `datetimeLiteral` / `timeLiteral` builder so the qualifier
 *      survives every keystroke.
 *    - `value` typeof "number" → numeric input. Decimals and ints
 *      both round-trip through `Number.parseFloat`; the type
 *      checker classifies via `Number.isInteger`.
 *    - `value` typeof "boolean" → segmented true/false toggle.
 *    - `value === null` → "null" sentinel chip + a "use a value"
 *      affordance that swaps to a text literal.
 *    - default → text input.
 *
 *  Mode picker on the leading edge lets the author flip between
 *  shapes — offering only shapes whose value type the slot accepts,
 *  the current shape always included (legacy-open backstop). Flipping
 *  is a destructive operation — it RESETS the literal to the new
 *  shape's default value via `buildLiteralForShape`, replacing both
 *  the value and the `data_type` qualifier (e.g. flipping
 *  `dateLiteral("2024")` to text shape commits `literal("")` — empty
 *  value, qualifier cleared). Edits within a single shape preserve the
 *  qualifier via `rebuildLiteralPreservingDataType`; the shape menu is
 *  the one path that rebases the qualifier intentionally.
 *
 *  The `LiteralValueInput` primitive handles property-anchored
 *  typed inputs; this editor handles the free-form case where no
 *  anchor property exists. */
function LiteralCardEditor({
	value,
	onChange,
	constraint,
	invalid,
}: {
	readonly value: Literal;
	readonly onChange: (next: Literal) => void;
	readonly constraint: SlotConstraint;
	readonly invalid: boolean;
}) {
	// Mode classification — drives the input variant. Reads through
	// the literal's `data_type` qualifier first (highest fidelity),
	// then the JS runtime type as a fallback for unqualified
	// literals.
	const literalShape = classifyLiteralShape(value);
	const setShape = (next: LiteralShape) => {
		onChange(buildLiteralForShape(next));
	};

	return (
		// Always one row — the type chip + its input read as a single
		// typed-value control ("NUMBER · 50"), and the pair fits even
		// the inspector rail's narrow container. Stacking them made the
		// value cost three rows in the rail.
		<div className="grid grid-cols-[auto_1fr] gap-2 items-start">
			<LiteralShapeMenu
				shape={literalShape}
				setShape={setShape}
				constraint={constraint}
			/>
			<LiteralBodyInput
				value={value}
				onChange={onChange}
				shape={literalShape}
				nonEmpty={constraint.nonEmpty === true}
				invalid={invalid}
			/>
		</div>
	);
}

type LiteralShape =
	| "text"
	| "number"
	| "boolean"
	| "null"
	| "date"
	| "datetime"
	| "time";

/** Classify a literal into the editor's shape enum. Reads
 *  `data_type` first (the explicit qualifier set by `dateLiteral`
 *  etc.), then falls back to the JS runtime type — same fallback
 *  the type-checker's `literalType` uses. The classification drives
 *  the input variant; the runtime literal carries the matching
 *  qualifier on rebuild via the `buildLiteralForShape` mapping. */
function classifyLiteralShape(lit: Literal): LiteralShape {
	if (lit.data_type === "date") return "date";
	if (lit.data_type === "datetime") return "datetime";
	if (lit.data_type === "time") return "time";
	if (lit.value === null) return "null";
	if (typeof lit.value === "boolean") return "boolean";
	if (typeof lit.value === "number") return "number";
	return "text";
}

/** The resolved type a literal shape produces — drives the shape
 *  menu's per-shape admission against the slot's accept-set.
 *  `boolean` resolves to `text` (CommCare has no Boolean type); `null`
 *  resolves to the null sentinel (`_any`), compatible with every
 *  type. */
const LITERAL_SHAPE_TYPE: Record<LiteralShape, ResolvedType> = {
	text: "text",
	number: "int",
	boolean: "text",
	null: "_any",
	date: "date",
	datetime: "datetime",
	time: "time",
};

/** Default literal for a given shape. Routes through the typed
 *  builders (`dateLiteral` / `datetimeLiteral` / `timeLiteral` for
 *  the temporal shapes; bare `literal()` for the others). Called
 *  ONLY on shape-menu flip — flipping is a destructive operation
 *  that RESETS both the value and the `data_type` qualifier to the
 *  new shape's defaults. Within-shape edits route through
 *  `rebuildLiteralPreservingDataType` instead, which carries the
 *  source's qualifier through. */
function buildLiteralForShape(shape: LiteralShape): Literal {
	switch (shape) {
		case "text":
			return literal("");
		case "number":
			return literal(0);
		case "boolean":
			return literal(false);
		case "null":
			return literal(null);
		case "date":
			return dateLiteral("");
		case "datetime":
			return datetimeLiteral("");
		case "time":
			return timeLiteral("");
	}
}

const LITERAL_SHAPE_LABELS: Record<LiteralShape, string> = {
	text: "Text",
	number: "Number",
	boolean: "Boolean",
	null: "Null",
	date: "Date",
	datetime: "Datetime",
	time: "Time",
};

/** Per-shape mode picker. Shares the corner-rounding + active-state
 *  styling with the term-mode menu above so the editor reads as
 *  one consistent surface family. Offers only shapes whose value type
 *  the slot accepts; the current shape always shows (legacy-open
 *  backstop). */
function LiteralShapeMenu({
	shape,
	setShape,
	constraint,
}: {
	readonly shape: LiteralShape;
	readonly setShape: (shape: LiteralShape) => void;
	readonly constraint: SlotConstraint;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
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
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Literal type: ${LITERAL_SHAPE_LABELS[shape]}`}
				className="group flex items-center gap-1 px-2.5 min-h-11 text-[10px] uppercase tracking-wider rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-text-muted hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
			>
				<span>{LITERAL_SHAPE_LABELS[shape]}</span>
				<svg
					aria-hidden="true"
					width="10"
					height="10"
					viewBox="0 0 10 10"
					className="shrink-0 transition-transform group-data-[popup-open]:rotate-180"
				>
					<path
						d="M2 3.5L5 6.5L8 3.5"
						stroke="currentColor"
						strokeWidth="1.4"
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
				>
					<Menu.Popup className={MENU_POPUP_CLS}>
						{items.map((s, i) => {
							const isActive = s === shape;
							// The active shape stays selectable even when the
							// constraint no longer admits it (legacy-open backstop).
							const admitted =
								isActive ||
								constraintAdmitsType(constraint, LITERAL_SHAPE_TYPE[s]);
							const last = items.length - 1;
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
									key={s}
									disabled={!admitted}
									onClick={() => setShape(s)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									} ${admitted ? "" : "opacity-45"}`}
								>
									<span className="flex-1 text-left min-w-0">
										<div className="truncate">{LITERAL_SHAPE_LABELS[s]}</div>
										{!admitted && (
											<div className="text-[10px] truncate text-nova-text-muted">
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
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

const LITERAL_INPUT_CLS_VALID =
	"w-full px-3 min-h-11 text-[13px] rounded-lg border border-white/[0.06] bg-nova-deep/50 text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:ring-1 focus:border-nova-violet/40 focus:ring-nova-violet/30 transition-colors";
const LITERAL_INPUT_CLS_INVALID =
	"w-full px-3 min-h-11 text-[13px] rounded-lg border border-nova-rose/40 bg-nova-deep/50 text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:ring-1 focus:border-nova-rose/60 focus:ring-nova-rose/30 transition-colors";

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

/** Text-typed literal input — commits on blur to avoid hammering
 *  the type checker on every keystroke. A `nonEmpty` slot (a `match`
 *  value, say) reverts an emptied draft to the prior value rather
 *  than committing `literal("")`. An empty match value is a
 *  COMPLETENESS state ("fill this in") — every match mode collapses an
 *  empty value to a non-match — so the editor only ever LEAVES it
 *  unfilled (the seed), never lets the input actively empty a value the
 *  author already filled. */
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
	const [draft, setDraft] = useState(initial);
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
		}
	}, [initial, draft]);
	// Commit gating + qualifier preservation:
	//   - The no-op `draft === initial` short-circuit keeps a focus
	//     pulse on an untouched input from re-emitting the AST. The
	//     parent receives nothing, so the source reference flows
	//     through untouched.
	//   - A `nonEmpty` slot reverts an emptied draft to `initial` rather
	//     than committing the empty literal.
	//   - On a real edit, `rebuildLiteralPreservingDataType` carries
	//     the source's `data_type` qualifier through. A literal
	//     declared `data_type: "single_select"` (or any non-temporal
	//     qualifier) stays declared after the edit; the bare
	//     `literal(draft)` rebuild would silently drop it.
	const commit = useCallback(() => {
		if (draft === initial) return;
		if (nonEmpty && draft === "") {
			setDraft(initial);
			return;
		}
		onChange(rebuildLiteralPreservingDataType(value, draft));
	}, [draft, initial, nonEmpty, onChange, value]);
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
			aria-label="Literal text value"
			aria-invalid={invalid || undefined}
			className={literalInputCls(invalid)}
		/>
	);
}

/** Numeric literal input — commits on blur, accepting integers and
 *  decimals. Empty input commits a `literal(null)` so the type
 *  checker treats the slot as the absent-or-null compatibility
 *  case. */
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
	const [draft, setDraft] = useState(initial);
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
		}
	}, [initial, draft]);
	// Commit gating + qualifier preservation: same shape as
	// `LiteralTextInput`. The numeric input's no-op gate compares
	// the draft against the source's serialized form so a focus
	// pulse on an untouched input doesn't fire. Empty input emits a
	// `literal(null)` carrying the source's qualifier — the type
	// checker treats null as universally compatible per
	// `typesCompatible`'s `_any` rule.
	const commit = useCallback(() => {
		if (draft === initial) return;
		const trimmed = draft.trim();
		if (trimmed === "") {
			onChange(rebuildLiteralPreservingDataType(value, null));
			return;
		}
		const parsed = Number.parseFloat(trimmed);
		if (Number.isNaN(parsed)) return;
		onChange(rebuildLiteralPreservingDataType(value, parsed));
	}, [draft, initial, onChange, value]);
	return (
		<input
			ref={inputRef}
			type="number"
			step="any"
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			autoComplete="off"
			data-1p-ignore
			placeholder="0"
			aria-label="Literal number value"
			aria-invalid={invalid || undefined}
			className={`${literalInputCls(invalid)} font-mono`}
		/>
	);
}

/** Boolean literal toggle — segmented control showing both states
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
	const baseCls =
		"flex-1 px-2 min-h-11 text-[11px] uppercase tracking-wider transition-colors cursor-pointer rounded-md";
	const activeCls = "text-nova-violet-bright bg-nova-violet/10";
	const idleCls =
		"text-nova-text-muted hover:text-nova-text hover:bg-white/[0.04]";
	const wrapCls = invalid
		? "flex gap-1 px-1 py-1 rounded-md border border-nova-rose/40 bg-nova-deep/50"
		: "flex gap-1 px-1 py-1 rounded-md border border-white/[0.06] bg-nova-deep/50";
	// `<fieldset>` carries the implicit "group of related controls" role
	// without a separate `role="group"` attribute — biome's
	// `useSemanticElements` rule prefers the semantic element. The
	// visible-label decoration uses `aria-label` rather than a
	// `<legend>` because the surrounding card already carries a
	// "Term source: Literal" label and a redundant legend would
	// add a structural heading the screen reader doesn't need.
	// Qualifier-preserving toggle: each button rebuilds via
	// `rebuildLiteralPreservingDataType` so a literal carrying a
	// `data_type` qualifier doesn't silently drop it on click. The
	// no-op gate (don't fire when the user clicks the already-active
	// state) matches the text / numeric inputs' commit-on-change
	// contract.
	return (
		<fieldset className={wrapCls} aria-label="Literal boolean value">
			<button
				type="button"
				onClick={() => {
					if (current) return;
					onChange(rebuildLiteralPreservingDataType(value, true));
				}}
				className={`${baseCls} ${current ? activeCls : idleCls}`}
				aria-pressed={current}
			>
				True
			</button>
			<button
				type="button"
				onClick={() => {
					if (!current) return;
					onChange(rebuildLiteralPreservingDataType(value, false));
				}}
				className={`${baseCls} ${!current ? activeCls : idleCls}`}
				aria-pressed={!current}
			>
				False
			</button>
		</fieldset>
	);
}

/** Null sentinel chip — non-editable, showing the literal resolves
 *  to null. The shape menu above flips back to a typed shape if the
 *  user wants a non-null value. */
function LiteralNullChip() {
	return (
		<div className="flex items-center gap-2 px-2 py-1.5 text-xs rounded-md border border-dashed border-white/[0.08] bg-nova-deep/30 text-nova-text-muted italic">
			<span className="font-mono">null</span>
		</div>
	);
}

/** Native typed-date / typed-time / typed-datetime input. Browsers
 *  drive the picker UX; the wire form is the platform's ISO-
 *  formatted output, which matches CommCare's date / datetime
 *  conventions when truncated to seconds. Commits on change rather
 *  than blur — picker commits are atomic events, not in-flight
 *  edits. Same shape `LiteralValueInput`'s `DateInput` uses.
 *
 *  A `nonEmpty` slot (a `fuzzy-date` match value) ignores a cleared
 *  value: the input is controlled by `value={initial}`, so dropping the
 *  commit snaps the native picker back to the prior value — the same
 *  revert the text widget does, so `dateLiteral("")` can't be authored
 *  where an empty value is a non-match. */
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
	return (
		<input
			type={inputType}
			value={initial}
			onChange={(e) => {
				if (nonEmpty && e.target.value === "") return;
				onChange(e.target.value);
			}}
			autoComplete="off"
			data-1p-ignore
			aria-label={`Literal ${inputType.replace("-local", "")} value`}
			aria-invalid={invalid || undefined}
			className={`${literalInputCls(invalid)} font-mono`}
		/>
	);
}

/** Open-namespace user-data field input. Free-text — the type
 *  checker can't validate the field name against any closed set
 *  (CCHQ user records carry arbitrary `additionalFields`), so the
 *  card defers to the user's explicit input. */
function UserFieldInput({
	value,
	onChange,
	invalid,
}: {
	readonly value: string;
	readonly onChange: (field: string) => void;
	readonly invalid: boolean;
}) {
	const inputCls = [
		"w-full px-3 min-h-11 text-[13px] rounded-lg border bg-nova-deep/50 text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:ring-1 transition-colors font-mono",
		invalid
			? "border-nova-rose/40 focus:border-nova-rose/60 focus:ring-nova-rose/30"
			: "border-white/[0.06] focus:border-nova-violet/40 focus:ring-nova-violet/30",
	].join(" ");
	return (
		<input
			type="text"
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder="user_field_name"
			autoComplete="off"
			data-1p-ignore
			aria-label="User-Data Field"
			aria-invalid={invalid || undefined}
			className={inputCls}
		/>
	);
}
