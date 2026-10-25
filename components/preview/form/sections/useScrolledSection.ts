/**
 * useScrolledSection: on Web Apps' one screen, the section in view is the
 * page the session remembers (`activeSectionByForm`).
 *
 * Web Apps draws a sectioned form on one screen, each section a titled
 * group, so no pager writes the slot. The edit canvas still opens on the
 * slot's page (`virtual/sectionScroll.ts::initialEditOffset`), so as the
 * author scrolls the running form this hook writes the section whose
 * heading is at or above the scroller's top edge, the same page the edit
 * canvas records for its own first visible row (`sectionShownAtRow`). A
 * flip to edit mode then opens on the section that was in view, and a later
 * switch to Android pages from it.
 *
 * Only a scroll writes the slot: the flipbook's own scroll restore fires
 * one, while mounting at the top writes nothing over the page edit mode
 * left there.
 */
"use client";
import { type RefObject, useEffect } from "react";
import type { Uuid } from "@/lib/domain";
import { useSetActiveSection } from "@/lib/session/hooks";

/** The attribute each section's heading block carries on the one screen. */
export const SECTION_HEADING_ATTRIBUTE = "data-section-uuid";

/** The section a viewer whose scroller's top edge is at `viewportTop` is
 *  looking at: the last heading at or above that edge, else the first
 *  (the space above page one shows page one). `tops` are in document
 *  order and in the same coordinates as `viewportTop`. */
export function sectionInView(
	headings: ReadonlyArray<{ readonly uuid: string; readonly top: number }>,
	viewportTop: number,
): string | undefined {
	let shown = headings[0]?.uuid;
	for (const heading of headings) {
		/* Half a pixel of slack: a heading scrolled exactly to the edge sits
		 * at a fractional offset after zoom or subpixel layout. */
		if (heading.top <= viewportTop + 0.5) shown = heading.uuid;
		else break;
	}
	return shown;
}

export function useScrolledSection({
	formUuid,
	enabled,
	bodyRef,
}: {
	readonly formUuid: Uuid | undefined;
	/** Running on one screen, in a form with sections. */
	readonly enabled: boolean;
	readonly bodyRef: RefObject<HTMLElement | null>;
}): void {
	const setActiveSection = useSetActiveSection();
	useEffect(() => {
		if (!enabled || formUuid === undefined) return;
		const body = bodyRef.current;
		const scroller = body?.closest<HTMLElement>(
			"[data-preview-scroll-container]",
		);
		if (!scroller) return;
		let frame: number | undefined;
		const record = () => {
			frame = undefined;
			const headings = Array.from(
				scroller.querySelectorAll<HTMLElement>(
					`[${SECTION_HEADING_ATTRIBUTE}]`,
				),
				(element) => ({
					uuid: element.getAttribute(SECTION_HEADING_ATTRIBUTE) ?? "",
					top: element.getBoundingClientRect().top,
				}),
			);
			const shown = sectionInView(
				headings,
				scroller.getBoundingClientRect().top,
			);
			if (shown) setActiveSection(formUuid, shown);
		};
		const onScroll = () => {
			if (frame === undefined) frame = requestAnimationFrame(record);
		};
		scroller.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			scroller.removeEventListener("scroll", onScroll);
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
	}, [enabled, formUuid, bodyRef, setActiveSection]);
}
