/** The migration notice journey's fixture: one app with a notice about one
 * project space and one discarded piece of assistant work, and one saved-key
 * line for the same project space. */
export const APP_NOTICES_SEED = {
	appName: "Field visits",
	cutover: "hq-round-trip-emission",
	domain: "field-ops",
	firstUsedAt: "2026-10-06T09:00:00.000Z",
	lastUsedAt: "2026-10-06T09:05:00.000Z",
	deepLinksLine:
		"Links to field-ops that you already shared keep working. New ones are ready after the next publish there.",
	discardedLine:
		"Changes the assistant was still working on here were not saved before this update. The saved app is unchanged. Ask again to pick the work back up.",
} as const;

/** This app's notice entries, in the stored shape production holds. */
export function appNoticesEntries(deploymentId: string): readonly unknown[] {
	return [
		{
			kind: "document",
			reason: "unsaved-assistant-work-discarded",
			entity: { type: "app", nameAtMigration: APP_NOTICES_SEED.appName },
		},
		{
			kind: "deployment",
			reason: "deep-links-need-republish",
			deployment: {
				deploymentId,
				server: "production",
				domain: APP_NOTICES_SEED.domain,
			},
		},
	];
}
