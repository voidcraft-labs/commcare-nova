// components/builder/case-list-config/canvas/canvasChrome.tsx
//
// Shared chrome for the workspace canvases: contextual empty-state guidance
// and the dashed add affordance.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useId } from "react";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";

/**
 * Drag previews are compact, but authored labels are still content. Keep the
 * preview bounded while allowing long labels and imported values to wrap in
 * full instead of collapsing distinct choices into the same ellipsis.
 */
export function AuthoredDragPreviewLabel({
	children,
}: {
	readonly children: React.ReactNode;
}) {
	return (
		<span className="max-w-60 whitespace-normal break-words [overflow-wrap:anywhere]">
			{children}
		</span>
	);
}

// ── Inline notice ─────────────────────────────────────────────────

export type NoticeTone = "muted" | "warning" | "error";

const NOTICE_TONE_CLS: Record<NoticeTone, string> = {
	muted: "text-nova-text-secondary",
	warning: "text-nova-amber",
	error: "text-nova-rose",
};

/** Contextual guidance rendered only when a composition has no rows. */
export function CanvasNotice({
	tone,
	title,
	children,
}: {
	readonly tone: NoticeTone;
	readonly title?: string;
	readonly children: React.ReactNode;
}) {
	return (
		<div
			className={`px-5 py-8 text-center text-sm leading-relaxed ${NOTICE_TONE_CLS[tone]}`}
		>
			{title === undefined ? (
				children
			) : (
				<>
					<p className="font-display text-base font-semibold text-nova-text">
						{title}
					</p>
					<p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed">
						{children}
					</p>
				</>
			)}
		</div>
	);
}

// ── Add affordance ────────────────────────────────────────────────

/** Dashed add button — the canvases' uniform "add a thing" shape. */
export function AddGhostButton({
	label,
	onClick,
	disabledReason,
	icon = tablerPlus,
	className = "",
	dataCaseAdd,
	dataCaseAddSearchField = false,
}: {
	readonly label: string;
	/** Receives the click event so canvases hosting the button inside
	 *  a click-capture surface can stop propagation. */
	readonly onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
	/** `undefined` = enabled; a string disables the button and
	 *  surfaces as the hover explanation. */
	readonly disabledReason?: string;
	readonly icon?: IconifyIcon;
	readonly className?: string;
	/** Stable focus target used after hiding an item from a composition. */
	readonly dataCaseAdd?: "list" | "detail";
	/** Stable focus target used after the final Search field is removed. */
	readonly dataCaseAddSearchField?: boolean;
}) {
	const reasonId = useId();
	return (
		<div>
			<SimpleTooltip content={disabledReason}>
				<Button
					type="button"
					variant="ghost"
					onClick={onClick}
					disabled={disabledReason !== undefined}
					aria-describedby={disabledReason === undefined ? undefined : reasonId}
					data-case-add={dataCaseAdd}
					data-case-add-search-field={dataCaseAddSearchField ? "" : undefined}
					className={`min-h-11 gap-2 border border-dashed border-nova-border-bright px-4 text-[14px] text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.06] dark:not-disabled:hover:bg-nova-violet/[0.06] ${className}`}
				>
					<Icon icon={icon} width="14" height="14" />
					<span>{label}</span>
				</Button>
			</SimpleTooltip>
			{disabledReason !== undefined && (
				<p
					id={reasonId}
					className="mt-2 text-center text-[13px] leading-relaxed text-nova-text-muted"
				>
					{disabledReason}
				</p>
			)}
		</div>
	);
}
