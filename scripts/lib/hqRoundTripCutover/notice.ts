/**
 * The cutover's notice lines: what the writer stores in
 * `app_migration_notices.entries` for one app, from its plan.
 *
 * Document lines come from the transform's changes and the no-write
 * selections (`./behavior.ts`). Deployment lines come from each deployment's
 * class and the migrated document, with no probe of HQ: a line about the next
 * publish to a project space is written only for a class that has one
 * (`read-in-full`, `no-form-ids`, `unreadable`). The one line that is a fact
 * of the database rather than of the document,
 * `unsaved-assistant-work-discarded`, comes from the plan's
 * `discardsPrivateWork`.
 */

import { asUuid, type BlueprintDoc } from "@/lib/domain";
import { entryPointInventory } from "@/lib/domain/entryPoints";
import {
	DEPLOYMENT_NOTICE_REASONS,
	type DeploymentNoticeReason,
	type MigrationNoticeEntry,
	migrationNoticeEntriesSchema,
	NOTICE_TEXT_MAX,
} from "@/lib/notices/migrationNotice";
import type { AppPlan } from "./plan";
import type { DeploymentOutcome } from "./transform";

/** The classes whose next publish a deployment line may speak about. */
const PUBLISHABLE: ReadonlySet<DeploymentOutcome> = new Set([
	"read-in-full",
	"no-form-ids",
	"unreadable",
]);

/** The deployment reasons one deployment gets, in the enum's order. */
export function deploymentNoticeReasons(
	outcome: DeploymentOutcome,
	target: BlueprintDoc,
): DeploymentNoticeReason[] {
	const reasons = new Set<DeploymentNoticeReason>();
	if (PUBLISHABLE.has(outcome) && entryPointInventory(target).length > 0) {
		reasons.add("deep-links-need-republish");
	}
	return DEPLOYMENT_NOTICE_REASONS.filter((reason) => reasons.has(reason));
}

/** Cut a stored name or detail value at the length an entry keeps. */
export function noticeText(value: string): string {
	return value.length > NOTICE_TEXT_MAX
		? value.slice(0, NOTICE_TEXT_MAX)
		: value;
}

/**
 * One app's notice entries, in the order the writer stores them: each
 * deployment's lines in deployment order, then the document lines in step
 * order, then the no-write lines. Empty where the app gets no notice.
 */
export function appNoticeEntries(
	app: AppPlan,
	appName: string,
): readonly MigrationNoticeEntry[] {
	const entries: MigrationNoticeEntry[] = [];
	for (const deployment of app.deployments) {
		for (const reason of deployment.notices) {
			entries.push({
				kind: "deployment",
				reason,
				deployment: {
					deploymentId: asUuid(deployment.deploymentId),
					server: deployment.server as MigrationNoticeEntryServer,
					domain: deployment.domain,
				},
			});
		}
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
	if (app.discardsPrivateWork) {
		entries.push({
			kind: "document",
			reason: "unsaved-assistant-work-discarded",
			entity: { type: "app", nameAtMigration: noticeText(appName) },
		});
	}
	if (entries.length === 0) return [];
	return migrationNoticeEntriesSchema.parse(entries);
}

type MigrationNoticeEntryServer = Extract<
	MigrationNoticeEntry,
	{ kind: "deployment" }
>["deployment"]["server"];
