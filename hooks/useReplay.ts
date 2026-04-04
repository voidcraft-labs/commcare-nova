/**
 * Shared replay hook — fetches logs, extracts stages, and navigates
 * to the builder. Used by both the builds page (own apps) and the
 * admin user detail page (any user's apps).
 */
"use client";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import type { StoredEvent } from "@/lib/db/types";
import { extractReplayStages, setReplayData } from "@/lib/services/logReplay";

interface UseReplayOptions {
	/** Build the logs fetch URL for a given app ID. */
	buildUrl: (appId: string) => string;
}

export function useReplay({ buildUrl }: UseReplayOptions) {
	const router = useRouter();
	const [replayingId, setReplayingId] = useState<string | null>(null);
	const [replayError, setReplayError] = useState<string | null>(null);

	const handleReplay = useCallback(
		async (appId: string, appName: string) => {
			setReplayingId(appId);
			setReplayError(null);
			try {
				const res = await fetch(buildUrl(appId));
				if (!res.ok) throw new Error("Failed to load logs");
				const { events } = (await res.json()) as { events: StoredEvent[] };
				if (!events.length) {
					setReplayError("No generation logs found for this app.");
					return;
				}

				const result = extractReplayStages(events);
				if (!result.success) {
					setReplayError(result.error);
					return;
				}

				setReplayData(result.stages, result.doneIndex, appName || undefined);
				router.push("/build/new");
			} catch (err) {
				console.error("[replay] failed:", err);
				setReplayError("Failed to load replay data. Please try again.");
			} finally {
				setReplayingId(null);
			}
		},
		[buildUrl, router],
	);

	return {
		handleReplay,
		replayingId,
		replayError,
		clearReplayError: () => setReplayError(null),
	};
}
