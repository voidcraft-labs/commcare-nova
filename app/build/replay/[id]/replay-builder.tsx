/**
 * ReplayBuilder — client leaf that extracts replay stages from server-fetched
 * events and renders the builder in replay mode. Stage extraction is pure
 * computation (no async, no DOM) so it runs in a useState initializer.
 * Extraction failures throw and are caught by the nearest error boundary.
 */
"use client";
import { useState } from "react";
import { BuilderLayout } from "@/components/builder/BuilderLayout";
import { BuilderProvider } from "@/components/builder/BuilderProvider";
import type { StoredEvent } from "@/lib/db/types";
import { extractReplayStages } from "@/lib/services/logReplay";
import type { ReplayInit } from "@/lib/session/types";

interface ReplayBuilderProps {
	/** Raw event log from Firestore, pre-ordered by sequence. */
	events: StoredEvent[];
	/** Path to navigate to when the user exits replay mode. */
	exitPath: string;
}

export function ReplayBuilder({ events, exitPath }: ReplayBuilderProps) {
	/* Extract once — throws on failure, caught by the error boundary. */
	const [replay] = useState<ReplayInit>(() => {
		const result = extractReplayStages(events);
		if (!result.success) {
			throw new Error(result.error);
		}
		return {
			stages: result.stages,
			doneIndex: result.doneIndex,
			exitPath,
		};
	});

	return (
		<BuilderProvider buildId="replay" replay={replay}>
			<BuilderLayout />
		</BuilderProvider>
	);
}
