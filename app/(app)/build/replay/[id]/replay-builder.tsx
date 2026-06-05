/**
 * ReplayBuilder — client leaf that seeds the builder's replay state from the
 * server-fetched event log. Chapter derivation is pure computation (no async,
 * no DOM) so it runs in a useState initializer. Derivation failures throw
 * and are caught by the nearest error boundary.
 */
"use client";
import { useState } from "react";
import { BuilderLayout } from "@/components/builder/BuilderLayout";
import { BuilderProvider } from "@/components/builder/BuilderProvider";
import { deriveReplayChapters } from "@/lib/log/replayChapters";
import type { Event } from "@/lib/log/types";
import type { ReplayInit } from "@/lib/session/types";

interface ReplayBuilderProps {
	/** Raw event log from Firestore, pre-ordered by (ts, seq). */
	events: Event[];
	/** Path to navigate to when the user exits replay mode. */
	exitPath: string;
	/**
	 * How many events were dropped for failing schema validation before this
	 * stream reached us. > 0 means the replay is reconstructed from a PARTIAL
	 * log — mutations apply in order, so a dropped one can land a state that
	 * never existed — so we surface a warning rather than letting the gap pass
	 * silently as a faithful replay.
	 */
	skippedEventCount?: number;
}

export function ReplayBuilder({
	events,
	exitPath,
	skippedEventCount = 0,
}: ReplayBuilderProps) {
	/* Derive chapters once — throws on empty log, caught by the error
	 * boundary. The server page already filters out empty logs before
	 * mounting us, so this guard is a last-resort invariant check. */
	const [replay] = useState<ReplayInit>(() => {
		if (events.length === 0) {
			throw new Error(
				"ReplayBuilder received empty events array; server page should have filtered this.",
			);
		}
		const chapters = deriveReplayChapters(events);
		return {
			events,
			chapters,
			/* Mount at the final frame; user scrolls back through chapters. */
			initialCursor: events.length - 1,
			exitPath,
		};
	});

	return (
		<>
			{skippedEventCount > 0 && (
				<div
					role="alert"
					className="fixed inset-x-0 top-0 z-modal border-nova-amber/30 border-b bg-nova-amber/15 px-4 py-2 text-center text-nova-amber text-sm"
				>
					{skippedEventCount} event
					{skippedEventCount === 1 ? "" : "s"} couldn't be read and{" "}
					{skippedEventCount === 1 ? "was" : "were"} skipped — this replay is
					reconstructed from a partial log and may be incomplete.
				</div>
			)}
			<BuilderProvider buildId="replay" replay={replay}>
				<BuilderLayout />
			</BuilderProvider>
		</>
	);
}
