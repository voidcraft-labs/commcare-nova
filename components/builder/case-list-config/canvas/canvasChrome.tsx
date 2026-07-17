// components/builder/case-list-config/canvas/canvasChrome.tsx
//
// Shared chrome for the workspace canvases: the inline notice card
// (state arms rendered inside an artifact card), the preview-state →
// notice mapping, and the dashed add affordance.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useId } from "react";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type { CaseListPreviewState } from "../useCaseListPreview";

// ── Inline notice ─────────────────────────────────────────────────

export type NoticeTone = "muted" | "warning" | "error";

const NOTICE_TONE_CLS: Record<NoticeTone, string> = {
	muted: "text-nova-text-muted",
	warning: "text-nova-amber",
	error: "text-nova-rose",
};

/** Explanatory line rendered inside an artifact card (e.g. the table
 *  body when there are no rows to show). */
export function CanvasNotice({
	tone,
	children,
}: {
	readonly tone: NoticeTone;
	readonly children: React.ReactNode;
}) {
	return (
		<div
			className={`px-5 py-8 text-center text-xs leading-relaxed ${NOTICE_TONE_CLS[tone]}`}
		>
			{children}
		</div>
	);
}

/**
 * Map a non-rows preview state to its user-facing explanation. The
 * canvases stay artifact-shaped in every state — only the data area
 * swaps to the notice.
 */
export function previewNotice(
	preview: Exclude<CaseListPreviewState, { kind: "rows" }>,
): { tone: NoticeTone; text: string } {
	switch (preview.kind) {
		case "idle":
		case "loading":
			return { tone: "muted", text: "Loading cases…" };
		case "paused":
			// The message names the offending thing (filter / calculated
			// column) — composed by `configValidity.ts::
			// caseListConfigVerdicts`, the same walk that marks it.
			return { tone: "warning", text: preview.message };
		case "empty":
			return {
				tone: "muted",
				text: "No cases yet — the canvas is using placeholder values.",
			};
		case "unauthenticated":
			return { tone: "warning", text: "Sign in to view case data." };
		case "missing-case-type":
			return {
				tone: "warning",
				text: `Case type "${preview.caseType}" is no longer in this app — refresh the page.`,
			};
		case "schema-not-synced":
			return {
				tone: "warning",
				text: `Case type "${preview.caseType}" isn't ready yet — try again in a moment.`,
			};
		case "invalid-config":
		case "invalid-blueprint":
		case "error":
			return { tone: "error", text: preview.message };
	}
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
}) {
	const reasonId = useId();
	return (
		<div>
			<SimpleTooltip content={disabledReason}>
				<button
					type="button"
					onClick={onClick}
					disabled={disabledReason !== undefined}
					aria-describedby={disabledReason === undefined ? undefined : reasonId}
					data-case-add={dataCaseAdd}
					className={`inline-flex items-center justify-center gap-2 px-4 min-h-11 text-[13px] rounded-lg border border-dashed border-nova-border-bright text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.06] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
				>
					<Icon icon={icon} width="14" height="14" />
					<span>{label}</span>
				</button>
			</SimpleTooltip>
			{disabledReason !== undefined && (
				<p
					id={reasonId}
					className="mt-2 text-center text-[11px] leading-relaxed text-nova-text-muted"
				>
					{disabledReason}
				</p>
			)}
		</div>
	);
}
