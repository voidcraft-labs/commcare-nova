/**
 * SectionHeading: the one page heading both modes render.
 *
 * The edit canvas's `SectionHeaderRow` and the preview pager's page render
 * this same box, kicker "Section k of n" over the title, at the fixed
 * `SECTION_HEADER_HEIGHT_PX`, so a flip between edit and preview lands the
 * heading and every row below it at the same Y. The fixed height is the
 * flipbook invariant; the kicker and title are centred inside it so a one-
 * line title and the untitled placeholder sit at the same place.
 *
 * Presentational only: the edit row wraps it in the selection/drag chrome
 * and hands it an inline-editable title, the preview page hands it static
 * text and takes `as="h2"` + `tabIndex={-1}` so the pager can move focus to
 * the page it just opened.
 */

"use client";
import type { ReactNode } from "react";
import { SECTION_HEADER_HEIGHT_PX } from "../virtual/rowStyles";

export interface SectionHeadingProps {
	/** 0-based page number. */
	readonly index: number;
	/** Number of pages in the form. */
	readonly count: number;
	/** The title, or the untitled placeholder the caller chose. */
	readonly title: ReactNode;
	/** `h2` in the running form (a real heading for the page), `div` in the
	 *  edit canvas (where the title is an inline editor, not a heading). */
	readonly as?: "div" | "h2";
	readonly id?: string;
	readonly tabIndex?: number;
	/** Draw the thin page-break rule above the heading. The first page has
	 *  nothing above it to break from. */
	readonly pageBreak?: boolean;
	/** Pad the title the way the edit canvas's inline editor pads it at
	 *  rest (`TextEditable`'s idle wrapper), so a static title in the running
	 *  form sits at the same x/y as the editable one. */
	readonly titleInset?: boolean;
	/** The title element, for a caller that moves focus to it. */
	readonly titleRef?: (element: HTMLElement | null) => void;
	readonly className?: string;
}

/** "Section k of n" for the kicker and the pager's announcement. */
export function sectionKicker(index: number, count: number): string {
	return `Section ${index + 1} of ${count}`;
}

export function SectionHeading({
	index,
	count,
	title,
	as = "div",
	id,
	tabIndex,
	pageBreak = false,
	titleInset = false,
	titleRef,
	className,
}: SectionHeadingProps) {
	const Title = as;
	return (
		<div
			className={`relative flex flex-col justify-center ${className ?? ""}`}
			style={{ height: SECTION_HEADER_HEIGHT_PX }}
		>
			{pageBreak && (
				<div
					aria-hidden="true"
					className="absolute inset-x-0 top-0 border-t border-dashed border-pv-input-border"
				/>
			)}
			<p className="text-xs leading-4 text-nova-text-muted">
				{sectionKicker(index, count)}
			</p>
			<Title
				id={id}
				ref={titleRef}
				tabIndex={tabIndex}
				className={`nova-focusable mt-1 min-w-0 text-lg font-semibold leading-7 text-nova-text outline-none${
					titleInset ? " px-[5px] py-[5px]" : ""
				}`}
			>
				{title}
			</Title>
		</div>
	);
}
