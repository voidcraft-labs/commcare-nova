/**
 * The cutover's report: content-free by construction.
 *
 * Both scripts print it as JSON Lines, one object per line on stdout, each
 * carrying `report: "hq-round-trip-emission"`, its `mode` and its `section`:
 * a `fleet` line first, then one line per other section, one per blocker
 * code, one per deployment and key use where the run read HQ, one per
 * project space, and an `outcome` line last. In the Job each line is one
 * Cloud Logging entry, so no entry grows with the fleet. A line holds stable
 * ids, codes and counts, never an authored name, a path, a tag or a source:
 * those are the detail `--debug-details` prints for one app, on the
 * operator's terminal only.
 */

import { isTag, type Element as XmlElement } from "domhandler";
import { sql, type Transaction } from "kysely";
import { expandDoc } from "@/lib/commcare/expander";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { COMMCARE_VERSION_FLOOR } from "@/lib/commcare/versionFloor";
import { derivedUniqueId } from "@/lib/commcare/wireIdentity";
import {
	type GeneratedNodePlan,
	planGeneratedNodes,
} from "@/lib/commcare/xform/generatedNodes";
import { parseXml } from "@/lib/commcare/xmlParse";
import type { AppDatabase } from "@/lib/db/pg";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	formConnectIds,
	isContainer,
	type Uuid,
} from "@/lib/domain";
import type { DeploymentNoticeReason } from "@/lib/notices/migrationNotice";
import type { HolderCensus } from "./holders";
import type { MatchResult } from "./matching";
import type {
	ContentBlockerPlace,
	CutoverBlockerCode,
	CutoverPlanBuild,
	FleetSource,
} from "./plan";
import { suffixedWireCodeLanguages } from "./steps/languageWireCodes";
import { CUTOVER_STEPS } from "./transform";
import type { WriterReport } from "./writer";

export const REPORT = "hq-round-trip-emission";

export type ReportMode =
	| "scan"
	| "dry-run"
	| "rehearse"
	| "execute"
	| "settle-holders"
	| "prove-decrypt";

export type ReportOutcome =
	| { readonly outcome: "ok" }
	| { readonly outcome: "already-applied" }
	| { readonly outcome: "no-key" }
	| { readonly outcome: "failed" }
	| {
			readonly outcome: "stopped";
			readonly stoppedBy: readonly (
				| "blocker"
				| "holder"
				| "transient"
				| "digest"
			)[];
	  };

export type ReportLine = Readonly<Record<string, unknown>> & {
	readonly report: typeof REPORT;
	readonly mode: ReportMode;
	readonly section: string;
};

/** A project space's limited reads; above these at the floor the runbook plans its pacing. */
const HOUR_FLOOR = 30;
const DAY_FLOOR = 50;

/** The report's lines for one run, in the order the report prints them. */
export class CutoverReport {
	private readonly lines: ReportLine[] = [];

	constructor(readonly mode: ReportMode) {}

	line(section: string, fields: Readonly<Record<string, unknown>>): void {
		this.lines.push({ report: REPORT, mode: this.mode, section, ...fields });
	}

	all(): readonly ReportLine[] {
		return this.lines;
	}

	/** Each line as one JSON object, as stdout carries it. */
	text(): string {
		return this.lines.map((line) => JSON.stringify(line)).join("\n");
	}
}

/** The `fleet` line. */
export function fleetLine(
	report: CutoverReport,
	source: FleetSource,
	databaseBytes: number,
	extra: Readonly<Record<string, unknown>> = {},
): void {
	report.line("fleet", {
		apps: source.apps.length,
		appsDeleted: source.apps.filter((app) => app.deleted).length,
		appsWithDeployment: source.apps.filter(
			(app) => app.deployments.length + app.deploymentsWithoutMapping > 0,
		).length,
		databaseBytes,
		...extra,
	});
}

/** The plan's digest with its inputs as counts, for the dry run, rehearsal and execute run. */
export function planInputs(build: CutoverPlanBuild): Record<string, unknown> {
	const outcomes: Record<string, number> = {};
	let identities = 0;
	for (const app of build.plan.apps) {
		for (const deployment of app.deployments) {
			outcomes[deployment.outcome] = (outcomes[deployment.outcome] ?? 0) + 1;
			identities += deployment.identities.length;
		}
	}
	return {
		planDigest: build.plan.digest,
		inputs: {
			apps: build.plan.apps.length,
			deploymentsByClass: outcomes,
			identityRows: identities,
			tagRenames: build.plan.lookupTagRenames.length,
			blockers:
				build.plan.apps.reduce((sum, app) => sum + app.blockers.length, 0) +
				build.plan.projectBlockers.length,
		},
	};
}

/** The sections every mode that builds a plan prints. */
export function planSections(
	report: CutoverReport,
	source: FleetSource,
	build: CutoverPlanBuild,
	holders: HolderCensus,
	spaceReads: readonly SpaceReads[] = [],
): void {
	report.line("steps", {
		steps: CUTOVER_STEPS.map((step) => {
			const counts = build.apps.map(
				(app) =>
					app.stepChanges.find((entry) => entry.stepId === step.id)?.changes ??
					0,
			);
			return {
				step: step.id,
				apps: counts.filter((count) => count > 0).length,
				changes: counts.reduce((sum, count) => sum + count, 0),
			};
		}),
	});
	// Step `language-wire-codes`: the apps with a stored localization root,
	// and each language whose stored code is a suffixed one. Tags, never text.
	const rooted = source.apps.filter((app) => app.raw.localization !== null);
	report.line("language-wire-codes", {
		rootedApps: rooted.length,
		suffixed: rooted.flatMap((app) => {
			const target = build.targets.get(app.appId);
			const languages =
				target === undefined ? [] : suffixedWireCodeLanguages(target.raw);
			return languages.length === 0 ? [] : [{ appId: app.appId, languages }];
		}),
	});
	const behavior = new Map<string, { apps: number; entries: number }>();
	for (const app of build.apps) {
		for (const [reason, entries] of Object.entries(app.behaviorEntries)) {
			const total = behavior.get(reason) ?? { apps: 0, entries: 0 };
			behavior.set(reason, {
				apps: total.apps + 1,
				entries: total.entries + entries,
			});
		}
	}
	report.line("behavior", {
		reasons: [...behavior].map(([reason, counts]) => ({ reason, ...counts })),
	});
	generatedPathsLine(report, build);
	report.line("holders", {
		live: holders.liveApps.length + holders.liveSessions.length,
		liveApps: holders.liveApps,
		liveSessions: holders.liveSessions,
		lapsedOrPaused:
			holders.settleableApps.length + holders.settleableSessions.length,
		lapsedOrPausedApps: holders.settleableApps,
		lapsedOrPausedSessions: holders.settleableSessions,
		unsettledHolds:
			holders.unsettledApps.length + holders.unsettledSessions.length,
		unsettledApps: holders.unsettledApps,
		unsettledSessions: holders.unsettledSessions,
	});
	report.line("private-work", {
		openWorkspaces: source.privateWork.openWorkspaces,
		openChangeSets: source.privateWork.openChangeSets,
		activeCandidates: source.privateWork.activeCandidates,
		apps: build.plan.apps
			.filter((app) => app.discardsPrivateWork)
			.map((app) => app.appId),
		endingSessions: source.privateWork.endingSessions,
	});
	deploymentsLine(report, source, build, spaceReads);
	connectRenamesLine(report, build);
	if (report.mode !== "scan") settingsLine(report, build);
	const blockers = new Map<
		CutoverBlockerCode,
		{ count: number; apps: string[] }
	>();
	for (const app of build.plan.apps) {
		for (const blocker of app.blockers) {
			const total = blockers.get(blocker.code) ?? { count: 0, apps: [] };
			total.count += blocker.count;
			total.apps.push(app.appId);
			blockers.set(blocker.code, total);
		}
	}
	for (const [code, total] of [...blockers].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		report.line("blocker", {
			code,
			count: total.count,
			apps: total.apps,
			findingCodes: [
				...new Set(
					build.plan.apps.flatMap((app) =>
						app.blockers
							.filter((blocker) => blocker.code === code)
							.flatMap((blocker) => blocker.findingCodes),
					),
				),
			].sort(),
		});
	}
	for (const blocker of build.plan.projectBlockers) {
		report.line("blocker", {
			code: blocker.code,
			projectId: blocker.projectId,
			tableId: blocker.tableId,
			apps: blocker.referencingAppIds,
		});
	}
}

/**
 * The forms of one app whose generated data paths move at the next publish
 * to a project space (`data-paths-move-once`), each by uuid and name. The
 * name is authored content: the report prints the counts, and only
 * `--debug-details` prints the forms.
 */
export interface GeneratedPathForms {
	/**
	 * Forms whose generated-node plan holds a renamed node (every node the
	 * pre-step emitter named `__nova_`), a new node, or a Save to Case block,
	 * which now sits inside a group or a keyed repeat.
	 */
	readonly moving: readonly GeneratedPathForm[];
	/**
	 * Forms where the plan gives a `nova_count_` or `nova_constraint_message_`
	 * node another name than the pre-step emitter gave it.
	 */
	readonly countOrMessageNameMoves: readonly GeneratedPathForm[];
}

export interface GeneratedPathForm {
	readonly formUuid: string;
	readonly name: string;
}

/** The two purposes whose names the pre-step emitter wrote without `__nova_`. */
const KEPT_PURPOSES: ReadonlySet<string> = new Set([
	"count",
	"constraint-message",
]);

/**
 * The forms of one migrated document whose generated data paths move. The
 * plan names every question- and operation-owned node; the document's HQ
 * emission says which forms hold a Save to Case block, since a block's
 * container (`nova_operations`, `nova_subcases`, `nova_selected_cases`) is
 * written only where a block stands in it. Every such block stood in a
 * `__nova_` container before.
 */
export function generatedPathForms(
	doc: BlueprintDoc,
	lookupContext: LookupValidationContext,
): GeneratedPathForms {
	const app = expandDoc(doc, {
		...(lookupContext.kind === "available" && {
			lookupNaming: lookupWireNaming(lookupContext.definitions),
		}),
	});
	const moving: GeneratedPathForm[] = [];
	const countOrMessageNameMoves: GeneratedPathForm[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			const connectIds = formConnectIds(doc, formUuid);
			const plan = planGeneratedNodes(doc, formUuid);
			const entry = { formUuid, name: form.name };
			const xform = app._attachments[`${derivedUniqueId(formUuid)}.xml`];
			if (
				plan.nodes.some((node) => !KEPT_PURPOSES.has(node.purpose)) ||
				(typeof xform === "string" && holdsSaveToCaseBlock(xform))
			)
				moving.push(entry);
			if (countOrMessageNameMoved(doc, formUuid, plan, connectIds))
				countOrMessageNameMoves.push(entry);
		}
	}
	return { moving, countOrMessageNameMoves };
}

/** Whether a form source's primary instance holds a Save to Case block. */
function holdsSaveToCaseBlock(xform: string): boolean {
	const children = (element: { children: unknown[] }): XmlElement[] =>
		element.children.filter((child): child is XmlElement =>
			isTag(child as never),
		);
	const named = (element: XmlElement, name: string) =>
		element.name === name || element.name.endsWith(`:${name}`);
	const find = (
		elements: readonly XmlElement[],
		name: string,
	): XmlElement | undefined => {
		for (const element of elements) {
			if (named(element, name)) return element;
			const found = find(children(element), name);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	const model = find(children(parseXml(xform)), "model");
	const instance =
		model === undefined
			? undefined
			: children(model).find((element) => named(element, "instance"));
	const holds = (element: XmlElement): boolean =>
		element.attribs["vellum:role"] === "SaveToCase" ||
		children(element).some(holds);
	return instance !== undefined && children(instance).some(holds);
}

/**
 * Whether the plan names a `nova_count_` or `nova_constraint_message_` node
 * other than the pre-step emitter did. That emitter named each family by
 * itself: a message took the first free `nova_constraint_message_<id>[_<n>]`
 * among its siblings' ids, the root's Connect ids and the messages before it
 * in that scope; a count took the first free `nova_count_<id>[_<n>]` among its
 * siblings' ids and the nodes written before it in that scope. The plan's
 * one allocator takes every name allocated before it too.
 */
function countOrMessageNameMoved(
	doc: BlueprintDoc,
	formUuid: Uuid,
	plan: GeneratedNodePlan,
	connectIds: ReadonlySet<string>,
): boolean {
	const planned = new Map<string, string>();
	for (const node of plan.nodes) {
		if (KEPT_PURPOSES.has(node.purpose))
			planned.set(`${node.purpose}\u0000${node.owner}`, node.name);
	}
	if (planned.size === 0) return false;
	const allocate = (taken: Set<string>, base: string): string => {
		let name = base;
		for (let n = 1; taken.has(name); n++) name = `${base}_${n}`;
		taken.add(name);
		return name;
	};
	const moved = (parentUuid: Uuid, root: boolean): boolean => {
		const children = orderedFieldUuids(doc, parentUuid).flatMap((uuid) => {
			const field = doc.fields[uuid];
			return field === undefined ? [] : [field];
		});
		const authored = children.map((field) => field.id);
		const messages = new Set([...authored, ...(root ? connectIds : [])]);
		const written = new Set(authored);
		for (const field of children) {
			const message = planned.get(`constraint-message\u0000${field.uuid}`);
			if (message !== undefined) {
				const today = allocate(messages, `nova_constraint_message_${field.id}`);
				written.add(today);
				if (today !== message) return true;
			}
			const count = planned.get(`count\u0000${field.uuid}`);
			if (
				count !== undefined &&
				allocate(written, `nova_count_${field.id}`) !== count
			)
				return true;
		}
		return children.some(
			(field) => isContainer(field) && moved(field.uuid, false),
		);
	};
	return moved(formUuid, true);
}

/**
 * The `generated-paths` line: per app, the count of forms whose generated
 * data paths move and of forms whose count or message node is named anew.
 * Neither is a blocker. An app whose target does not parse, that the gate
 * refuses or that is not ready to export is emitted by no publish, so it is
 * listed as not counted.
 */
function generatedPathsLine(
	report: CutoverReport,
	build: CutoverPlanBuild,
): void {
	const apps: {
		appId: string;
		formsMoving: number;
		formsWhoseCountOrMessageNameMoves: number;
	}[] = [];
	const notCounted: string[] = [];
	for (const app of build.plan.apps) {
		const doc = build.targets.get(app.appId)?.doc;
		if (
			doc === undefined ||
			app.blockers.some(
				(blocker) =>
					blocker.code === "target-parse" ||
					blocker.code === "target-gate" ||
					blocker.code === "target-export-readiness",
			)
		) {
			notCounted.push(app.appId);
			continue;
		}
		const forms = generatedPathForms(
			doc,
			build.lookupContexts.get(app.projectId) ?? { kind: "unavailable" },
		);
		if (forms.moving.length + forms.countOrMessageNameMoves.length > 0) {
			apps.push({
				appId: app.appId,
				formsMoving: forms.moving.length,
				formsWhoseCountOrMessageNameMoves: forms.countOrMessageNameMoves.length,
			});
		}
	}
	report.line("generated-paths", { apps, notCounted });
}

/**
 * The `settings` line, for a run that read HQ: the apps whose stored
 * `appSettings` hides a form list, the deployments whose built value of
 * either list changes at their next publish, and the deployments whose
 * workers' own sync, update and speech preferences that publish resets. The
 * scan reads no source, so it has nothing to count here and prints no line.
 */
function settingsLine(report: CutoverReport, build: CutoverPlanBuild): void {
	const deployments = build.plan.apps.flatMap((app) => app.deployments);
	const holding = (reason: DeploymentNoticeReason) =>
		deployments.filter((deployment) =>
			deployment.notices.some((notice) => notice.reason === reason),
		).length;
	report.line("settings", {
		appsHidingAFormList: build.plan.apps.filter((app) => {
			const settings = build.targets.get(app.appId)?.doc?.appSettings;
			return (
				settings !== undefined &&
				(!settings.showSavedForms || !settings.showIncompleteForms)
			);
		}).length,
		deploymentsWhoseSettingChanges: holding("setting-changes-at-next-publish"),
		deploymentsWhoseWorkerSettingsReset: holding(
			"worker-settings-reset-at-next-publish",
		),
	});
}

/** The Connect blocks a renamed id makes Connect read as new ones. */
const CONNECT_KEYED_BLOCKS: ReadonlySet<string> = new Set([
	"deliver_unit",
	"learn_module",
	"task",
]);

/**
 * The `connect-renames` line: each deployment of an app whose deliver unit,
 * learn module or task step `connect-ids` renames, with the kinds renamed.
 * Connect reads a renamed block as a new one, and a delivery it turns away
 * before an opportunity manager pays for the new deliver unit is never sent
 * again, so the operator tells each app's members before the window (runbook
 * step 1(d)). Ids and kinds alone, never an authored id.
 */
function connectRenamesLine(
	report: CutoverReport,
	build: CutoverPlanBuild,
): void {
	const deployments = build.plan.apps.flatMap((app) => {
		const blocks = [
			...new Set(
				app.changes.flatMap((change) =>
					change.reason === "connect-block-renamed" &&
					CONNECT_KEYED_BLOCKS.has(change.detail?.block ?? "")
						? [change.detail?.block as string]
						: [],
				),
			),
		].sort();
		if (blocks.length === 0) return [];
		return app.deployments.map((deployment) => ({
			appId: app.appId,
			deploymentId: deployment.deploymentId,
			blocks,
		}));
	});
	report.line("connect-renames", { deployments });
}

/** What one run sent to a project space, from its pacer. */
export interface SpaceReads {
	readonly server: string;
	readonly domain: string;
	readonly limitedReads: number;
	readonly lastLimitedReadAt: string | null;
}

/** The `deployments` line and one `space` line per server and project space. */
function deploymentsLine(
	report: CutoverReport,
	source: FleetSource,
	build: CutoverPlanBuild,
	spaceReads: readonly SpaceReads[],
): void {
	const perServer: Record<string, number> = {};
	const spaces = new Map<
		string,
		{
			server: string;
			domain: string;
			deployments: number;
			/** Each Project's mapped HQ table ids in this space. */
			projects: Map<string, Set<string>>;
		}
	>();
	for (const deployment of build.deployments) {
		perServer[deployment.server] = (perServer[deployment.server] ?? 0) + 1;
		const key = JSON.stringify([deployment.server, deployment.domain]);
		const space = spaces.get(key) ?? {
			server: deployment.server,
			domain: deployment.domain,
			deployments: 0,
			projects: new Map<string, Set<string>>(),
		};
		space.deployments += 1;
		const tables =
			space.projects.get(deployment.projectId) ?? new Set<string>();
		for (const tableId of deployment.mappedTableIds) tables.add(tableId);
		space.projects.set(deployment.projectId, tables);
		spaces.set(key, space);
	}
	const published = build.deployments.flatMap((deployment) =>
		deployment.publishedDocument === null ? [] : [deployment.publishedDocument],
	);
	const perOutcome: Record<string, number> = {};
	const perPairing: Record<string, number> = {};
	for (const app of build.plan.apps) {
		for (const deployment of app.deployments) {
			perOutcome[deployment.outcome] =
				(perOutcome[deployment.outcome] ?? 0) + 1;
			const pairing =
				deployment.pairing === null
					? "none"
					: deployment.pairing.path === "published-document"
						? `published-document:${deployment.pairing.source}`
						: `evidence:${deployment.pairing.reason}`;
			perPairing[pairing] = (perPairing[pairing] ?? 0) + 1;
		}
	}
	report.line("deployments", {
		perServer,
		perOutcome,
		perPairing,
		noAppMapping: source.apps.reduce(
			(sum, app) => sum + app.deploymentsWithoutMapping,
			0,
		),
		noCredential: build.deployments
			.filter((deployment) => deployment.noCredential)
			.map((deployment) => deployment.deploymentId),
		appMappingsWithoutPushedRevision: build.deployments.filter(
			(deployment) => deployment.publishedDocument === null,
		).length,
		publishedDocumentStored: published.filter(
			(entry) => entry.kind === "stored",
		).length,
		publishedDocumentFolded: published.filter(
			(entry) => entry.kind === "folded",
		).length,
		withoutPublishedDocument: build.deployments.flatMap((deployment) =>
			deployment.publishedDocument?.kind === "none"
				? [
						{
							deploymentId: deployment.deploymentId,
							reason: deployment.publishedDocument.reason,
						},
					]
				: [],
		),
	});
	for (const space of [...spaces.values()].sort((a, b) =>
		a.server === b.server
			? a.domain < b.domain
				? -1
				: 1
			: a.server < b.server
				? -1
				: 1,
	)) {
		// One form id read per deployment and, for each Project published
		// there, its table list, one rows read per mapped table and its place
		// inventory.
		const limitedReads =
			space.deployments +
			[...space.projects.values()].reduce(
				(sum, tables) => sum + 1 + tables.size + 1,
				0,
			);
		const sent = spaceReads.find(
			(entry) => entry.server === space.server && entry.domain === space.domain,
		);
		report.line("space", {
			server: space.server,
			domain: space.domain,
			deployments: space.deployments,
			limitedReads,
			...(sent !== undefined && {
				limitedReadsSent: sent.limitedReads,
				lastLimitedReadAt: sent.lastLimitedReadAt,
			}),
			windowExceedsHour: 2 * limitedReads > HOUR_FLOOR,
			windowExceedsDay: 2 * limitedReads > DAY_FLOOR,
		});
	}
}

/** One line per deployment, for a run that classed deployments. */
export function deploymentLines(
	report: CutoverReport,
	build: CutoverPlanBuild,
): void {
	for (const app of build.plan.apps) {
		for (const deployment of app.deployments) {
			const detail = build.deployments.find(
				(entry) => entry.deploymentId === deployment.deploymentId,
			);
			report.line("deployment", {
				appId: app.appId,
				deploymentId: deployment.deploymentId,
				server: deployment.server,
				domain: deployment.domain,
				outcome: deployment.outcome,
				buildSpecVersion: deployment.buildSpecVersion,
				belowVersionFloor:
					deployment.buildSpecVersion === null
						? null
						: belowFloor(deployment.buildSpecVersion),
				pairing: deployment.pairing,
				identityRows: deployment.identities.length,
				unpaired: deployment.unpaired.map(({ kind, uuid, cause }) => ({
					kind,
					uuid,
					cause:
						cause.kind === "tie" ? `tie-at-stage-${cause.stage}` : cause.kind,
				})),
				formIdsUnknown: deployment.formIdsUnknown,
				...matchCounts(detail?.match ?? null),
			});
			for (const use of deployment.keyUses) {
				report.line("key-use", {
					userId: use.userId,
					server: deployment.server,
					domain: deployment.domain,
					firstUsedAt: use.firstUsedAt,
					lastUsedAt: use.lastUsedAt,
				});
			}
		}
	}
}

/** Whether HQ's version for the app is below CommCare's version floor. */
function belowFloor(version: string): boolean {
	const [major = 0, minor = 0] = version
		.split(".")
		.map((part) => Number.parseInt(part, 10));
	return (
		major < COMMCARE_VERSION_FLOOR.major ||
		(major === COMMCARE_VERSION_FLOOR.major &&
			minor < COMMCARE_VERSION_FLOOR.minor)
	);
}

/** A deployment's pairs as counts and positions: no name, no path. */
function matchCounts(match: MatchResult | null): Record<string, unknown> {
	if (match === null) return {};
	const counts = {
		menusPaired: match.pairs.menus.size,
		formsPaired: match.pairs.forms.length,
	};
	if (match.path === "published-document") {
		return {
			...counts,
			addedSince: match.addedSince,
			goneSince: match.goneSince,
		};
	}
	return {
		...counts,
		pairsPerStage: match.pairsPerStage,
		ties: match.ties,
		contests: match.contests,
		hqUnpaired: match.hqUnpaired,
		...(match.differences !== undefined && { differences: match.differences }),
	};
}

/** The writer's timings and the database's growth, for the fleet line. */
export function writerFields(writer: WriterReport): Record<string, unknown> {
	return {
		stepMilliseconds: writer.durations,
		databaseBytesAtStep11: writer.databaseBytes,
		walBytes: writer.walBytes,
		appsWritten: writer.appsWritten,
		identitiesWritten: writer.identitiesWritten,
		deploymentsMarkedMissing: writer.deploymentsMarkedMissing,
		noticesWritten: writer.noticesWritten,
		keyReadersWritten: writer.keyReadersWritten,
		eventsArchived: writer.eventsArchived,
		sessionsEnded: writer.sessionsEnded,
	};
}

export function outcomeLine(
	report: CutoverReport,
	outcome: ReportOutcome,
): void {
	report.line("outcome", { ...outcome });
}

/**
 * `--recipients`: the address list of the window's announcement, or of one
 * app's Project members. Printed on the operator's terminal only and never
 * archived with the evidence.
 */
export async function readRecipients(
	tx: Transaction<AppDatabase>,
	appId?: string,
): Promise<string[]> {
	if (appId === undefined) {
		const rows = await sql<{ email: string }>`
			SELECT email FROM auth_user ORDER BY email
		`.execute(tx);
		return rows.rows.map((row) => row.email);
	}
	const app = await tx
		.selectFrom("apps")
		.select("project_id")
		.where("id", "=", appId)
		.executeTakeFirst();
	if (app === undefined) {
		throw new Error(
			`App ${appId} was not found, so it has no members to list.`,
		);
	}
	const rows = await sql<{ email: string }>`
		SELECT DISTINCT person.email FROM auth_member AS member
		JOIN auth_user AS person ON person.id = member."userId"
		WHERE member."organizationId" = ${app.project_id}
		ORDER BY person.email
	`.execute(tx);
	return rows.rows.map((row) => row.email);
}

/**
 * `--debug-details --app <id>`: for one app, every place each blocker met,
 * by entity id and name with the finding's own sentence, then each entity
 * the app's notice names (each question a step renames, for one), then each
 * form whose generated data paths move, so the people who own HQ form exports and
 * reports built on the old paths can be told which forms to re-point.
 * Authored content, for the operator's terminal only; nothing of it enters
 * the plan, the digest or the report.
 */
export function debugDetails(
	build: CutoverPlanBuild,
	appId: string,
	findings: {
		readonly parse: readonly { path: string; message: string }[];
		readonly gate: readonly ValidationFindingDetail[];
		readonly exportReadiness: readonly ValidationFindingDetail[];
		readonly caseSchemas: readonly string[];
		readonly content: readonly ContentBlockerPlace[];
	},
): string[] {
	const target = build.targets.get(appId);
	const lines = [`App ${appId}: ${target?.raw.appName ?? "(unread)"}`];
	for (const issue of findings.parse) {
		lines.push(`  target-parse ${issue.path}: ${issue.message}`);
	}
	for (const finding of findings.gate) {
		lines.push(
			`  target-gate ${finding.code} ${finding.where}: ${finding.message}`,
		);
	}
	for (const finding of findings.exportReadiness) {
		lines.push(
			`  target-export-readiness ${finding.code} ${finding.where}: ${finding.message}`,
		);
	}
	for (const caseType of findings.caseSchemas) {
		lines.push(`  case-schema-change ${caseType}`);
	}
	for (const place of findings.content) {
		lines.push(`  ${place.code} ${place.where}: ${place.message}`);
	}
	if (lines.length === 1) lines.push("  no blocker");
	const plan = build.plan.apps.find((app) => app.appId === appId);
	for (const change of plan?.changes ?? []) {
		const detail = Object.entries(change.detail ?? {})
			.map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
			.join("");
		lines.push(
			`  ${change.reason} ${change.entity.type} ${change.entity.uuid ?? ""}: ${change.entity.nameAtMigration}${detail}`,
		);
	}
	if (
		target?.doc !== undefined &&
		plan !== undefined &&
		findings.parse.length === 0 &&
		findings.gate.length === 0 &&
		findings.exportReadiness.length === 0
	) {
		const forms = generatedPathForms(
			target.doc,
			build.lookupContexts.get(plan.projectId) ?? { kind: "unavailable" },
		);
		for (const form of forms.moving) {
			lines.push(`  generated-paths-move ${form.formUuid}: ${form.name}`);
		}
		for (const form of forms.countOrMessageNameMoves) {
			lines.push(
				`  generated-count-or-message-name-moves ${form.formUuid}: ${form.name}`,
			);
		}
	}
	return lines;
}

/** One validator finding as `--debug-details` prints it. */
export interface ValidationFindingDetail {
	readonly code: string;
	/** The entity ids and names the finding's location names. */
	readonly where: string;
	readonly message: string;
}
