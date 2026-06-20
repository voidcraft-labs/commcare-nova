// components/builder/media/ExtractionInfoPopover.tsx
//
// A small "info" affordance that explains feature extraction in plain language:
// Nova works from a structured extract of each document, not the raw file. Heads
// off the "the doc clearly says X, why didn't Nova see it?" confusion by pointing
// the user at the per-document "What Nova reads" preview.

"use client";

import { InfoPopover } from "@/components/builder/InfoPopover";

/**
 * `className` sizes the trigger (forwarded to the shared `InfoPopover`), so
 * callers can shrink it to fit a tight host — e.g. `size-3` to sit inside a
 * Badge without widening it. Defaults to `size-4`.
 */
export function ExtractionInfoPopover({ className }: { className?: string }) {
	return (
		<InfoPopover
			title="What Nova reads"
			ariaLabel="What does Nova read from a document?"
			className={className}
		>
			Nova reads a structured <span className="text-nova-text">extract</span> of
			each document — the requirements it can pull out — and works from that,
			not the raw file. Open any document and switch to{" "}
			<span className="text-nova-text">What Nova reads</span> to see exactly
			what it got. If something's missing there, add it in the chat.
		</InfoPopover>
	);
}
