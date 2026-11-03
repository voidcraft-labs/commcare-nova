/**
 * The case-writes cutover's notice entries (part 09 §7, §9 and §17): one
 * builder per reason this cutover writes, document lines for the steps of
 * section 7 and deployment lines for `deployment-lines` (section 9), and
 * `entriesForApp`, which collects one app's lines into what the writer's
 * `notices` step stores in `app_migration_notices.entries`.
 *
 * Each builder spells its reason's `detail` keys as its renderer in
 * `lib/notices/migrationNoticeCopy.ts` reads them. A name is authored
 * content: it reaches the notice row and the plan's digest, never the
 * report. An entity's `nameAtMigration` is cut at the length an entry keeps
 * (`noticeText`); a name in `detail` is stored only whole, and one longer
 * than an entry keeps is left out, so its line reads as the sentence without
 * it, as every renderer offers.
 */

import type { CommCareServer } from "@/lib/deployment/types";
import type { OtherwiseDestination } from "@/lib/domain/forms";
import { asUuid, type Uuid } from "@/lib/domain/uuid";
import {
	type DeploymentNoticeEntry,
	type DocumentNoticeEntry,
	type MigrationNoticeEntry,
	migrationNoticeEntriesSchema,
	NOTICE_TEXT_MAX,
	type NoticeDeploymentRef,
	type NoticeEntityRef,
} from "@/lib/notices/migrationNotice";
import {
	PLAN_FEATURE_IDS,
	type PlanFeatureId,
} from "@/lib/publish/planFeatures";
import { canonicalJsonText } from "@/lib/utils/canonicalJson";
import { PATH_MOVE_CAUSES, type PathMoveCause } from "./types";

// ─── Text ─────────────────────────────────────────────────────────────────

/**
 * A stored name cut to the length an entry keeps, between code points, with
 * a lone surrogate replaced so the row's JSON stays valid. Anything but a
 * string reads as the empty name.
 */
export function noticeText(value: unknown): string {
	const text = typeof value === "string" ? value : "";
	let cut = "";
	for (const point of text) {
		const code = point.codePointAt(0) ?? 0;
		const whole = code >= 0xd800 && code <= 0xdfff ? "�" : point;
		if (cut.length + whole.length > NOTICE_TEXT_MAX) break;
		cut += whole;
	}
	return cut;
}

/**
 * A name as `detail` stores it: whole, or not at all. A name that is absent,
 * empty or longer than an entry keeps is left out, and the line reads as its
 * sentence without the name.
 */
function detailName(value: string | undefined): string | undefined {
	if (value === undefined || value === "" || value.length > NOTICE_TEXT_MAX)
		return undefined;
	return noticeText(value);
}

/** A count as `detail` stores it. */
function detailCount(value: number): string {
	return String(value);
}

/** The keys that hold a value, or undefined where none does. */
function detailOf(
	values: Readonly<Record<string, string | undefined>>,
): Record<string, string> | undefined {
	const kept = Object.entries(values).filter(
		(pair): pair is [string, string] => pair[1] !== undefined,
	);
	return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

// ─── Entities and deployments ─────────────────────────────────────────────

/** An entity a document line names, as a step reads it from the document. */
export interface NamedEntity {
	readonly uuid: Uuid;
	/** The module's or form's name, or the field's id. */
	readonly name: string;
}

function entity(
	type: "module" | "form" | "field",
	named: NamedEntity,
): NoticeEntityRef {
	return { type, uuid: named.uuid, nameAtMigration: noticeText(named.name) };
}

function documentEntry(
	reason: DocumentNoticeEntry["reason"],
	entityRef: NoticeEntityRef,
	detail?: Record<string, string>,
): DocumentNoticeEntry {
	return {
		kind: "document",
		reason,
		entity: entityRef,
		...(detail !== undefined && { detail }),
	};
}

/** A live deployment, as section 8.1's read or the fleet source holds it. */
export interface NoticeDeployment {
	readonly deploymentId: string;
	readonly server: CommCareServer;
	readonly domain: string;
}

function deploymentRef(deployment: NoticeDeployment): NoticeDeploymentRef {
	return {
		deploymentId: asUuid(deployment.deploymentId),
		server: deployment.server,
		domain: deployment.domain,
	};
}

function deploymentEntry(
	reason: DeploymentNoticeEntry["reason"],
	deployment: NoticeDeployment,
	detail?: Record<string, string>,
): DeploymentNoticeEntry {
	return {
		kind: "deployment",
		reason,
		deployment: deploymentRef(deployment),
		...(detail !== undefined && { detail }),
	};
}

// ─── Document lines (section 7, section 17.2) ─────────────────────────────

/** Step `capture-link-writes` (C5): a capture question whose stored write
 *  saved the file itself now saves a link to it. */
export function captureSavesLink(
	field: NamedEntity,
	at: { readonly form: string; readonly property?: string },
): DocumentNoticeEntry {
	return documentEntry(
		"capture-saves-link",
		entity("field", field),
		detailOf({
			form: detailName(at.form),
			property: detailName(at.property),
		}),
	);
}

/** Step `writes-into-operations` (C9): a follow-up form whose own close ran
 *  through a case operation is now a close form. */
export function formBecameCloseForm(form: NamedEntity): DocumentNoticeEntry {
	return documentEntry("form-became-close-form", entity("form", form));
}

/** Step `form-link-semantics`, `conditions-written`: how many of the form's
 *  links Nova wrote the full condition of. */
export function formLinksConditionsWritten(
	form: NamedEntity,
	links: number,
): DocumentNoticeEntry {
	return documentEntry("form-links-conditions-written", entity("form", form), {
		links: detailCount(links),
	});
}

/** Where a form's Otherwise now goes: a named destination, or a built-in
 *  place with the built-in place it replaced (L6). */
export type OtherwiseTarget =
	| { readonly to: string }
	| {
			readonly toDestination: OtherwiseDestination;
			readonly from?: OtherwiseDestination;
	  };

/** Step `form-link-semantics`, `otherwise-set` (L2, L3, L6). */
export function formLinkOtherwiseSet(
	form: NamedEntity,
	target: OtherwiseTarget,
): DocumentNoticeEntry {
	return documentEntry(
		"form-link-otherwise-set",
		entity("form", form),
		"to" in target
			? detailOf({ to: detailName(target.to) })
			: detailOf({ toDestination: target.toDestination, from: target.from }),
	);
}

/** Step `form-link-semantics`, `after-submit-dropped`. */
export function afterSubmitDestinationDropped(
	form: NamedEntity,
): DocumentNoticeEntry {
	return documentEntry(
		"after-submit-destination-dropped",
		entity("form", form),
	);
}

/** Step `form-link-semantics`, `target-moved` (L4, and L8 with its cause). */
export function formLinkTargetMoved(
	form: NamedEntity,
	moved: {
		readonly from: string;
		readonly to: string;
		readonly cause?: "carried-not-a-case";
	},
): DocumentNoticeEntry {
	return documentEntry(
		"form-link-target-moved",
		entity("form", form),
		detailOf({
			from: detailName(moved.from),
			to: detailName(moved.to),
			cause: moved.cause,
		}),
	);
}

/** Step `form-link-semantics`, `link-removed` (L4's off-the-menu arm). */
export function formLinkRemoved(
	form: NamedEntity,
	to: string,
): DocumentNoticeEntry {
	return documentEntry(
		"form-link-removed",
		entity("form", form),
		detailOf({ to: detailName(to) }),
	);
}

/** Step `form-link-semantics`, `datums-dropped`. */
export function formLinkDatumsDropped(
	form: NamedEntity,
	to: string,
): DocumentNoticeEntry {
	return documentEntry(
		"form-link-datums-dropped",
		entity("form", form),
		detailOf({ to: detailName(to) }),
	);
}

/** Step `extension-children` (M1): a module whose forms now carry a created
 *  case to the next form. `entriesForApp` keeps one per module. */
export function moduleMadeAdvanced(
	module: NamedEntity,
	caseType: string,
): DocumentNoticeEntry {
	return documentEntry(
		"module-made-advanced",
		entity("module", module),
		detailOf({ caseType: detailName(caseType) }),
	);
}

/** Step `extension-children` (M1, a blocker holding): a link that carried a
 *  created case now goes to a menu, or to the app home where `to` is
 *  absent. */
export function formLinkGoesToMenu(
	form: NamedEntity,
	retarget: { readonly to?: string; readonly caseType: string },
): DocumentNoticeEntry {
	return documentEntry(
		"form-link-goes-to-menu",
		entity("form", form),
		detailOf({
			to: detailName(retarget.to),
			caseType: detailName(retarget.caseType),
		}),
	);
}

/** Step `explicit-preloads` (C7): a writer whose starting value now reads
 *  its case property. */
export function startingValueReadsCase(
	field: NamedEntity,
	at: { readonly form: string; readonly property: string },
): DocumentNoticeEntry {
	return documentEntry(
		"starting-value-reads-case",
		entity("field", field),
		detailOf({
			form: detailName(at.form),
			property: detailName(at.property),
		}),
	);
}

/** Step `explicit-preloads` (C7): a later field whose load-time value reads
 *  a writer the step gave a case read. */
export function loadTimeValueReadsCase(
	field: NamedEntity,
	at: { readonly form: string; readonly reads: string },
): DocumentNoticeEntry {
	return documentEntry(
		"load-time-value-reads-case",
		entity("field", field),
		detailOf({ form: detailName(at.form), reads: detailName(at.reads) }),
	);
}

/** Step `search-workflow` (part 05 M1): what a searching menu now opens on
 *  in Web Apps. */
export function menuOpensOnSearch(
	module: NamedEntity,
	opensOn: "search" | "results",
): DocumentNoticeEntry {
	return documentEntry("menu-opens-on-search", entity("module", module), {
		opensOn,
	});
}

/** Step `query-repeat-placement` (Q1). */
export function repeatRowsFollowQuery(
	field: NamedEntity,
	form: string,
): DocumentNoticeEntry {
	return documentEntry(
		"repeat-rows-follow-query",
		entity("field", field),
		detailOf({ form: detailName(form) }),
	);
}

/** Step `repeat-counts` (Q2): a count now wrapped in `int(…)`. */
export function repeatCountWholeNumber(
	field: NamedEntity,
	form: string,
): DocumentNoticeEntry {
	return documentEntry(
		"repeat-count-whole-number",
		entity("field", field),
		detailOf({ form: detailName(form) }),
	);
}

/** Step `repeat-counts` (Q3): a count read straight from a Hidden Value,
 *  whose count node leaves the wire, in a published app. */
export function repeatCountNodeRemoved(
	field: NamedEntity,
	at: { readonly form: string; readonly hidden: string },
): DocumentNoticeEntry {
	return documentEntry(
		"repeat-count-node-removed",
		entity("field", field),
		detailOf({ form: detailName(at.form), hidden: detailName(at.hidden) }),
	);
}

/** Step `field-list-flags` (Q4): a labelled group left without the flag. */
export function groupShowsOnePerScreen(
	field: NamedEntity,
	form: string,
): DocumentNoticeEntry {
	return documentEntry(
		"group-shows-one-per-screen",
		entity("field", field),
		detailOf({ form: detailName(form) }),
	);
}

/** The writer's `private-work` step ended work the assistant had not saved
 *  (the reused reason, entity the app). Only `entriesForApp` writes it. */
function unsavedAssistantWorkDiscarded(appName: string): DocumentNoticeEntry {
	return documentEntry("unsaved-assistant-work-discarded", {
		type: "app",
		nameAtMigration: noticeText(appName),
	});
}

// ─── Deployment lines (section 9) ─────────────────────────────────────────

/** Every live deployment of an app with entry points: the fold horizon's
 *  sequence step makes every link's manifest stale. */
export function deepLinksNeedRepublish(
	deployment: NoticeDeployment,
): DeploymentNoticeEntry {
	return deploymentEntry("deep-links-need-republish", deployment);
}

/** A published deployment whose baseline is unknown: its placements are
 *  held as section 8 holds them. */
export function placementsKeptUnread(
	deployment: NoticeDeployment,
): DeploymentNoticeEntry {
	return deploymentEntry("placements-kept-unread", deployment);
}

/** A published deployment where `forms` forms move a case block or an
 *  answer path at its next publish; `causes` in the order of
 *  `PATH_MOVE_CAUSES`, each once. */
export function formDataPathsMove(
	deployment: NoticeDeployment,
	move: { readonly forms: number; readonly causes: readonly PathMoveCause[] },
): DeploymentNoticeEntry {
	const causes = PATH_MOVE_CAUSES.filter((cause) =>
		move.causes.includes(cause),
	);
	return deploymentEntry(
		"form-data-paths-move",
		deployment,
		detailOf({
			forms: detailCount(move.forms),
			causes: causes.length === 0 ? undefined : causes.join(","),
		}),
	);
}

/** A published deployment whose app held an attachment-mode write it
 *  received, or may have: `properties` counts the case properties. */
export function caseAttachmentsStop(
	deployment: NoticeDeployment,
	properties: number,
): DeploymentNoticeEntry {
	return deploymentEntry("case-attachments-stop", deployment, {
		properties: detailCount(properties),
	});
}

/** What a published deployment's next publish asks that its last did not. */
export interface NextPublishAsks {
	/** Part 03 §18 class 3: `commtrackReasons(target)` is non-empty. */
	readonly commtrackOff?: boolean;
	/** Part 03 §18 class 4: an unheld same-type basic child create. */
	readonly sameTypeChildLinks?: boolean;
	/** Plan features the target needs that today's placements did not. */
	readonly planFeatures?: readonly PlanFeatureId[];
}

/**
 * `next-publish-asks-more` for one published deployment, or null where the
 * next publish asks nothing new. `detail.planFeatures` holds the features in
 * the catalog's order.
 */
export function nextPublishAsksMore(
	deployment: NoticeDeployment,
	asks: NextPublishAsks,
): DeploymentNoticeEntry | null {
	const planFeatures = PLAN_FEATURE_IDS.filter((id) =>
		(asks.planFeatures ?? []).includes(id),
	);
	const detail = detailOf({
		...(planFeatures.length > 0 && { planFeatures: planFeatures.join(",") }),
		...(asks.commtrackOff === true && { settings: "commtrack-off" }),
		...(asks.sameTypeChildLinks === true && {
			capabilities: "same-type-child-links",
		}),
	});
	if (detail === undefined) return null;
	return deploymentEntry("next-publish-asks-more", deployment, detail);
}

// ─── One app's notice ─────────────────────────────────────────────────────

/** The key two entries share where one line repeats the other. */
function lineKey(entry: MigrationNoticeEntry): string {
	if (entry.kind === "document" && entry.reason === "module-made-advanced") {
		return `module-made-advanced|${entry.entity.uuid ?? ""}`;
	}
	return canonicalJsonText(entry);
}

/**
 * One app's notice entries as the writer stores them: its deployment lines,
 * then its document lines in step order, then
 * `unsaved-assistant-work-discarded` where the writer's `private-work` step
 * discards the app's private work. A line repeated keeps its first place,
 * and a module gets one `module-made-advanced` whatever its forms carry.
 * Parsed by the row's own schema; empty where the app gets no notice row.
 * Every surface orders a notice's entries again by the reason lists when it
 * shows them.
 */
export function entriesForApp(app: {
	readonly appName: string;
	readonly deployments: readonly DeploymentNoticeEntry[];
	readonly documents: readonly DocumentNoticeEntry[];
	readonly discardsPrivateWork: boolean;
}): readonly MigrationNoticeEntry[] {
	if (
		app.documents.some(
			(entry) => entry.reason === "unsaved-assistant-work-discarded",
		)
	) {
		throw new Error(
			"A step's notice lines hold `unsaved-assistant-work-discarded`, which only the app's `discardsPrivateWork` decides. Pass the flag to `entriesForApp` and drop the line from the step.",
		);
	}
	const collected: MigrationNoticeEntry[] = [
		...app.deployments,
		...app.documents,
		...(app.discardsPrivateWork
			? [unsavedAssistantWorkDiscarded(app.appName)]
			: []),
	];
	const seen = new Set<string>();
	const entries = collected.filter((entry) => {
		const key = lineKey(entry);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	if (entries.length === 0) return [];
	return migrationNoticeEntriesSchema.parse(entries);
}
