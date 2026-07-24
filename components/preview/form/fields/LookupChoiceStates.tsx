"use client";
import { Skeleton } from "@/components/shadcn/skeleton";

/**
 * The two non-list states of a lookup-backed select's choice area.
 * Loading covers the builder session's fixture fetch (the engine's
 * `choices` slot is still undefined); empty is a real evaluated
 * result — zero rows match the filter right now, exactly what the
 * device would render, stated in a quiet line instead of a bare gap.
 */
export function LookupChoicesLoading() {
	return (
		<div className="space-y-1.5" aria-busy="true">
			<Skeleton className="h-10 w-full rounded-lg" />
			<Skeleton className="h-10 w-full rounded-lg" />
			<Skeleton className="h-10 w-3/4 rounded-lg" />
		</div>
	);
}

export function LookupChoicesEmpty() {
	return (
		<p className="px-3 py-2 text-sm text-nova-text-muted">
			No choices match right now.
		</p>
	);
}
