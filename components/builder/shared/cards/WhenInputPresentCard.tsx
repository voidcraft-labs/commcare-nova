// components/builder/shared/cards/WhenInputPresentCard.tsx
//
// Renders the `when-input-present` predicate — search-input
// dropdown plus a nested predicate editor for the inner clause.
// Authors compose conditional inclusion ("apply this filter only
// when the user typed in the input").

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerSwitch from "@iconify-icons/tabler/switch";
import { useRef } from "react";
import {
	input as buildInput,
	matchAll,
	type Predicate,
	whenInput,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { useEditorErrorsAt, usePredicateEditContext } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendKindSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { ChildPredicateEditor } from "./ChildPredicateEditor";

export function whenInputPresentDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "when-input-present" }> {
	const firstInput = ctx.knownInputs[0];
	return whenInput(buildInput(firstInput?.name ?? ""), matchAll());
}

interface WhenInputPresentCardProps {
	readonly value: Extract<Predicate, { kind: "when-input-present" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function WhenInputPresentCard({
	value,
	onChange,
	path,
}: WhenInputPresentCardProps) {
	const inputErrors = useEditorErrorsAt(
		appendKindSlot(path, "when-input-present", "input"),
	);
	const inputName = value.input.name || undefined;

	const setInput = (name: string) => {
		onChange(whenInput(buildInput(name), value.clause));
	};

	const setClause = (next: Predicate) => {
		onChange(whenInput(value.input, next));
	};

	return (
		<div className="space-y-2">
			<div>
				<div className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-1">
					When this input has a value
				</div>
				<InputMenu
					value={inputName}
					onChange={setInput}
					invalid={inputErrors.length > 0}
				/>
				<InlineError errors={inputErrors} />
			</div>
			<div>
				<div className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-1">
					Apply this clause
				</div>
				<ChildPredicateEditor
					value={value.clause}
					onChange={setClause}
					path={appendKindSlot(path, "when-input-present", "clause")}
					variant="nested"
				/>
			</div>
		</div>
	);
}

function InputMenu({
	value,
	onChange,
	invalid,
}: {
	readonly value: string | undefined;
	readonly onChange: (name: string) => void;
	readonly invalid: boolean;
}) {
	const ctx = usePredicateEditContext();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const items = ctx.knownInputs;
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
				No declared search inputs in scope
			</div>
		);
	}

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Search input: ${current?.name ?? "Pick an input"}`}
				className={triggerClass}
			>
				<span className="flex items-center gap-1.5">
					<Icon
						icon={tablerSwitch}
						width="14"
						height="14"
						className="text-nova-violet-bright"
					/>
					<span className="font-mono text-nova-violet-bright">
						{current?.name ?? "Pick an input"}
					</span>
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
