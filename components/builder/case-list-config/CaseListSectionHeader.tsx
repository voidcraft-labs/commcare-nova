// components/builder/case-list-config/CaseListSectionHeader.tsx
//
// Sticky violet-railed section header for the CaseListWorkspace
// shell. Each header acts as an in-flow ORIENTATION MARKER (not a
// wrapping box) — the rail beneath the title is the only visual
// border, and the wrapper pins to the top of the scroll container
// so the header doubles as a scroll anchor when the user is deep
// inside a section's body.
//
// The header carries three layers, top-to-bottom:
//
//   1. Display title — the section's name in the project's display
//      typography (Outfit). Sized so it sits ABOVE body text in the
//      visual hierarchy without competing with field-row chrome.
//   2. Status-density line — a small live-bound copy line that
//      summarizes the section's current state. The CaseListWorkspace
//      composes the line from doc-store-shallow selectors and passes
//      it as a node so each section can render its own count
//      shape (column count, filter presence, input count) without
//      this header carrying section-specific knowledge.
//   3. Violet rail — a 3px-tall full-width bar with a soft glow.
//      The rail reads as the section's bottom edge while in flow,
//      and the only visible border once the header is pinned.
//
// Sticky implementation: `position: sticky; top: 0` against the
// shared preview scroll container. The wrapper is glassmorphic
// (`backdrop-blur-md` + tinted background) so when pinned it
// samples the scrolling body content underneath, creating
// depth between the chrome and the rolling content.

"use client";

import type { ReactNode } from "react";

export interface CaseListSectionHeaderProps {
	/** Section title — rendered as an h2 in the project's display
	 *  typography. */
	readonly title: string;
	/** Live-bound status-density text. The workspace composes this
	 *  from doc-store-shallow selectors so the line updates the
	 *  same render pass as any blueprint mutation. */
	readonly status: ReactNode;
}

/**
 * Sticky section header. Wraps the title + status line with the
 * 3px violet rail beneath. The shared scroll container is the
 * `data-preview-scroll-container` ancestor mounted by PreviewShell;
 * `position: sticky; top: 0` pins to the top of that container.
 *
 * The header is the only visible boundary for its section — the
 * section body has no outer chrome — so the rail's glow is tuned
 * sharp enough to read as a divider while soft enough that three
 * stacked rails (long-scroll edge case where every section header
 * is in the sticky zone simultaneously) compose without competing.
 */
export function CaseListSectionHeader({
	title,
	status,
}: CaseListSectionHeaderProps) {
	return (
		<div
			data-section-header
			// `sticky top-0` pins the wrapper to the preview scroll
			// container's top once the user scrolls past it. The
			// `z-raised` token (the project's in-flow elevation tier)
			// keeps the pinned chrome above body content while staying
			// well below floating popovers, which use `z-popover`.
			//
			// The translucent background + `backdrop-blur-md` samples
			// the scrolling body content beneath the pinned header,
			// creating depth between the chrome and the rolling content.
			className="sticky top-0 z-raised bg-[rgba(12,12,32,0.7)] backdrop-blur-md px-8 pt-6 pb-3"
		>
			<h2 className="text-3xl font-display font-light tracking-tight text-nova-text">
				{title}
			</h2>
			<p className="mt-1 text-[13px] text-nova-text-muted leading-snug">
				{status}
			</p>
			{/*
			 * Violet rail. The 3px height + soft glow is a refined
			 * marker, not decorative; per the workspace's spatial
			 * composition the rail is the section's only visual edge.
			 * Glow opacity tuned so three stacked rails (long-scroll
			 * edge case where every section header is in the sticky
			 * zone simultaneously) compose without competing.
			 */}
			<div
				data-section-rail
				aria-hidden="true"
				className="mt-3 h-[3px] w-full rounded-full bg-nova-violet shadow-[0_0_8px_rgba(139,92,246,0.4)]"
			/>
		</div>
	);
}
