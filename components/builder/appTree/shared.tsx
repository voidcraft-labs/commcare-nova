/**
 * Shared primitives used across the AppTree row components.
 *
 * Small stateless atoms (chevron button, tree-item wrapper,
 * highlighted-text renderer) and the per-form icon context live here so
 * FieldRow / FormCard / ModuleCard can import from a single module
 * without pulling in the full tree.
 */
"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { createContext } from "react";
import { highlightSegments, type MatchIndices } from "@/lib/filterTree";

/**
 * Per-form context carrying a field path → kind icon map. Lets FieldRow
 * render reference chips with correct field-kind icons without prop
 * drilling through the recursive tree or depending on ReferenceProvider.
 */
export const FormIconContext = createContext<Map<string, IconifyIcon>>(
	new Map(),
);

/** Collapsible-section chevron button used by module / form / group rows. */
export function CollapseChevron({
	isCollapsed,
	onClick,
	hidden,
}: {
	isCollapsed: boolean;
	onClick: (e: React.MouseEvent) => void;
	hidden?: boolean;
}) {
	return (
		<button
			type="button"
			className={`w-4 h-4 flex items-center justify-center shrink-0 cursor-pointer rounded text-nova-text-muted hover:text-nova-text transition-colors ${hidden ? "invisible" : ""}`}
			onClick={onClick}
		>
			<Icon
				icon={tablerChevronRight}
				width="10"
				height="10"
				className="transition-transform duration-150"
				style={{
					transform: isCollapsed ? "rotate(0deg)" : "rotate(90deg)",
				}}
			/>
		</button>
	);
}

/**
 * ARIA `role="treeitem"` row wrapper. Handles Enter / Space activation so
 * keyboard users can select rows just like mouse users. Extra data
 * attributes (e.g. `data-tree-field`) forward through to the element.
 */
export function TreeItemRow({
	onClick,
	className,
	style,
	children,
	...rest
}: {
	onClick: (e: React.MouseEvent | React.KeyboardEvent) => void;
	className?: string;
	style?: React.CSSProperties;
	children: React.ReactNode;
	"data-tree-field"?: string;
}) {
	return (
		<div
			role="treeitem"
			tabIndex={0}
			className={className}
			style={style}
			onClick={onClick}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onClick(e);
				}
			}}
			{...rest}
		>
			{children}
		</div>
	);
}

/** Render text with substring matches wrapped in `<mark>` highlight tags. */
export function HighlightedText({
	text,
	indices,
}: {
	text: string;
	indices: MatchIndices;
}) {
	const segments = highlightSegments(text, indices);
	let offset = 0;
	return (
		<>
			{segments.map((seg) => {
				const key = offset;
				offset += seg.text.length;
				return seg.highlight ? (
					<mark key={key} className="bg-nova-violet/20 text-inherit rounded-sm">
						{seg.text}
					</mark>
				) : (
					<span key={key}>{seg.text}</span>
				);
			})}
		</>
	);
}
