// components/builder/case-list-config/primitives/ValueExpressionPicker.tsx
//
// Term-only picker for a `ValueExpression` slot. Drives the
// "value" half of every comparison / membership / range operator,
// plus the `match` value slot and the `within-distance` center
// slot. Accepts only Term-shaped operands (literal, property ref,
// search-input ref, session-context ref, session-user ref);
// higher-order ValueExpression arms (arith / if / count / etc.)
// are not exposed at this surface.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import tablerSwitch from "@iconify-icons/tabler/switch";
import tablerUser from "@iconify-icons/tabler/user";
import tablerVariable from "@iconify-icons/tabler/variable";
import { useId, useMemo, useRef } from "react";
import {
	input,
	literal,
	prop,
	sessionContext,
	type Term,
	type ValueExpression,
	term as wrapTerm,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { usePredicateEditContext } from "../editorContext";
import { LiteralValueInput } from "./LiteralValueInput";
import { PropertyPicker } from "./PropertyPicker";

/** Term-mode discriminator for the picker's mode toggle. */
type TermMode =
	| "literal"
	| "property"
	| "input"
	| "session-context"
	| "session-user";

interface ValueExpressionPickerProps {
	readonly value: ValueExpression;
	readonly onChange: (next: ValueExpression) => void;
	readonly caseTypeName: string;
	/**
	 * Property name driving the LiteralValueInput's typed variant
	 * — when the comparison is against a property reference (e.g.
	 * the comparison's left side), the right side's literal input
	 * matches the left's data type. Pass undefined when no anchor
	 * property exists (the input renders a generic text input).
	 */
	readonly anchorPropertyName: string | undefined;
	readonly invalid?: boolean;
	readonly ariaLabel?: string;
}

/**
 * Pick a Term-arm `ValueExpression`. Mode toggle in the trigger;
 * mode-specific input below. Higher-order arms (arith / if /
 * count / format-date) are not exposed here — this picker is
 * scoped to Term-shaped operands.
 */
export function ValueExpressionPicker({
	value,
	onChange,
	caseTypeName,
	anchorPropertyName,
	invalid = false,
	ariaLabel = "Value",
}: ValueExpressionPickerProps) {
	const ctx = usePredicateEditContext();
	const term = unwrapTerm(value);
	const mode = termMode(term);

	const setMode = (next: TermMode) => {
		onChange(wrapTerm(buildTermDefault(next, caseTypeName, ctx.knownInputs)));
	};

	return (
		<div className="grid grid-cols-[auto_1fr] gap-2 items-start">
			<ModeMenu mode={mode} setMode={setMode} ariaLabel={ariaLabel} />
			<TermBodyInput
				term={term}
				onChange={(t) => onChange(wrapTerm(t))}
				caseTypeName={caseTypeName}
				anchorPropertyName={anchorPropertyName}
				invalid={invalid}
				ariaLabel={ariaLabel}
			/>
		</div>
	);
}

function termMode(term: Term | undefined): TermMode {
	if (term === undefined) return "literal";
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

function unwrapTerm(value: ValueExpression): Term | undefined {
	return value.kind === "term" ? value.term : undefined;
}

function buildTermDefault(
	mode: TermMode,
	caseTypeName: string,
	knownInputs: readonly { name: string }[],
): Term {
	switch (mode) {
		case "literal":
			return literal("");
		case "property":
			// Default to a placeholder property name — the surrounding
			// card surfaces a "Pick a property" affordance when the
			// name doesn't resolve, and the type checker emits a
			// per-slot error so the author sees the unresolved
			// reference inline.
			return prop(caseTypeName, "");
		case "input": {
			const firstInput = knownInputs[0];
			return input(firstInput?.name ?? "");
		}
		case "session-context":
			// `userid` is the most authored choice in this set
			// (case-list "owned by me" filters); other fields require
			// an explicit pick.
			return sessionContext("userid");
		case "session-user":
			// Open-namespace user-data field — defaults to a
			// placeholder; the editor card surfaces a per-slot error
			// until the author fills in a real field name.
			return { kind: "session-user", field: "" };
	}
}

interface ModeMenuProps {
	readonly mode: TermMode;
	readonly setMode: (mode: TermMode) => void;
	readonly ariaLabel: string;
}

function ModeMenu({ mode, setMode, ariaLabel }: ModeMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const triggerId = useId();
	const ctx = usePredicateEditContext();

	const items = useMemo<
		readonly { mode: TermMode; label: string; icon: IconifyIcon }[]
	>(() => {
		const base: { mode: TermMode; label: string; icon: IconifyIcon }[] = [
			{ mode: "literal", label: "Literal", icon: tablerVariable },
			{ mode: "property", label: "Case property", icon: tablerDatabase },
		];
		if (ctx.knownInputs.length > 0) {
			base.push({
				mode: "input",
				label: "Search input",
				icon: tablerSwitch,
			});
		}
		base.push({
			mode: "session-context",
			label: "Session field",
			icon: tablerUser,
		});
		base.push({
			mode: "session-user",
			label: "User-data field",
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
				aria-label={`${ariaLabel} source: ${activeItem.label}`}
				className="group flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-text-muted hover:border-nova-violet/30 hover:text-nova-text transition-colors cursor-pointer"
			>
				<Icon
					icon={activeItem.icon}
					width="14"
					height="14"
					className="text-nova-violet-bright/70"
				/>
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
									onClick={() => setMode(item.mode)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									}`}
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
									<span>{item.label}</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

interface TermBodyInputProps {
	readonly term: Term | undefined;
	readonly onChange: (next: Term) => void;
	readonly caseTypeName: string;
	readonly anchorPropertyName: string | undefined;
	readonly invalid: boolean;
	readonly ariaLabel: string;
}

function TermBodyInput({
	term,
	onChange,
	caseTypeName,
	anchorPropertyName,
	invalid,
	ariaLabel,
}: TermBodyInputProps) {
	const ctx = usePredicateEditContext();
	const mode = termMode(term);

	switch (mode) {
		case "literal":
			return (
				<LiteralValueInput
					value={term?.kind === "literal" ? term : undefined}
					onChange={(lit) => onChange(lit)}
					caseTypeName={caseTypeName}
					propertyName={anchorPropertyName}
					invalid={invalid}
					ariaLabel={ariaLabel}
				/>
			);
		case "property":
			return (
				<PropertyPicker
					value={term?.kind === "prop" ? term.property : undefined}
					onChange={(name) => {
						onChange(prop(caseTypeName, name));
					}}
					caseType={caseTypeName}
					invalid={invalid}
					ariaLabel={ariaLabel}
				/>
			);
		case "input":
			return (
				<InputRefMenu
					value={term?.kind === "input" ? term.name : undefined}
					onChange={(name) => onChange(input(name))}
					invalid={invalid}
					ariaLabel={ariaLabel}
				/>
			);
		case "session-context":
			return (
				<SessionContextMenu
					value={term?.kind === "session-context" ? term.field : "userid"}
					onChange={(field) => onChange(sessionContext(field))}
					invalid={invalid}
					ariaLabel={ariaLabel}
				/>
			);
		case "session-user":
			return (
				<UserFieldInput
					value={term?.kind === "session-user" ? term.field : ""}
					onChange={(field) => onChange({ kind: "session-user", field })}
					invalid={invalid}
					ariaLabel={ariaLabel}
				/>
			);
	}
	// Exhaustive guard — silenced by the switch above. The unused
	// `ctx` reference defeats unused-import lint; ctx is consumed
	// indirectly through the underlying primitives.
	void ctx;
	return null;
}

function InputRefMenu({
	value,
	onChange,
	invalid,
	ariaLabel,
}: {
	readonly value: string | undefined;
	readonly onChange: (name: string) => void;
	readonly invalid: boolean;
	readonly ariaLabel: string;
}) {
	const ctx = usePredicateEditContext();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const items = ctx.knownInputs;
	const current = items.find((i) => i.name === value);
	const triggerClass = [
		"group w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50",
		invalid
			? "border-nova-error/40"
			: "border-white/[0.06] hover:border-nova-violet/30",
	].join(" ");

	if (items.length === 0) {
		return (
			<div className="text-xs text-nova-text-muted/60 italic px-2 py-1.5 rounded-md border border-dashed border-white/[0.06]">
				No declared search inputs
			</div>
		);
	}

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				className={triggerClass}
				aria-label={`${ariaLabel}: ${current?.name ?? "Pick an input"}`}
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

function SessionContextMenu({
	value,
	onChange,
	invalid,
	ariaLabel,
}: {
	readonly value: "userid" | "username" | "deviceid" | "appversion";
	readonly onChange: (
		field: "userid" | "username" | "deviceid" | "appversion",
	) => void;
	readonly invalid: boolean;
	readonly ariaLabel: string;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const items: readonly {
		field: "userid" | "username" | "deviceid" | "appversion";
		label: string;
	}[] = [
		{ field: "userid", label: "User ID" },
		{ field: "username", label: "Username" },
		{ field: "deviceid", label: "Device ID" },
		{ field: "appversion", label: "App version" },
	];
	const current = items.find((i) => i.field === value) ?? items[0];
	const triggerClass = [
		"group w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50",
		invalid
			? "border-nova-error/40"
			: "border-white/[0.06] hover:border-nova-violet/30",
	].join(" ");

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				className={triggerClass}
				aria-label={`${ariaLabel}: ${current.label}`}
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

function UserFieldInput({
	value,
	onChange,
	invalid,
	ariaLabel,
}: {
	readonly value: string;
	readonly onChange: (field: string) => void;
	readonly invalid: boolean;
	readonly ariaLabel: string;
}) {
	const inputCls = [
		"w-full px-2 py-1.5 text-xs rounded-md border bg-nova-deep/50 text-nova-text placeholder:text-nova-text-muted/60 focus:outline-none focus:ring-1 transition-colors font-mono",
		invalid
			? "border-nova-error/40 focus:border-nova-error/60 focus:ring-nova-error/30"
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
			aria-label={ariaLabel}
			aria-invalid={invalid || undefined}
			className={inputCls}
		/>
	);
}
