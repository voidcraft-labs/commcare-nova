// components/builder/shared/cards/WhenInputPresentCard.tsx
//
// Renders the `when-input-present` predicate — search-input
// dropdown plus a nested predicate editor for the inner clause.
// Authors compose conditional inclusion ("apply this filter only
// when the user typed in the input").

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerSwitch from "@iconify-icons/tabler/switch";
import { useRef } from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { humanizeId } from "@/lib/domain/idSlug";
import {
	input as buildInput,
	matchAll,
	type Predicate,
	whenInput,
} from "@/lib/domain/predicate";
import { firstConditionSeed } from "../conditionSeed";
import { useEditorErrorsAt, usePredicateEditContext } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendKindSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { searchInputDisplayLabel } from "../searchInputPresentation";
import { ChildPredicateEditor } from "./ChildPredicateEditor";

export function whenInputPresentDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "when-input-present" }> {
	const firstInput = ctx.knownInputs[0];
	return whenInput(
		buildInput(firstInput?.name ?? ""),
		firstConditionSeed(ctx) ?? matchAll(),
	);
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
				<div className="mb-1.5 text-[13px] font-medium text-nova-text-secondary">
					When this search field has a value
				</div>
				<SearchInputMenu
					value={inputName}
					onChange={setInput}
					invalid={inputErrors.length > 0}
				/>
				<InlineError errors={inputErrors} />
			</div>
			<div>
				<div className="mb-1.5 text-[13px] font-medium text-nova-text-secondary">
					Apply this condition
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

export function SearchInputMenu({
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
	const currentLabel =
		current === undefined
			? undefined
			: searchInputDisplayLabel(current.name, ctx.knownInputs);
	const triggerClass = [
		"group min-h-11 w-full justify-between rounded-lg border bg-nova-deep/50 px-3 text-sm text-nova-text transition-colors",
		invalid
			? "border-nova-rose/40"
			: "border-white/[0.06] hover:border-nova-violet/30",
	].join(" ");

	if (items.length === 0) {
		return (
			<div className="rounded-md border border-dashed border-white/[0.06] px-3 py-2 text-[13px] text-nova-text-muted">
				Add a search field before using this condition
			</div>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				aria-label={`Search field ${currentLabel ?? "Choose a search field"}`}
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className={triggerClass}
					/>
				}
			>
				<span className="flex items-center gap-1.5">
					<Icon
						icon={tablerSwitch}
						width="14"
						height="14"
						className="text-nova-violet-bright"
					/>
					<span className="text-nova-violet-bright">
						{currentLabel ?? "Choose a search field"}
					</span>
				</span>
				<Icon
					icon={tablerChevronDown}
					aria-hidden="true"
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
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<DropdownMenuPopup>
						{items.map((it) => {
							const isActive = it.name === value;
							return (
								<DropdownMenuItem
									key={it.name}
									onClick={() => onChange(it.name)}
									className={
										isActive
											? "bg-nova-violet/10 text-nova-violet-bright"
											: undefined
									}
								>
									<span>
										{searchInputDisplayLabel(it.name, ctx.knownInputs)}
									</span>
									{it.data_type && (
										<span className="text-xs text-nova-text-muted">
											{humanizeId(it.data_type)}
										</span>
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
