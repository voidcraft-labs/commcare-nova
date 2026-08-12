interface ArtifactProducer {
	readonly createdByRunId: string;
}

/** Every persisted design artifact is evidence that its producing run spent
 * model work. The release-cost gate must register all of them before it asks
 * which run summaries are missing; discovering runs from summaries alone
 * would make a failed summary write invisible. */
export function collectDesignArtifactProducerRunIds(
	...producerGroups: readonly (readonly ArtifactProducer[])[]
): string[] {
	return [
		...new Set([
			...producerGroups.flatMap((group) =>
				group.map((producer) => producer.createdByRunId),
			),
		]),
	];
}

/** Join artifact evidence to flushed summaries without letting an interrupted
 * summary write erase the run from diagnostics. */
export function designArtifactDiagnosticRuns(
	producerRunIds: readonly string[],
	summaryRunIds: readonly string[],
): { readonly runIds: string[]; readonly missingSummaryCount: number } {
	const summarized = new Set(summaryRunIds);
	return {
		runIds: [...new Set([...producerRunIds, ...summaryRunIds])],
		missingSummaryCount: producerRunIds.filter(
			(runId) => !summarized.has(runId),
		).length,
	};
}
