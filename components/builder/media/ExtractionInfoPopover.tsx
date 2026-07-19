// components/builder/media/ExtractionInfoPopover.tsx
//
// A small "info" affordance that explains feature extraction in plain language:
// Nova works from a structured extract of each document, not the raw file. Heads
// off the "the doc clearly says X, why didn't Nova see it?" confusion by pointing
// the user at the per-document "What Nova reads" preview.

"use client";

import { InfoPopover } from "@/components/builder/InfoPopover";

export function ExtractionInfoPopover() {
	return (
		<InfoPopover
			title="What Nova reads"
			ariaLabel="What does Nova read from a document?"
		>
			Nova creates a structured summary of each document and works from that
			summary, not the raw file. Open any document and switch to{" "}
			<span className="text-nova-text">What Nova reads</span> to see exactly
			what Nova found. If something's missing, tell Nova in chat.
		</InfoPopover>
	);
}
