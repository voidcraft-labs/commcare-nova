/**
 * Pure grouping and ordering for the builder's migration notice dialog and
 * chip: the dialog's sections, the chip's count, and where an entity line
 * links. Which lines a Publishing card keeps is `publishingSectionModel.ts`'s.
 *
 * Every order here comes from `orderNoticeEntries`, the one order `get_app`
 * returns lines in too, so the dialog and an MCP client read the same list.
 */

import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { entryPointByUuid } from "@/lib/domain/entryPoints";
import type { Uuid } from "@/lib/domain/uuid";
import {
	type AppDeploymentNoticeEntry,
	type AppMigrationNotice,
	type DocumentNoticeReason,
	type MigrationNoticeCutover,
	type NoticeEntityRef,
	orderNoticeEntries,
} from "@/lib/notices/migrationNotice";
import {
	type NoticeLine,
	type NoticeRenderContext,
	noticeChipLabel,
	projectSpaceGroupHeading,
	renderNoticeEntry,
} from "@/lib/notices/migrationNoticeCopy";

/** The notice data the builder page loads in the same request as the app. */
export interface BuilderNotices {
	/** The notices this member has not dismissed, newest first. */
	readonly notices: readonly AppMigrationNotice[];
	/** Every notice's deployment entries, dismissed or not, for the Publishing card. */
	readonly deploymentEntries: readonly AppDeploymentNoticeEntry[];
}

export const NO_BUILDER_NOTICES: BuilderNotices = {
	notices: [],
	deploymentEntries: [],
};

export type NoticeDialogGroup =
	| {
			readonly kind: "deployment";
			readonly key: string;
			readonly heading: string;
			readonly lines: readonly NoticeLine[];
	  }
	| {
			readonly kind: "document";
			readonly key: string;
			readonly reason: DocumentNoticeReason;
			readonly lines: readonly NoticeLine[];
	  };

export interface NoticeDialogSection {
	readonly noticeId: string;
	readonly cutover: MigrationNoticeCutover;
	readonly createdAt: string;
	readonly groups: readonly NoticeDialogGroup[];
}

/** The chip's label, or null when there is nothing to review. */
export function appNoticeChipLabel(
	notices: readonly AppMigrationNotice[],
): string | null {
	return notices.length === 0 ? null : noticeChipLabel(notices.length);
}

/**
 * One section per notice, newest first as the store returns them. Inside a
 * section: deployment entries grouped by project space (server, then
 * domain), then document entries grouped by reason, each in the order
 * `orderNoticeEntries` gives.
 */
export function noticeDialogSections(
	notices: readonly AppMigrationNotice[],
	ctx: NoticeRenderContext,
): readonly NoticeDialogSection[] {
	return notices.map((notice) => {
		const groups: NoticeDialogGroup[] = [];
		for (const entry of orderNoticeEntries(notice.entries)) {
			const line = renderNoticeEntry(entry, ctx);
			const key =
				entry.kind === "deployment"
					? `deployment\u0000${entry.deployment.server}\u0000${entry.deployment.domain}`
					: `document\u0000${entry.reason}`;
			const last = groups.at(-1);
			if (last !== undefined && last.key === key) {
				groups[groups.length - 1] = { ...last, lines: [...last.lines, line] };
				continue;
			}
			groups.push(
				entry.kind === "deployment"
					? {
							kind: "deployment",
							key,
							heading: projectSpaceGroupHeading(entry.deployment.domain),
							lines: [line],
						}
					: { kind: "document", key, reason: entry.reason, lines: [line] },
			);
		}
		return {
			noticeId: notice.id,
			cutover: notice.cutover,
			createdAt: notice.createdAt,
			groups,
		};
	});
}

/** The notices left once the member dismissed `dismissedIds`. */
export function withoutDismissed(
	notices: readonly AppMigrationNotice[],
	dismissedIds: readonly string[],
): readonly AppMigrationNotice[] {
	const dismissed = new Set(dismissedIds);
	return notices.filter((notice) => !dismissed.has(notice.id));
}

// ── Where an entity line links ──────────────────────────────────────────

export type NoticeEntityDestination =
	| { readonly kind: "module"; readonly moduleUuid: Uuid }
	| {
			readonly kind: "form";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
			readonly fieldUuid?: Uuid;
	  }
	| { readonly kind: "case-list"; readonly moduleUuid: Uuid }
	| { readonly kind: "search"; readonly moduleUuid: Uuid }
	| {
			readonly kind: "app-setup";
			readonly section: "languages" | "deep-links";
			readonly entryPointUuid?: Uuid;
	  };

function moduleOfForm(doc: BlueprintDoc, formUuid: Uuid): Uuid | undefined {
	return doc.moduleOrder.find((moduleUuid) =>
		(doc.formOrder[moduleUuid] ?? []).includes(formUuid),
	);
}

function formOfField(doc: BlueprintDoc, fieldUuid: Uuid): Uuid | undefined {
	let parent = doc.fieldParent[fieldUuid];
	while (parent !== undefined && !Object.hasOwn(doc.forms, parent)) {
		parent = doc.fieldParent[parent];
	}
	return parent;
}

/**
 * Where the dialog takes a person who follows an entity's name, or null
 * where the entity has no place in the builder to open (the app itself, a
 * lookup table or place the document does not hold, or one that is gone).
 */
export function noticeEntityDestination(
	doc: BlueprintDoc,
	entity: NoticeEntityRef,
): NoticeEntityDestination | null {
	if (entity.type === "language") {
		return { kind: "app-setup", section: "languages" };
	}
	const uuid = entity.uuid;
	if (uuid === undefined) return null;
	switch (entity.type) {
		case "module":
			return Object.hasOwn(doc.modules, uuid)
				? { kind: "module", moduleUuid: uuid }
				: null;
		case "form": {
			const moduleUuid = moduleOfForm(doc, uuid);
			return moduleUuid === undefined
				? null
				: { kind: "form", moduleUuid, formUuid: uuid };
		}
		case "field": {
			const formUuid = formOfField(doc, uuid);
			const moduleUuid =
				formUuid === undefined ? undefined : moduleOfForm(doc, formUuid);
			return formUuid === undefined || moduleUuid === undefined
				? null
				: { kind: "form", moduleUuid, formUuid, fieldUuid: uuid };
		}
		case "entryPoint":
			return entryPointByUuid(doc, uuid) === undefined
				? null
				: { kind: "app-setup", section: "deep-links", entryPointUuid: uuid };
		case "caseListColumn":
		case "searchInput": {
			const moduleUuid = doc.moduleOrder.find((candidate) => {
				const config = doc.modules[candidate]?.caseListConfig;
				return entity.type === "caseListColumn"
					? config?.columns.some((column) => column.uuid === uuid)
					: config?.searchInputs.some((input) => input.uuid === uuid);
			});
			if (moduleUuid === undefined) return null;
			return entity.type === "caseListColumn"
				? { kind: "case-list", moduleUuid }
				: { kind: "search", moduleUuid };
		}
		default:
			return null;
	}
}
