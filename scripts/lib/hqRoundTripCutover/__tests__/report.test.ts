/**
 * The report's lines: one object a line, each naming the report, its mode
 * and its section, the fleet line first and the outcome last, with counts,
 * ids and codes alone.
 */

import { describe, expect, it } from "vitest";
import type { HolderCensus } from "../holders";
import { readRawDocument } from "../oldShape";
import type {
	AppPlan,
	CutoverPlanBuild,
	DeploymentPlanDetail,
	FleetSource,
	SourceApp,
} from "../plan";
import {
	CutoverReport,
	deploymentLines,
	fleetLine,
	outcomeLine,
	planInputs,
	planSections,
} from "../report";
import { readFixtureCarriers } from "./fixtures/preStep";

const RAW = readRawDocument(
	"navigation-base",
	readFixtureCarriers("navigation-base"),
);

function app(appId: string, patch: Partial<SourceApp> = {}): SourceApp {
	return {
		appId,
		projectId: "project-1",
		baseSeq: 3,
		deleted: false,
		raw: RAW,
		discardsPrivateWork: false,
		activeSchemas: new Map(),
		deployments: [],
		deploymentsWithoutMapping: 0,
		...patch,
	};
}

function appPlan(appId: string, patch: Partial<AppPlan> = {}): AppPlan {
	return {
		appId,
		projectId: "project-1",
		baseSeq: 3,
		baseDigest: "a".repeat(64),
		targetDigest: "a".repeat(64),
		blockers: [],
		changes: [],
		discardsPrivateWork: false,
		deployments: [],
		...patch,
	};
}

function deployment(
	deploymentId: string,
	domain: string,
	patch: Partial<DeploymentPlanDetail> = {},
): DeploymentPlanDetail {
	return {
		deploymentId,
		appId: "app-1",
		projectId: "project-1",
		server: "production",
		domain,
		noCredential: false,
		publishedDocument: { kind: "stored" },
		mappedTableIds: [],
		match: null,
		...patch,
	};
}

const NO_HOLDERS: HolderCensus = {
	liveApps: [],
	liveSessions: [],
	settleableApps: [],
	settleableSessions: [],
	unsettledApps: [],
	unsettledSessions: [],
};

describe("the report", () => {
	const source: FleetSource = {
		apps: [
			app("app-1", { deploymentsWithoutMapping: 1 }),
			app("app-2", { deleted: true }),
		],
		projects: new Map(),
		privateWork: {
			openWorkspaces: 1,
			openChangeSets: 0,
			activeCandidates: 1,
			endingSessions: ["session-1"],
		},
	};
	// Two Projects publish to the busy space: the first maps two tables, one
	// of them from two deployments; the second maps one of the same ids.
	const busySpace = Array.from({ length: 24 }, (_, index) =>
		deployment(
			`busy-${index}`,
			"busy-space",
			index === 0
				? { mappedTableIds: ["table-a", "table-b"] }
				: index === 1
					? { mappedTableIds: ["table-a"] }
					: index === 2
						? { projectId: "project-2", mappedTableIds: ["table-a"] }
						: {},
		),
	);
	const build: CutoverPlanBuild = {
		plan: {
			format: "hq-round-trip-emission-1",
			apps: [
				appPlan("app-1", {
					discardsPrivateWork: true,
					blockers: [
						{
							code: "target-gate",
							count: 2,
							findingCodes: ["INVALID_REF"],
						},
					],
				}),
				appPlan("app-2", {
					blockers: [
						{ code: "target-gate", count: 1, findingCodes: ["DUPLICATE_ID"] },
						{ code: "case-schema-change", count: 1, findingCodes: [] },
					],
				}),
			],
			lookupTagRenames: [],
			projectBlockers: [],
			digest: "d".repeat(64),
		},
		targets: new Map(),
		apps: [],
		deployments: [
			deployment("quiet-1", "quiet-space", {
				noCredential: true,
				publishedDocument: { kind: "none", reason: "fold-refused" },
			}),
			deployment("quiet-2", "quiet-space", { publishedDocument: null }),
			...busySpace,
		],
		lookupContexts: new Map(),
	};

	const report = new CutoverReport("scan");
	fleetLine(report, source, 1024, planInputs(build));
	planSections(report, source, build, NO_HOLDERS);
	outcomeLine(report, { outcome: "stopped", stoppedBy: ["blocker"] });
	const lines = report.all();

	it("prints the fleet line first and the outcome last, each line carrying the report, the mode and a section", () => {
		expect(lines[0]).toMatchObject({
			section: "fleet",
			apps: 2,
			appsDeleted: 1,
		});
		expect(lines.at(-1)).toMatchObject({
			section: "outcome",
			outcome: "stopped",
		});
		for (const line of lines) {
			expect(line).toMatchObject({
				report: "hq-round-trip-emission",
				mode: "scan",
			});
			expect(typeof line.section).toBe("string");
		}
		expect(
			report
				.text()
				.split("\n")
				.map((text) => JSON.parse(text)),
		).toEqual(lines);
	});

	it("names each blocker code with its count and its apps", () => {
		expect(lines.filter((line) => line.section === "blocker")).toEqual([
			expect.objectContaining({
				code: "case-schema-change",
				count: 1,
				apps: ["app-2"],
				findingCodes: [],
			}),
			expect.objectContaining({
				code: "target-gate",
				count: 3,
				apps: ["app-1", "app-2"],
				findingCodes: ["DUPLICATE_ID", "INVALID_REF"],
			}),
		]);
	});

	it("counts deployments without a mapping, without a credential and without a published document", () => {
		expect(lines.find((line) => line.section === "deployments")).toMatchObject({
			perServer: { production: 26 },
			noAppMapping: 1,
			noCredential: ["quiet-1"],
			appMappingsWithoutPushedRevision: 1,
			publishedDocumentStored: 24,
			withoutPublishedDocument: [
				{ deploymentId: "quiet-1", reason: "fold-refused" },
			],
		});
		expect(lines.find((line) => line.section === "private-work")).toMatchObject(
			{
				openWorkspaces: 1,
				apps: ["app-1"],
				endingSessions: ["session-1"],
			},
		);
	});

	it("counts each space's limited reads, the table list, rows and places once per Project, and names a space whose window would pass the hour's or the day's floor", () => {
		const spaces = lines.filter((line) => line.section === "space");
		expect(spaces).toEqual([
			expect.objectContaining({
				domain: "busy-space",
				deployments: 24,
				limitedReads: 31,
				windowExceedsHour: true,
				windowExceedsDay: true,
			}),
			expect.objectContaining({
				domain: "quiet-space",
				deployments: 2,
				limitedReads: 4,
				windowExceedsHour: false,
				windowExceedsDay: false,
			}),
		]);
	});
});

describe("the deployment lines of a run that read HQ", () => {
	const evidence = {
		path: "evidence" as const,
		pairs: {
			menus: new Map([[0, "00000000-0000-4000-8000-0000000000a1"]]),
			forms: [],
		},
		unpaired: [],
		pairsPerStage: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
		ties: 1,
		contests: 1,
		hqUnpaired: [{ menu: 0, form: 0 }],
		differences: { menus: 0, forms: 0, names: 1, caseTypes: 0, paths: 0 },
	};
	const build = {
		plan: {
			format: "hq-round-trip-emission-1",
			apps: [
				{
					appId: "app-1",
					projectId: "project-1",
					baseSeq: 3,
					baseDigest: "a".repeat(64),
					targetDigest: "a".repeat(64),
					blockers: [],
					changes: [],
					discardsPrivateWork: false,
					deployments: [
						{
							deploymentId: "d-1",
							server: "production",
							domain: "field-ops",
							remoteAppId: "hq-app",
							outcome: "read-in-full" as const,
							buildSpecVersion: "2.53.0",
							pairing: {
								path: "evidence" as const,
								reason: "hq-differs" as const,
							},
							identities: [],
							unpaired: [
								{
									kind: "form" as const,
									uuid: "00000000-0000-4000-8000-0000000000b1",
									cause: { kind: "tie" as const, stage: 2 },
								},
								{
									kind: "form" as const,
									uuid: "00000000-0000-4000-8000-0000000000b2",
									cause: { kind: "contest" as const },
								},
							],
							formIdsUnknown: [],
							keyUses: [
								{
									userId: "member-a",
									firstUsedAt: "2026-10-15T10:00:00.000Z",
									lastUsedAt: "2026-10-15T10:00:07.000Z",
								},
							],
							notices: [],
						},
					],
				},
			],
			lookupTagRenames: [],
			projectBlockers: [],
			digest: "d".repeat(64),
		},
		targets: new Map(),
		apps: [],
		deployments: [deployment("d-1", "field-ops", { match: evidence })],
		lookupContexts: new Map(),
	} as unknown as CutoverPlanBuild;

	it("prints the pairing, each entity left unpaired by uuid and cause, the counts per stage and the version floor", () => {
		const report = new CutoverReport("dry-run");
		deploymentLines(report, build);
		const [line, use] = report.all();
		expect(line).toMatchObject({
			section: "deployment",
			deploymentId: "d-1",
			outcome: "read-in-full",
			buildSpecVersion: "2.53.0",
			belowVersionFloor: true,
			pairing: { path: "evidence", reason: "hq-differs" },
			unpaired: [
				{
					kind: "form",
					uuid: "00000000-0000-4000-8000-0000000000b1",
					cause: "tie-at-stage-2",
				},
				{
					kind: "form",
					uuid: "00000000-0000-4000-8000-0000000000b2",
					cause: "contest",
				},
			],
			menusPaired: 1,
			formsPaired: 0,
			pairsPerStage: { 1: 1 },
			ties: 1,
			contests: 1,
			hqUnpaired: [{ menu: 0, form: 0 }],
			differences: { names: 1 },
		});
		expect(use).toMatchObject({
			section: "key-use",
			userId: "member-a",
			server: "production",
			domain: "field-ops",
		});
	});
});
