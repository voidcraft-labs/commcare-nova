"use client";
import {
	CHAR_COUNTER_DANGER_AT,
	CHAR_COUNTER_VISIBLE_AT,
} from "@/lib/chat/limits";

/**
 * The composer's character counter. Hidden until the text reaches
 * `CHAR_COUNTER_VISIBLE_AT` of the limit (so normal short messages carry no
 * chrome), then escalates: nova-amber fading in across the warning band, full-
 * opacity amber through the danger band, and nova-rose at or over the limit.
 * It never blocks typing — the composer lets the text go over and gates SENDING
 * instead, so a paste you need to trim stays editable.
 */
export function CharCounter({ length, max }: { length: number; max: number }) {
	const ratio = max > 0 ? length / max : 0;
	if (ratio < CHAR_COUNTER_VISIBLE_AT) return null;

	// OVER the limit reads as an error (rose); at-or-below is a warning (amber)
	// that's fully opaque once past the danger threshold and fades in before it.
	// Strictly `> max` to match the send gate (ChatInput's `overLimit` + the server
	// both reject only PAST the limit) — so a message exactly at the limit, which
	// IS sendable, never shows the rose "trim to send" state.
	const over = length > max;
	const opacity = over
		? 1
		: Math.min(
				1,
				(ratio - CHAR_COUNTER_VISIBLE_AT) /
					(CHAR_COUNTER_DANGER_AT - CHAR_COUNTER_VISIBLE_AT),
			);

	return (
		<span
			className="select-none text-[11px] tabular-nums tracking-tight"
			style={{
				opacity,
				color: over ? "var(--nova-rose)" : "var(--nova-amber)",
			}}
			aria-live="polite"
			title={
				over
					? `Over the ${max.toLocaleString()}-character limit — trim to send`
					: undefined
			}
		>
			{length.toLocaleString()}/{max.toLocaleString()}
		</span>
	);
}
