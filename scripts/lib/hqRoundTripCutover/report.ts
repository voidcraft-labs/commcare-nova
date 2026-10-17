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

import { sql, type Transaction } from "kysely";
import { COMMCARE_VERSION_FLOOR } from "@/lib/commcare/versionFloor";
import type { AppDatabase } from "@/lib/db/pg";
import type { DeploymentNoticeReason } from "@/lib/notices/migrationNotice";
import type { HolderCensus } from "./holders";
import type { MatchResult } from "./matching";
import type { CutoverBlockerCode, CutoverPlanBuild, FleetSource } from "./plan";
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
 * by entity id and name with the finding's own sentence. Authored content,
 * for the operator's terminal only; nothing of it enters the plan, the
 * digest or the report.
 */
export function debugDetails(
	build: CutoverPlanBuild,
	appId: string,
	findings: {
		readonly parse: readonly { path: string; message: string }[];
		readonly gate: readonly ValidationFindingDetail[];
		readonly exportReadiness: readonly ValidationFindingDetail[];
		readonly caseSchemas: readonly string[];
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
	if (lines.length === 1) lines.push("  no blocker");
	return lines;
}

/** One validator finding as `--debug-details` prints it. */
export interface ValidationFindingDetail {
	readonly code: string;
	/** The entity ids and names the finding's location names. */
	readonly where: string;
	readonly message: string;
}
