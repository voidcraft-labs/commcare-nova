/**
 * Shared primitives used across the AppTree row components.
 *
 * Small stateless atoms (chevron button, tree-item wrapper,
 * highlighted-text renderer) live here so FieldRow / FormCard / ModuleCard
 * can import from a single module without pulling in the full tree.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { Button } from "@/components/shadcn/button";
import { highlightSegments, type MatchIndices } from "@/lib/filterTree";

/** Collapsible-section chevron button used by module / form / group rows. */
export function CollapseChevron({
	label,
	isCollapsed,
	onClick,
	hidden,
}: {
	label: string;
	isCollapsed: boolean;
	onClick: (e: React.MouseEvent) => void;
	hidden?: boolean;
}) {
	if (hidden) {
		return <span className="size-11 shrink-0" aria-hidden="true" />;
	}

	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${label}`}
			aria-expanded={!isCollapsed}
			className="shrink-0"
			onClick={onClick}
			onKeyDown={(event) => event.stopPropagation()}
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
		</Button>
	);
}

/**
 * Row chrome with one native selection button behind its visible content.
 * The chevron/delete controls remain independent buttons above that target,
 * avoiding both a malformed partial ARIA tree and nested interactive content.
 * Native button semantics provide Enter/Space activation and a real disabled
 * state while generation locks the structure.
 */
export function TreeItemRow({
	onClick,
	label,
	disabled = false,
	selected = false,
	className,
	style,
	children,
	...rest
}: {
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
	label: string;
	disabled?: boolean;
	selected?: boolean;
	className?: string;
	style?: React.CSSProperties;
	children: React.ReactNode;
	"data-tree-field"?: string;
}) {
	return (
		<div className={`relative ${className ?? ""}`} style={style} {...rest}>
			<button
				type="button"
				disabled={disabled}
				aria-label={label}
				aria-current={selected ? "page" : undefined}
				onClick={onClick}
				className="nova-focusable-inset absolute inset-0 z-0 size-full cursor-pointer rounded-none outline-none disabled:cursor-default"
			/>
			<div className="contents pointer-events-none [&_button]:relative [&_button]:z-10 [&_button]:pointer-events-auto">
				{children}
			</div>
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
					<mark
						key={key}
						className="bg-nova-violet/20 text-nova-text rounded-sm"
					>
						{seg.text}
					</mark>
				) : (
					<span key={key}>{seg.text}</span>
				);
			})}
		</>
	);
}
