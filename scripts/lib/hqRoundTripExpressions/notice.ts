/**
 * The expressions cutover's notice rows: what the writer stores in
 * `app_migration_notices.entries` for one app, cutover
 * `hq-round-trip-expressions` (part 09 §12), from its plan alone.
 *
 * Document lines are the plan's changes: the steps' in step order, then the
 * no-write selections of `./behavior.ts`. Deployment lines are facts of the
 * plan too: `expressions-sent-at-next-publish` for every deployment of an
 * app with an entry whose change reaches the wire, and
 * `deep-links-need-republish` for every deployment of an app with entry
 * points (`./behavior.ts::deploymentChanges`). The renderers
 * (`lib/notices/migrationNoticeCopy.ts`) read each line's `detail` keys as
 * the steps and selections write them.
 *
 * Names and details are authored content: they reach the row and never the
 * report. Each is cut at the length an entry keeps.
 */

import { deploymentServerSchema } from "@/lib/deployment/types";
import { asUuid } from "@/lib/domain";
import {
	type MigrationNoticeEntry,
	migrationNoticeEntriesSchema,
	NOTICE_TEXT_MAX,
} from "@/lib/notices/migrationNotice";
import { type AppPlan, appDeploymentChanges } from "./plan";

/** Cut a stored name or detail value at the length an entry keeps. */
export function noticeText(value: string): string {
	return value.length > NOTICE_TEXT_MAX
		? value.slice(0, NOTICE_TEXT_MAX)
		: value;
}

/**
 * One app's notice entries, in the order the writer stores them: each
 * deployment's lines in deployment order, then the document lines in the
 * plan's order. Empty where the app gets no notice row. Every surface
 * orders a notice's entries again by the reason lists when it shows them.
 */
export function appNoticeEntries(
	app: AppPlan,
): readonly MigrationNoticeEntry[] {
	const entries: MigrationNoticeEntry[] = [];
	const byId = new Map(
		app.deployments.map((deployment) => [deployment.deploymentId, deployment]),
	);
	for (const line of appDeploymentChanges(app)) {
		const deployment = byId.get(line.deploymentId);
		if (deployment === undefined) continue;
		entries.push({
			kind: "deployment",
			reason: line.reason,
			deployment: {
				deploymentId: asUuid(deployment.deploymentId),
				server: deploymentServerSchema.parse(deployment.server),
				domain: deployment.domain,
			},
		});
	}
	for (const change of app.changes) {
		entries.push({
			kind: "document",
			reason: change.reason,
			entity: {
				...change.entity,
				nameAtMigration: noticeText(change.entity.nameAtMigration),
			},
			...(change.detail !== undefined && {
				detail: Object.fromEntries(
					Object.entries(change.detail).map(([key, value]) => [
						key,
						noticeText(value),
					]),
				),
			}),
		});
	}
	if (entries.length === 0) return [];
	return migrationNoticeEntriesSchema.parse(entries);
}
