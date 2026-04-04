/**
 * Floating autocomplete dropdown for hashtag reference suggestions.
 *
 * Used by the TipTap suggestion lifecycle to display reference search
 * results. Styled to match the CodeMirror autocomplete theme (dark bg,
 * violet selection highlight, type-colored icons per reference type).
 *
 * Supports two phases:
 *   1. Namespace picker — shows #form/, #case/, #user/ options
 *   2. Property picker — shows filtered references from ReferenceProvider
 */

"use client";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { REF_TYPE_CONFIG } from "@/lib/references/config";
import type { Reference, ReferenceType } from "@/lib/references/types";

/** Namespace options shown in Phase 1 (before "/" is typed). */
const NAMESPACE_OPTIONS: Array<{
	type: ReferenceType;
	label: string;
	description: string;
}> = [
	{ type: "form", label: "#form/", description: "Form question" },
	{ type: "case", label: "#case/", description: "Case property" },
	{ type: "user", label: "#user/", description: "User property" },
];

/** A namespace option for Phase 1 display. */
interface NamespaceItem {
	kind: "namespace";
	type: ReferenceType;
	label: string;
	description: string;
}

/** A reference option for Phase 2 display. */
interface ReferenceItem {
	kind: "reference";
	reference: Reference;
}

type AutocompleteItem = NamespaceItem | ReferenceItem;

export interface ReferenceAutocompleteProps {
	/** Phase 1: null shows namespace picker. Phase 2: items from provider.search(). */
	items: Reference[];
	/** Whether we're in namespace-picker phase (no "/" typed yet). */
	showNamespaces: boolean;
	/** Callback when user selects a namespace (Phase 1). */
	onSelectNamespace?: (type: ReferenceType) => void;
	/** Callback when user selects a reference (Phase 2). */
	onSelect?: (ref: Reference) => void;
}

export interface ReferenceAutocompleteHandle {
	onKeyDown: (event: KeyboardEvent) => boolean;
}

/**
 * Imperative autocomplete list. Exposes onKeyDown for the TipTap Suggestion
 * utility to delegate keyboard events (ArrowUp/Down/Enter/Escape).
 */
export const ReferenceAutocomplete = forwardRef<
	ReferenceAutocompleteHandle,
	ReferenceAutocompleteProps
>(function ReferenceAutocomplete(
	{ items, showNamespaces, onSelectNamespace, onSelect },
	ref,
) {
	const [selectedIndex, setSelectedIndex] = useState(0);

	const allItems: AutocompleteItem[] = showNamespaces
		? NAMESPACE_OPTIONS.map((ns) => ({ kind: "namespace", ...ns }))
		: items.map((r) => ({ kind: "reference", reference: r }));

	// Reset selection when the list contents change (typing narrows results,
	// namespace toggle swaps the entire list). Content key handles both cases.
	const listKey = allItems
		.map((item) => (item.kind === "namespace" ? item.type : item.reference.raw))
		.join("\0");
	const prevListKeyRef = useRef(listKey);
	if (prevListKeyRef.current !== listKey) {
		prevListKeyRef.current = listKey;
		setSelectedIndex(0);
	}

	useImperativeHandle(ref, () => ({
		onKeyDown: (event: KeyboardEvent) => {
			if (event.key === "ArrowUp") {
				setSelectedIndex((i) => (i + allItems.length - 1) % allItems.length);
				return true;
			}
			if (event.key === "ArrowDown") {
				setSelectedIndex((i) => (i + 1) % allItems.length);
				return true;
			}
			if (event.key === "Enter") {
				selectItem(selectedIndex);
				return true;
			}
			return false;
		},
	}));

	function selectItem(index: number) {
		const item = allItems[index];
		if (!item) return;
		if (item.kind === "namespace") {
			onSelectNamespace?.(item.type);
		} else {
			onSelect?.(item.reference);
		}
	}

	if (allItems.length === 0) return null;

	return (
		<div
			className="rounded-lg border border-nova-violet/20 bg-[#0d0d24] shadow-[0_4px_20px_rgba(0,0,0,0.5)] overflow-hidden font-mono text-xs"
			style={{ minWidth: 200, maxWidth: 320 }}
		>
			{/* ARIA listbox pattern: generic divs with roles, not ul/li which carry
             conflicting implicit roles. Keyboard nav is imperative (TipTap drives
             ArrowUp/Down/Enter through the useImperativeHandle ref), so per-item
             onKeyDown handles Enter/Space as a fallback for direct focus. */}
			<div className="max-h-[200px] overflow-y-auto py-1" role="listbox">
				{allItems.map((item, index) => {
					const isSelected = index === selectedIndex;
					if (item.kind === "namespace") {
						const config = REF_TYPE_CONFIG[item.type];
						return (
							<div
								key={item.type}
								role="option"
								tabIndex={-1}
								aria-selected={isSelected}
								className={`flex items-center gap-2 px-2 py-[3px] cursor-pointer ${isSelected ? "bg-nova-violet/15" : ""}`}
								onClick={() => selectItem(index)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										selectItem(index);
									}
								}}
								onMouseEnter={() => setSelectedIndex(index)}
							>
								<Icon
									icon={config.icon}
									width="14"
									height="14"
									className={config.textClass}
								/>
								<span className="text-nova-text">{item.label}</span>
								<span className="ml-auto text-nova-text-muted">
									{item.description}
								</span>
							</div>
						);
					}
					const r = item.reference;
					const config = REF_TYPE_CONFIG[r.type];
					return (
						<div
							key={r.raw}
							role="option"
							tabIndex={-1}
							aria-selected={isSelected}
							className={`flex items-center gap-2 px-2 py-[3px] cursor-pointer ${isSelected ? "bg-nova-violet/15" : ""}`}
							onClick={() => selectItem(index)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									selectItem(index);
								}
							}}
							onMouseEnter={() => setSelectedIndex(index)}
						>
							<Icon
								icon={r.icon ?? config.icon}
								width="14"
								height="14"
								className={`shrink-0 ${config.textClass}`}
							/>
							<span className="text-nova-text truncate">{r.label}</span>
							{r.label !== r.path && (
								<span className="ml-auto text-nova-text-muted truncate">
									{r.path}
								</span>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
});
