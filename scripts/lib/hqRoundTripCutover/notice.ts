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
 * `no-form-ids`, `unreadable`). The settings lines read the deployment's
 * `profile.properties` as the source read gave them, beside the migrated
 * document's `appSettings`. `data-paths-move-once` is a fact of the emitter,
 * not of the document: every class with a next publish gets it. The two
 * lines that are facts of the database and the ledger rather than of the
 * document come from the plan:
 * `unsaved-assistant-work-discarded` from `discardsPrivateWork`, and
 * `ccz-needs-project-space` from whether any deployment still holds the
 * app's content once the cutover's ledger writes are made. The two drift
 * lines come from the baselines the cutover stores (`baselineNotices`) and
 * are merged with each deployment's other lines in the enum's order.
 *
 * Three lines are what the next publish itself now checks (part 03 of step
 * 2's plan): `next-publish-asks-more` names what it asks a person to confirm
 * and the capabilities it newly checks, from the document alone;
 * `commcare-version-below-floor` names a read deployment whose app HQ builds
 * below the floor, with the version the source read gave; and
 * `logo-upload-in-hq` tells each deployment of an app with a logo that the
 * logo is no longer sent.
 */

import { moduleCaseTypeForActions } from "@/lib/commcare/formLinkProjection";
import {
	type ProjectSpaceCapabilityId,
	requiredProjectSpaceCapabilities,
} from "@/lib/commcare/projectSpaceCompatibility";
import { moduleIsSearchFirst } from "@/lib/commcare/suite/case-search/inlineSearch";
import {
	searchInputIsSingleDate,
	searchInputSuppressesAutoMatch,
} from "@/lib/commcare/suite/case-search/searchPrompts";
import { compareToVersionFloor } from "@/lib/commcare/versionFloor";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import { requiredConfirmations } from "@/lib/deployment/confirmations";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import {
	asUuid,
	type BlueprintDoc,
	effectiveCaseSearchConfig,
} from "@/lib/domain";
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

/** One deployment line, content-free: its reason, the entities it names and its detail. */
export interface DeploymentNotice {
	readonly reason: DeploymentNoticeReason;
	readonly entities?: readonly NoticeEntity[];
	readonly detail?: Readonly<Record<string, string>>;
}

/** What a deployment's lines are read from. */
export interface DeploymentNoticeSource {
	readonly outcome: DeploymentOutcome;
	/** Entities of today's document whose ids change once there. */
	readonly unpaired?: readonly NoticeEntity[];
	/** Paired forms whose stored form id no read gave. */
	readonly formIdsUnknown?: readonly string[];
	/** The source read's `profile.properties`; null or absent where no source was read. */
	readonly profileProperties?: Readonly<Record<string, unknown>> | null;
	/** HQ's `build_spec.version` from the source read; null or absent where none was read. */
	readonly buildSpecVersion?: string | null;
	/**
	 * Whether a publish of this app sends places: the app's stored
	 * organization holds a place that is not archived
	 * (`lib/deployment/locationResourcePlan.ts::plannedPlacesFor`). Absent
	 * reads as none.
	 */
	readonly places?: boolean;
	/**
	 * Where the next publish there points the app's capture links: the
	 * deployment's own server and project space
	 * (`lib/deployment/attachmentTarget.ts::attachmentUrlTarget`). Absent
	 * reads as none.
	 */
	readonly attachmentTarget?: AttachmentUrlTarget;
}

/** The classes whose source the cutover read, so whose profile it knows. */
const READ: ReadonlySet<DeploymentOutcome> = new Set([
	"read-in-full",
	"no-form-ids",
]);

/**
 * The three worker preferences HQ's build forces at each update once a
 * publish seeds them (part 04 of step 2's plan, finding 40).
 */
const WORKER_SETTING_KEYS = [
	"cc-fuzzy-search-enabled",
	"cc-autoup-freq",
	"cc-enable-tts",
] as const;

/** A value HQ's build writes nothing for: absent, `null` or `""`. */
function holdsNoValue(
	properties: Readonly<Record<string, unknown>>,
	key: string,
): boolean {
	return (
		!Object.hasOwn(properties, key) ||
		properties[key] === null ||
		properties[key] === ""
	);
}

/**
 * `setting-changes-at-next-publish` for one read deployment: one line per
 * list a reader hides there today that the app's stored value shows. Android
 * shows saved forms only for `"yes"`; it shows incomplete forms only for
 * `"yes"`, and the Web Apps client shows its tile unless the value is
 * `"no"`. Step `app-settings` never stores a value that hides a list a reader
 * shows, so every line is a list workers there gain, and none turns one off.
 */
function settingChanges(
	properties: Readonly<Record<string, unknown>>,
	target: BlueprintDoc,
): DeploymentNotice[] {
	const notices: DeploymentNotice[] = [];
	if (
		target.appSettings.showSavedForms &&
		properties["cc-show-saved"] !== "yes"
	) {
		notices.push({
			reason: "setting-changes-at-next-publish",
			detail: { setting: "saved", readers: "android" },
		});
	}
	const incomplete = properties["cc-show-incomplete"];
	if (target.appSettings.showIncompleteForms && incomplete !== "yes") {
		notices.push({
			reason: "setting-changes-at-next-publish",
			detail: {
				setting: "incomplete",
				readers: incomplete === "no" ? "android-and-webapps" : "android",
			},
		});
	}
	return notices;
}

/**
 * The capabilities the flag probe checks from step 2 that it did not check
 * before: each is new, so any app that needs one is newly asked.
 */
const NEW_CAPABILITIES: ReadonlySet<ProjectSpaceCapabilityId> = new Set([
	"multi-select-case-lists",
	"related-case-search",
	"case-tiles",
]);

/**
 * Whether some module's search needs HQ's advanced case search for a reason
 * the probe did not check before step 2: a search-first menu, a one-date
 * Search field or a Search field Nova matches by its own filter. A starting
 * value and a hidden value were checked already. Each is read only where the
 * module's search lands, as the probe reads it.
 */
function asksAdvancedSearchForNewReason(doc: BlueprintDoc): boolean {
	return Object.values(doc.modules).some((module) => {
		if (effectiveCaseSearchConfig(module) === undefined) return false;
		if (moduleCaseTypeForActions(doc, module.uuid) === "") return false;
		const inputs = module.caseListConfig?.searchInputs ?? [];
		return (
			moduleIsSearchFirst(module) ||
			inputs.some(searchInputIsSingleDate) ||
			inputs.some(searchInputSuppressesAutoMatch)
		);
	});
}

/**
 * `next-publish-asks-more`, from the document alone: what the next publish
 * asks a person to confirm about the project space, and the capabilities its
 * flag probe now checks for this app. No deployment holds a confirmation
 * before its first publish from step 2, so everything the app needs is
 * asked. `detail.planFeatures` holds the plan feature ids, `detail.settings`
 * `flat-location-fixture` and `connect-forwarder`, and `detail.capabilities`
 * the capability ids, each comma-joined in the order every surface lists
 * them and left out where empty. Null where the publish asks nothing new.
 */
export function nextPublishAsksMore(
	target: BlueprintDoc,
	places: boolean,
	attachmentTarget: AttachmentUrlTarget | null,
): DeploymentNotice | null {
	const needed = requiredConfirmations(
		target,
		{
			lookupTables: extractLookupReferenceTargets(target).tableIds.length > 0,
			places,
		},
		attachmentTarget,
	);
	const planFeatures = needed
		.filter((need) => need.kind === "plan-feature")
		.map((need) => need.subject);
	const settings = needed
		.filter((need) => need.kind !== "plan-feature")
		.map((need) => need.subject);
	const newReason = asksAdvancedSearchForNewReason(target);
	const capabilities = requiredProjectSpaceCapabilities(target)
		.map((use) => use.id)
		.filter(
			(id) => NEW_CAPABILITIES.has(id) || (id === "case-search" && newReason),
		);
	const detail: Record<string, string> = {
		...(planFeatures.length > 0 && { planFeatures: planFeatures.join(",") }),
		...(settings.length > 0 && { settings: settings.join(",") }),
		...(capabilities.length > 0 && { capabilities: capabilities.join(",") }),
	};
	return Object.keys(detail).length === 0
		? null
		: { reason: "next-publish-asks-more", detail };
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
	const notices: DeploymentNotice[] = [];
	if (outcome === "unreadable") {
		notices.push({ reason: "ids-change-once-unreadable" });
		notices.push({ reason: "settings-unknown-unreadable" });
	}
	const unpaired = source.unpaired ?? [];
	if (unpaired.length > 0) {
		notices.push({
			reason: "menu-id-changes-once",
			entities: unpaired.map(({ kind, uuid }) => ({ kind, uuid })),
		});
	}
	const formIdsUnknown = source.formIdsUnknown ?? [];
	if (outcome === "no-form-ids" && formIdsUnknown.length > 0) {
		notices.push({
			reason: "form-ids-change-once",
			entities: formIdsUnknown.map((uuid) => ({ kind: "form", uuid })),
		});
	}
	// Every form's generated nodes take their new names at the next publish
	// there, so every such deployment is told once, naming no form.
	notices.push({ reason: "data-paths-move-once" });
	if (entryPointInventory(target).length > 0) {
		notices.push({ reason: "deep-links-need-republish" });
	}
	const asksMore = nextPublishAsksMore(
		target,
		source.places ?? false,
		source.attachmentTarget ?? null,
	);
	if (asksMore !== null) notices.push(asksMore);
	const version = source.buildSpecVersion ?? null;
	if (version !== null && compareToVersionFloor(version) === "below") {
		notices.push({
			reason: "commcare-version-below-floor",
			detail: { version: noticeText(version) },
		});
	}
	if (target.logo !== undefined) {
		notices.push({ reason: "logo-upload-in-hq" });
	}
	if (READ.has(outcome)) {
		const properties = source.profileProperties ?? {};
		notices.push(...settingChanges(properties, target));
		if (WORKER_SETTING_KEYS.some((key) => holdsNoValue(properties, key))) {
			notices.push({ reason: "worker-settings-reset-at-next-publish" });
		}
	}
	return mergeDeploymentNotices(notices, []);
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

/**
 * `lookup-table-content-unsupported`: one line per mapped table whose
 * definition holds what the next publish would remove, for a class whose
 * next publish reaches the lookup push. That publish stops before it sends
 * anything until the table gets a new export tag (part 02 of step 2's plan,
 * defect 5).
 */
export function tableContentNotices(
	outcome: DeploymentOutcome,
	lines: readonly DeploymentNotice[],
): DeploymentNotice[] {
	return PUBLISHABLE.has(outcome) ? [...lines] : [];
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
				...(notice.detail !== undefined && { detail: notice.detail }),
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
