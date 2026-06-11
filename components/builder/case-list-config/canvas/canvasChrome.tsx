// components/builder/case-list-config/canvas/canvasChrome.tsx
//
// Shared chrome for the workspace canvases: the inline notice card
// (state arms rendered inside an artifact card), the preview-state →
// notice mapping, the dashed add affordance, and the column drag
// preview.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerColumns from "@iconify-icons/tabler/columns";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerPlus from "@iconify-icons/tabler/plus";
import { Tooltip } from "@/components/ui/Tooltip";
import type { Column } from "@/lib/domain";
import type { CaseListPreviewState } from "../useCaseListPreview";

// ── Inline notice ─────────────────────────────────────────────────

export type NoticeTone = "muted" | "warning" | "error";

const NOTICE_TONE_CLS: Record<NoticeTone, string> = {
	muted: "text-nova-text-muted",
	warning: "text-nova-amber/90",
	error: "text-nova-rose/90",
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
			return {
				tone: "warning",
				text: "Preview paused — fix the errors marked on the tabs to see live rows.",
			};
		case "empty":
			return {
				tone: "muted",
				text: "No cases yet — generate sample data from the Case list tab.",
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

// ── Keyboard activation ───────────────────────────────────────────

/**
 * Enter/Space activation for `div[role="button"]` canvas surfaces —
 * the same contract `EditableFieldWrapper` applies in the form
 * editor. Canvas click-capture wrappers can't be `<button>`s because
 * their children contain nested interactive elements (grips, add
 * buttons, inputs), which HTML forbids inside a button.
 */
export function activateOnKeyDown(
	activate: () => void,
): (e: React.KeyboardEvent) => void {
	return (e) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		if (e.target !== e.currentTarget) return;
		e.preventDefault();
		activate();
	};
}

// ── Add affordance ────────────────────────────────────────────────

/** Dashed add button — the canvases' uniform "add a thing" shape. */
export function AddGhostButton({
	label,
	onClick,
	disabledReason,
	icon = tablerPlus,
	className = "",
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
}) {
	return (
		<Tooltip content={disabledReason}>
			<button
				type="button"
				onClick={onClick}
				disabled={disabledReason !== undefined}
				className={`inline-flex items-center justify-center gap-2 px-4 min-h-11 text-[13px] rounded-lg border border-dashed border-nova-border-bright text-nova-violet-bright hover:bg-nova-violet/[0.06] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
			>
				<Icon icon={icon} width="14" height="14" />
				<span>{label}</span>
			</button>
		</Tooltip>
	);
}

// ── Column drag preview ───────────────────────────────────────────

export function ColumnDragPreview({
	column,
	index,
}: {
	readonly column: Column;
	readonly index: number;
}) {
	const labelSource =
		column.kind === "calculated"
			? column.header
			: column.header || column.field;
	const label = labelSource || `Column ${index + 1}`;
	return (
		<div className="inline-flex items-center gap-1.5 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-1.5 text-sm text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerGripVertical}
				width="14"
				height="14"
				className="text-nova-text-muted"
			/>
			<Icon
				icon={tablerColumns}
				width="14"
				height="14"
				className="text-nova-violet-bright/80"
			/>
			<span className="max-w-[240px] truncate">{label}</span>
		</div>
	);
}
