/**
 * What a stored-shape cutover changed in one app, as the lines its members
 * read once.
 *
 * A cutover writes one notice per app it changed (`app_migration_notices`),
 * its `entries` the lines below. Each entry carries a closed reason, and each
 * reason has exactly one renderer (`migrationNoticeCopy.ts`), the same
 * obligation a validator message carries. A `document` entry names an entity
 * of the app; a `deployment` entry names one project space the app is
 * published to, by the domain the deployment holds.
 *
 * Authored names are stored as `nameAtMigration`, because an entity may be
 * renamed or removed before a member reads the notice. They are client
 * content: they stay in the row and never reach a log line or a report.
 *
 * Client-safe: the builder, the home page and MCP all read these shapes.
 */

import { z } from "zod";
import { deploymentServerSchema } from "@/lib/deployment/types";
import { languageTagSchema } from "@/lib/domain/localization";
import { uuidSchema } from "@/lib/domain/uuid";

/**
 * The cutovers that write notices. Each has its own lead sentence in the
 * dialog (`migrationNoticeCopy.ts::MIGRATION_NOTICE_LEADS`).
 */
export const MIGRATION_NOTICE_CUTOVERS = ["hq-round-trip-emission"] as const;
export type MigrationNoticeCutover = (typeof MIGRATION_NOTICE_CUTOVERS)[number];
export const migrationNoticeCutoverSchema = z.enum(MIGRATION_NOTICE_CUTOVERS);

/**
 * Reasons a document entry can carry, in the order the dialog and `get_app`
 * show them: the transform steps' reasons in step order, then
 * `lookup-tag-renamed`, then the reasons for changes that write nothing.
 * A reason joins the list at its place in that order, never at the end.
 */
export const DOCUMENT_NOTICE_REASONS = [
	"search-button-text-changed",
	"question-renamed",
	"case-operation-renamed",
	"connect-block-renamed",
	"connect-task-moved-to-own-form",
	"entry-point-renamed",
	"option-value-split",
	"option-label-filled",
	"empty-form-label-added",
	"session-read-removed",
	"search-input-renamed",
	"search-input-removed",
	"hidden-from-menu-set",
	"after-submit-destination-moved",
	"id-mapping-entry-removed",
	"date-pattern-apostrophe-replaced",
	"tile-order-rule-removed",
	"order-rule-removed-same-property",
	"order-rule-moved-to-first-column",
	"tile-cell-defaults-set",
	"android-form-lists-setting-stored",
	"validation-now-enforced",
	"follow-up-now-touches-case",
	"linked-follow-up-now-writes-case",
	"close-moves-to-save-to-case",
	"lookup-choices-order-changes",
	"survey-menu-takes-case-type",
	"case-list-order-changes",
	"case-list-search-matches-hidden-fields",
	"hidden-order-column-not-in-sort-menu",
	"record-id-column-now-shows",
	"local-archive-changes",
	"case-name-now-checked",
	"unsaved-assistant-work-discarded",
	"ccz-needs-project-space",
] as const;
export type DocumentNoticeReason = (typeof DOCUMENT_NOTICE_REASONS)[number];

/**
 * Reasons a deployment entry can carry, in the order the dialog, the
 * Publishing card and `get_app` show them.
 */
export const DEPLOYMENT_NOTICE_REASONS = [
	"hq-app-deleted",
	"hq-app-not-nova-made",
	"ids-change-once-unreadable",
	"menu-id-changes-once",
	"form-ids-change-once",
	"data-paths-move-once",
	"deep-links-need-republish",
	"next-publish-overwrites-hq-edits",
	"next-publish-asks-before-overwriting",
	"next-publish-asks-more",
	"commcare-version-below-floor",
	"logo-upload-in-hq",
	"setting-changes-at-next-publish",
	"settings-unknown-unreadable",
	"worker-settings-reset-at-next-publish",
] as const;
export type DeploymentNoticeReason = (typeof DEPLOYMENT_NOTICE_REASONS)[number];

export const NOTICE_ENTITY_TYPES = [
	"app",
	"module",
	"form",
	"field",
	"caseListColumn",
	"searchInput",
	"language",
	"entryPoint",
	"lookupTable",
	"location",
] as const;
export type NoticeEntityType = (typeof NOTICE_ENTITY_TYPES)[number];

/** The longest `nameAtMigration` or `detail` value an entry stores. */
export const NOTICE_TEXT_MAX = 200;

const noticeEntityRefSchema = z.strictObject({
	type: z.enum(NOTICE_ENTITY_TYPES),
	/** Absent only for `app` and `language`. */
	uuid: uuidSchema.optional(),
	languageTag: languageTagSchema.optional(),
	/** Shown when the entity no longer exists. */
	nameAtMigration: z.string().max(NOTICE_TEXT_MAX),
});

const noticeDeploymentRefSchema = z.strictObject({
	deploymentId: uuidSchema,
	server: deploymentServerSchema,
	domain: z.string().min(1),
});

const noticeDetailSchema = z.record(
	z.string(),
	z.string().max(NOTICE_TEXT_MAX),
);

export const migrationNoticeEntrySchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("document"),
		reason: z.enum(DOCUMENT_NOTICE_REASONS),
		entity: noticeEntityRefSchema,
		detail: noticeDetailSchema.optional(),
	}),
	z.strictObject({
		kind: z.literal("deployment"),
		reason: z.enum(DEPLOYMENT_NOTICE_REASONS),
		deployment: noticeDeploymentRefSchema,
		entities: z.array(noticeEntityRefSchema).optional(),
		detail: noticeDetailSchema.optional(),
	}),
]);

/** A notice's `entries`: never empty, as the table's CHECK requires. */
export const migrationNoticeEntriesSchema = z
	.array(migrationNoticeEntrySchema)
	.min(1);

export type MigrationNoticeEntry = z.infer<typeof migrationNoticeEntrySchema>;
export type DocumentNoticeEntry = Extract<
	MigrationNoticeEntry,
	{ kind: "document" }
>;
export type DeploymentNoticeEntry = Extract<
	MigrationNoticeEntry,
	{ kind: "deployment" }
>;
/** What a `DocumentChange` names as its entity. */
export type NoticeEntityRef = z.infer<typeof noticeEntityRefSchema>;
export type NoticeDeploymentRef = DeploymentNoticeEntry["deployment"];
export type MigrationNoticeReason = MigrationNoticeEntry["reason"];

/** One notice a member has not dismissed, as every surface receives it. */
export interface AppMigrationNotice {
	readonly id: string;
	readonly cutover: MigrationNoticeCutover;
	/** ISO timestamp; the dialog's lead names its day. */
	readonly createdAt: string;
	readonly entries: readonly MigrationNoticeEntry[];
}

/**
 * One deployment entry of a notice, dismissed or not, with the time its
 * notice was written. The Publishing card keeps these until a publish to
 * that project space has happened since.
 */
export interface AppDeploymentNoticeEntry {
	readonly noticeId: string;
	readonly createdAt: string;
	readonly entry: DeploymentNoticeEntry;
}

/**
 * One project space a cutover's execute run sent the member's own stored
 * CommCare HQ key to. It never names an app: the person may since have left
 * the Project the app belongs to.
 */
export interface KeyReaderNotice {
	readonly cutover: string;
	readonly server: z.infer<typeof deploymentServerSchema>;
	readonly domain: string;
	readonly firstUsedAt: string;
	readonly lastUsedAt: string;
}

const SERVER_ORDER: readonly string[] = deploymentServerSchema.options;

function indexIn(list: readonly string[], value: string): number {
	return list.indexOf(value);
}

/**
 * A notice's entries in the order every surface shows them: deployment
 * entries first, by project space (server in the catalog's order, then
 * domain), each space's entries in the order of `DEPLOYMENT_NOTICE_REASONS`;
 * then document entries in the order of `DOCUMENT_NOTICE_REASONS`. Inside a
 * reason, entries keep the order the writer stored them in.
 */
export function orderNoticeEntries(
	entries: readonly MigrationNoticeEntry[],
): readonly MigrationNoticeEntry[] {
	const deployment: { entry: DeploymentNoticeEntry; at: number }[] = [];
	const document: { entry: DocumentNoticeEntry; at: number }[] = [];
	entries.forEach((entry, at) => {
		if (entry.kind === "deployment") deployment.push({ entry, at });
		else document.push({ entry, at });
	});
	deployment.sort(
		(a, b) =>
			indexIn(SERVER_ORDER, a.entry.deployment.server) -
				indexIn(SERVER_ORDER, b.entry.deployment.server) ||
			compareText(a.entry.deployment.domain, b.entry.deployment.domain) ||
			indexIn(DEPLOYMENT_NOTICE_REASONS, a.entry.reason) -
				indexIn(DEPLOYMENT_NOTICE_REASONS, b.entry.reason) ||
			a.at - b.at,
	);
	document.sort(
		(a, b) =>
			indexIn(DOCUMENT_NOTICE_REASONS, a.entry.reason) -
				indexIn(DOCUMENT_NOTICE_REASONS, b.entry.reason) || a.at - b.at,
	);
	return [
		...deployment.map((item) => item.entry),
		...document.map((item) => item.entry),
	];
}

/** Code-point order, so the grouping never depends on the runtime's locale. */
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
