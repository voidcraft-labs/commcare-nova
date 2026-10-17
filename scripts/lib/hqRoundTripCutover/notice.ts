/**
 * The cutover's notice lines: what the writer stores in
 * `app_migration_notices.entries` for one app, from its plan.
 *
 * Document lines come from the transform's changes and the no-write
 * selections (`./behavior.ts`). Deployment lines come from each deployment's
 * class, its pairs and the migrated document, with no probe of HQ: a
 * `deleted` deployment gets `hq-app-deleted` alone and an `unsupported` one
 * `hq-app-not-nova-made` alone, and a line about the next publish to a
 * project space is written only for a class that has one (`read-in-full`,
 * `no-form-ids`, `unreadable`). The two lines that are facts of the database
 * and the ledger rather than of the document come from the plan:
 * `unsaved-assistant-work-discarded` from `discardsPrivateWork`, and
 * `ccz-needs-project-space` from whether any deployment still holds the
 * app's content once the cutover's ledger writes are made. The two drift
 * lines come from the baselines the cutover stores (`baselineNotices`) and
 * are merged with each deployment's other lines in the enum's order.
 */

import { asUuid, type BlueprintDoc } from "@/lib/domain";
import { entryPointInventory } from "@/lib/domain/entryPoints";
import {
	DEPLOYMENT_NOTICE_REASONS,
	type DeploymentNoticeReason,
	type MigrationNoticeEntry,
	migrationNoticeEntriesSchema,
	NOTICE_TEXT_MAX,
	type NoticeEntityRef,
} from "@/lib/notices/migrationNotice";
import type { RawDocument } from "./oldShape";
import type { AppPlan } from "./plan";
import { questionPaths } from "./questionPaths";
import type { DeploymentOutcome, DocumentChange } from "./transform";

/** The classes whose next publish a deployment line may speak about. */
const PUBLISHABLE: ReadonlySet<DeploymentOutcome> = new Set([
	"read-in-full",
	"no-form-ids",
	"unreadable",
]);

/**
 * One menu, form, lookup table or place a deployment line names, by uuid. A
 * menu's or form's name comes from the migrated document; a table's or a
 * place's is carried here, since the document does not hold it.
 */
export interface NoticeEntity {
	readonly kind: "module" | "form" | "lookupTable" | "location";
	readonly uuid: string;
	readonly name?: string;
}

/** One deployment line, content-free: its reason and the entities it names. */
export interface DeploymentNotice {
	readonly reason: DeploymentNoticeReason;
	readonly entities?: readonly NoticeEntity[];
}

/** What a deployment's lines are read from. */
export interface DeploymentNoticeSource {
	readonly outcome: DeploymentOutcome;
	/** Entities of today's document whose ids change once there. */
	readonly unpaired?: readonly NoticeEntity[];
	/** Paired forms whose stored form id no read gave. */
	readonly formIdsUnknown?: readonly string[];
}

/** The deployment reasons one deployment gets, in the enum's order. */
export function deploymentNoticeReasons(
	outcome: DeploymentOutcome,
	target: BlueprintDoc,
): DeploymentNoticeReason[] {
	return deploymentNotices({ outcome }, target).map((notice) => notice.reason);
}

/**
 * The lines one deployment gets, in the enum's order. A `deleted` deployment
 * gets `hq-app-deleted` alone and an `unsupported` one `hq-app-not-nova-made`
 * alone, since no later publish there does what the other lines say.
 */
export function deploymentNotices(
	source: DeploymentNoticeSource,
	target: BlueprintDoc,
): DeploymentNotice[] {
	const { outcome } = source;
	if (outcome === "deleted") return [{ reason: "hq-app-deleted" }];
	if (outcome === "unsupported") return [{ reason: "hq-app-not-nova-made" }];
	if (!PUBLISHABLE.has(outcome)) return [];
	const notices = new Map<DeploymentNoticeReason, DeploymentNotice>();
	if (outcome === "unreadable") {
		notices.set("ids-change-once-unreadable", {
			reason: "ids-change-once-unreadable",
		});
	}
	const unpaired = source.unpaired ?? [];
	if (unpaired.length > 0) {
		notices.set("menu-id-changes-once", {
			reason: "menu-id-changes-once",
			entities: unpaired.map(({ kind, uuid }) => ({ kind, uuid })),
		});
	}
	const formIdsUnknown = source.formIdsUnknown ?? [];
	if (outcome === "no-form-ids" && formIdsUnknown.length > 0) {
		notices.set("form-ids-change-once", {
			reason: "form-ids-change-once",
			entities: formIdsUnknown.map((uuid) => ({ kind: "form", uuid })),
		});
	}
	if (entryPointInventory(target).length > 0) {
		notices.set("deep-links-need-republish", {
			reason: "deep-links-need-republish",
		});
	}
	return DEPLOYMENT_NOTICE_REASONS.flatMap((reason) => {
		const notice = notices.get(reason);
		return notice === undefined ? [] : [notice];
	});
}

/** What the cutover's baseline step recorded for one deployment. */
export interface DeploymentBaselineSource {
	readonly outcome: DeploymentOutcome;
	/** The origin of the app's own baseline; null where none is written. */
	readonly app: "cutover" | "unread" | null;
	/** Each mapped table and place whose baseline is `unread`, in the order written. */
	readonly unreadResources: readonly NoticeEntity[];
}

/**
 * The two drift lines one deployment gets from its baselines (part 02 of
 * step 2's plan, "The cutover's baselines"). A `cutover` app baseline means
 * the first publish there writes over edits made in HQ before the cutover,
 * so it gets `next-publish-overwrites-hq-edits`. Any `unread` baseline gets
 * `next-publish-asks-before-overwriting`: naming no entity where the app's
 * own baseline is the one not read, and naming each unread table and place
 * otherwise. Only a class whose next publish reaches the drift check gets
 * either: a `deleted` app holds no baseline and an `unsupported` one is
 * refused outright, so its `hq-app-not-nova-made` line stands alone.
 */
export function baselineNotices(
	source: DeploymentBaselineSource,
): DeploymentNotice[] {
	if (!PUBLISHABLE.has(source.outcome)) return [];
	const notices: DeploymentNotice[] = [];
	if (source.app === "cutover") {
		notices.push({ reason: "next-publish-overwrites-hq-edits" });
	}
	if (source.app === "unread") {
		notices.push({ reason: "next-publish-asks-before-overwriting" });
	} else if (source.unreadResources.length > 0) {
		notices.push({
			reason: "next-publish-asks-before-overwriting",
			entities: source.unreadResources,
		});
	}
	return notices;
}

/** Two lists of one deployment's lines as one, in the enum's order. */
export function mergeDeploymentNotices(
	first: readonly DeploymentNotice[],
	second: readonly DeploymentNotice[],
): DeploymentNotice[] {
	const all = [...first, ...second];
	return DEPLOYMENT_NOTICE_REASONS.flatMap((reason) =>
		all.filter((notice) => notice.reason === reason),
	);
}

/**
 * `ccz-needs-project-space`: an app that is not deleted and whose content no
 * deployment holds once the cutover's ledger writes are made (a deployment
 * the cutover finds deleted holds none) gets one line, naming the app. A CCZ
 * is made for a project space the app is published to, and one downloaded
 * earlier named no server.
 */
export function cczNeedsProjectSpace(input: {
	readonly appName: string;
	readonly deleted: boolean;
	readonly reachedAfterCutover: boolean;
}): DocumentChange[] {
	if (input.deleted || input.reachedAfterCutover) return [];
	return [
		{
			reason: "ccz-needs-project-space",
			entity: { type: "app", nameAtMigration: noticeText(input.appName) },
		},
	];
}

/**
 * The name of every menu and form a deployment line can name, by uuid: the
 * migrated document's, the hidden menu a no-matches form is lifted into
 * included under its form's name.
 */
export function noticeEntityNames(
	target: RawDocument,
): ReadonlyMap<string, string> {
	const names = new Map<string, string>();
	for (const menu of questionPaths(target)) {
		names.set(menu.uuid, menu.name);
		for (const form of menu.forms) names.set(form.uuid, form.name);
	}
	return names;
}

/** Cut a stored name or detail value at the length an entry keeps. */
export function noticeText(value: string): string {
	return value.length > NOTICE_TEXT_MAX
		? value.slice(0, NOTICE_TEXT_MAX)
		: value;
}

/**
 * One app's notice entries, in the order the writer stores them: each
 * deployment's lines in deployment order, the plan's and its baselines'
 * merged in the enum's order, then the document lines in step order, then
 * the no-write lines. Empty where the app gets no notice.
 */
export function appNoticeEntries(
	app: AppPlan,
	appName: string,
	entityNames: ReadonlyMap<string, string> = new Map(),
	baselineLines: ReadonlyMap<string, readonly DeploymentNotice[]> = new Map(),
): readonly MigrationNoticeEntry[] {
	const entries: MigrationNoticeEntry[] = [];
	const entityRef = (entity: NoticeEntity): NoticeEntityRef => ({
		type: entity.kind,
		uuid: asUuid(entity.uuid),
		nameAtMigration: noticeText(
			entity.name ?? entityNames.get(entity.uuid) ?? "",
		),
	});
	for (const deployment of app.deployments) {
		for (const notice of mergeDeploymentNotices(
			deployment.notices,
			baselineLines.get(deployment.deploymentId) ?? [],
		)) {
			entries.push({
				kind: "deployment",
				reason: notice.reason,
				deployment: {
					deploymentId: asUuid(deployment.deploymentId),
					server: deployment.server as MigrationNoticeEntryServer,
					domain: deployment.domain,
				},
				...(notice.entities !== undefined && {
					entities: notice.entities.map(entityRef),
				}),
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
