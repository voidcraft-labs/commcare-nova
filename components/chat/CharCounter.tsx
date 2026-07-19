"use client";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/shadcn/tooltip";
import { CHAR_COUNTER_VISIBLE_AT } from "@/lib/chat/limits";

/**
 * The composer's character counter. Hidden until the text reaches
 * `CHAR_COUNTER_VISIBLE_AT` of the limit (so normal short messages carry no
 * chrome), then escalates by color: nova-amber as a warning while at or below
 * the limit, nova-rose at or over it. It never blocks typing — the composer
 * lets the text go over and gates SENDING instead, so a paste you need to trim
 * stays editable.
 */
export function CharCounter({ length, max }: { length: number; max: number }) {
	const ratio = max > 0 ? length / max : 0;
	if (ratio < CHAR_COUNTER_VISIBLE_AT) return null;

	// OVER the limit reads as an error (rose); at-or-below is a warning (amber).
	// Strictly `> max` to match the send gate (ChatInput's `overLimit` + the server
	// both reject only PAST the limit) — so a message exactly at the limit, which
	// IS sendable, never shows the rose "trim to send" state.
	// The counter renders at full opacity once visible: its appearance at
	// CHAR_COUNTER_VISIBLE_AT already signals the approaching limit, and a
	// fade-in from near-zero opacity would render the amber warning text below
	// WCAG AA for most of the warning band.
	const over = length > max;

	const counter = (
		<span
			className="select-none text-xs tabular-nums tracking-tight"
			style={{
				color: over ? "var(--nova-rose)" : "var(--nova-amber)",
			}}
		>
			{length.toLocaleString()}/{max.toLocaleString()}
		</span>
	);

	// Over the limit, a tooltip spells out why send is blocked; below it there's
	// nothing to add, so the bare counter renders without one.
	if (!over) return counter;
	return (
		<Tooltip>
			<TooltipTrigger render={counter} />
			<TooltipContent>
				Trim your message to {max.toLocaleString()} characters to send
			</TooltipContent>
		</Tooltip>
	);
}
