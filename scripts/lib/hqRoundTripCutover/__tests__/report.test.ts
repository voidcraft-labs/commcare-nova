/**
 * The report's lines: one object a line, each naming the report, its mode
 * and its section, the fleet line first and the outcome last, with counts,
 * ids and codes alone.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import type { DeploymentNoticeReason } from "@/lib/notices/migrationNotice";
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
	debugDetails,
	deploymentLines,
	fleetLine,
	generatedPathForms,
	outcomeLine,
	planInputs,
	planSections,
} from "../report";
import {
	migratedFixtureDocument,
	readFixtureCarriers,
	readFixtureProject,
} from "./fixtures/preStep";

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
		places: [],
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

	it("splits step hidden-inert-default's removals by what each field writes", () => {
		const detail = (
			appId: string,
			inertDefaults: CutoverPlanBuild["apps"][number]["inertDefaults"],
		) => ({
			appId,
			deleted: false,
			stepChanges: [
				{
					stepId: "hidden-inert-default",
					changes: inertDefaults["saves-blank"],
				},
			],
			behaviorEntries: {},
			inertDefaults,
			deploymentsWithoutMapping: 0,
		});
		const split = new CutoverReport("scan");
		planSections(
			split,
			source,
			{
				...build,
				apps: [
					detail("app-1", { "not-writing": 2, preloaded: 1, "saves-blank": 1 }),
					detail("app-2", { "not-writing": 0, preloaded: 0, "saves-blank": 2 }),
				],
			},
			NO_HOLDERS,
		);
		const steps = split.all().find((line) => line.section === "steps")
			?.steps as { step: string }[];
		expect(steps.find((step) => step.step === "hidden-inert-default")).toEqual({
			step: "hidden-inert-default",
			apps: 2,
			changes: 3,
			removed: { notWriting: 2, preloaded: 1, savesBlank: 3 },
		});
	});

	it("prints no settings line, since the scan reads no source to count", () => {
		expect(lines.some((line) => line.section === "settings")).toBe(false);
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

describe("the settings line of a run that read HQ", () => {
	const plannedDeployment = (
		deploymentId: string,
		reasons: readonly DeploymentNoticeReason[],
	) => ({
		deploymentId,
		server: "production",
		domain: "field-ops",
		remoteAppId: `hq-${deploymentId}`,
		outcome: "read-in-full" as const,
		buildSpecVersion: "2.53.0",
		pairing: null,
		identities: [],
		unpaired: [],
		formIdsUnknown: [],
		keyUses: [],
		notices: reasons.map((reason) => ({ reason })),
	});
	const migrated = migratedFixtureDocument("navigation-base");
	const target = (
		showSavedForms: boolean,
		showIncompleteForms: boolean,
	): { raw: typeof RAW; doc: BlueprintDoc | undefined } => ({
		raw: RAW,
		doc: { ...migrated, appSettings: { showSavedForms, showIncompleteForms } },
	});
	const build = {
		plan: {
			format: "hq-round-trip-emission-1",
			apps: [
				appPlan("app-1", {
					deployments: [
						plannedDeployment("d-1", [
							"setting-changes-at-next-publish",
							"setting-changes-at-next-publish",
							"worker-settings-reset-at-next-publish",
						]),
						plannedDeployment("d-2", ["worker-settings-reset-at-next-publish"]),
					],
				}),
				appPlan("app-2", { deployments: [plannedDeployment("d-3", [])] }),
				appPlan("app-3"),
				appPlan("app-4"),
			],
			lookupTagRenames: [],
			projectBlockers: [],
			digest: "d".repeat(64),
		},
		targets: new Map([
			["app-1", target(true, true)],
			["app-2", target(false, true)],
			["app-3", target(true, false)],
			["app-4", { raw: RAW, doc: undefined }],
		]),
		apps: [],
		deployments: [],
		lookupContexts: new Map(),
	} as unknown as CutoverPlanBuild;
	const source: FleetSource = {
		apps: [app("app-1"), app("app-2"), app("app-3"), app("app-4")],
		projects: new Map(),
		privateWork: {
			openWorkspaces: 0,
			openChangeSets: 0,
			activeCandidates: 0,
			endingSessions: [],
		},
	};

	it("counts the apps that hide a form list and the deployments each publish-time setting line names, once a deployment", () => {
		const report = new CutoverReport("dry-run");
		planSections(report, source, build, NO_HOLDERS);
		expect(
			report.all().find((line) => line.section === "settings"),
		).toMatchObject({
			appsHidingAFormList: 2,
			deploymentsWhoseSettingChanges: 1,
			deploymentsWhoseWorkerSettingsReset: 2,
		});
	});
});

/** A corpus fixture's Project lookup tables, as the plan's context holds them. */
function fixtureLookupContext(id: string): LookupValidationContext {
	const lookup = readFixtureProject(id).lookup as
		| {
				definitions: Extract<
					LookupValidationContext,
					{ kind: "available" }
				>["definitions"];
		  }
		| undefined;
	return lookup === undefined
		? { kind: "unavailable" }
		: {
				kind: "available",
				projectId: "fixture-project",
				projectRevision: 1 as never,
				definitions: lookup.definitions,
			};
}

/**
 * Three forms: one whose protected validation message the one allocator
 * names anew, because an authored sibling holds the message's base and an
 * earlier constraint count of `message_x` its first suffix; one whose only
 * generated node is a write-free close's Save to Case block; and one with a
 * counted repeat, whose count node keeps its name and its path.
 */
function generatedNamesDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Generated paths",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Check",
						type: "followup",
						fields: [
							f({ kind: "text", id: "other" }),
							f({ kind: "text", id: "nova_constraint_message_x" }),
							f({
								kind: "text",
								id: "message_x",
								validate:
									"count(#form/other[. = 'yes']) > 0 and count(#form/other[. = 'no']) = 0",
							}),
							f({
								kind: "text",
								id: "x",
								validate: ". != ''",
								// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${` is what makes a message protected
								validate_msg: proseText("Write ${1}"),
							}),
						],
					},
					{
						name: "Discharge",
						type: "followup",
						fields: [f({ kind: "text", id: "reason" })],
					},
					{
						name: "Rounds",
						type: "followup",
						fields: [
							f({
								kind: "repeat",
								id: "rounds",
								repeat_mode: "count_bound",
								repeat_count: "2",
								children: [f({ kind: "text", id: "note" })],
							}),
						],
					},
				],
			},
		],
	});
	const discharge = doc.formOrder[doc.moduleOrder[0]][1];
	doc.forms[discharge].caseOperations = [
		{
			uuid: testUuid("discharge-operation"),
			id: "discharge",
			action: "close",
			caseType: "patient",
			target: { kind: "session" },
		},
	];
	return doc;
}

describe("the forms whose generated data paths move", () => {
	it("are each fixture's forms that hold a case operation or a trimmed name, and no form whose only generated nodes are counts and messages", () => {
		const moving = (id: string) =>
			generatedPathForms(
				migratedFixtureDocument(id),
				fixtureLookupContext(id),
			).moving.map((form) => form.name);
		// A root create keyed by an answer, now inside its one-row repeat.
		expect(moving("case-operation-key")).toEqual(["Edit"]);
		expect(moving("case-operation-query")).toEqual(["Edit"]);
		// A conditional update in a query repeat's row, now inside its group.
		expect(moving("case-choice-attendance")).toEqual(["Attendance"]);
		// A counted repeat's count node, and three message nodes, keep their paths.
		expect(moving("container-live-count-entry")).toEqual([]);
		expect(moving("xml-unicode")).toEqual([]);
		// A create's name question and its external id question, each with a
		// new trimmed sibling.
		expect(moving("navigation-base")).toEqual(["Register"]);
		for (const id of [
			"case-operation-key",
			"container-live-count-entry",
			"xml-unicode",
		]) {
			expect(
				generatedPathForms(
					migratedFixtureDocument(id),
					fixtureLookupContext(id),
				).countOrMessageNameMoves,
			).toEqual([]);
		}
	});

	it("count a form by its renamed nodes or by a block it holds, and apart from them a form whose message is named anew", () => {
		const doc = generatedNamesDoc();
		const [check, discharge, rounds] = doc.formOrder[doc.moduleOrder[0]];
		const forms = generatedPathForms(doc, { kind: "unavailable" });
		expect(forms.moving.map((form) => form.formUuid)).toEqual([
			check,
			discharge,
		]);
		expect(forms.countOrMessageNameMoves).toEqual([
			{ formUuid: check, name: "Check" },
		]);
		expect(forms.moving.map((form) => form.formUuid)).not.toContain(rounds);
	});

	it("are counted per app in the generated-paths line, which names no form and lists each app no publish would emit", () => {
		const doc = generatedNamesDoc();
		const keyed = migratedFixtureDocument("case-operation-key");
		const plain = migratedFixtureDocument("xml-unicode");
		const build = {
			plan: {
				format: "hq-round-trip-emission-1",
				apps: [
					appPlan("app-names"),
					appPlan("app-keyed"),
					appPlan("app-plain"),
					appPlan("app-unparsed", {
						blockers: [{ code: "target-parse", count: 1, findingCodes: [] }],
					}),
					appPlan("app-refused", {
						blockers: [
							{ code: "target-gate", count: 1, findingCodes: ["INVALID_REF"] },
						],
					}),
					appPlan("app-unready", {
						blockers: [
							{
								code: "target-export-readiness",
								count: 1,
								findingCodes: ["MEDIA_ASSET_NOT_FOUND"],
							},
						],
					}),
				],
				lookupTagRenames: [],
				projectBlockers: [],
				digest: "d".repeat(64),
			},
			targets: new Map([
				["app-names", { raw: RAW, doc }],
				["app-keyed", { raw: RAW, doc: keyed }],
				["app-plain", { raw: RAW, doc: plain }],
				["app-unparsed", { raw: RAW, doc: undefined }],
				["app-refused", { raw: RAW, doc: plain }],
				["app-unready", { raw: RAW, doc: keyed }],
			]),
			apps: [],
			deployments: [],
			lookupContexts: new Map(),
		} as unknown as CutoverPlanBuild;
		const source: FleetSource = {
			apps: [],
			projects: new Map(),
			privateWork: {
				openWorkspaces: 0,
				openChangeSets: 0,
				activeCandidates: 0,
				endingSessions: [],
			},
		};
		const report = new CutoverReport("scan");
		planSections(report, source, build, NO_HOLDERS);
		const sections = report.all().map((line) => line.section);
		expect(sections.indexOf("generated-paths")).toBe(
			sections.indexOf("behavior") + 1,
		);
		expect(
			report.all().find((line) => line.section === "generated-paths"),
		).toEqual({
			report: "hq-round-trip-emission",
			mode: "scan",
			section: "generated-paths",
			apps: [
				{
					appId: "app-names",
					formsMoving: 2,
					formsWhoseCountOrMessageNameMoves: 1,
				},
				{
					appId: "app-keyed",
					formsMoving: 1,
					formsWhoseCountOrMessageNameMoves: 0,
				},
			],
			notCounted: ["app-unparsed", "app-refused", "app-unready"],
		});
		expect(report.text()).not.toContain("Check");

		const [check, discharge] = doc.formOrder[doc.moduleOrder[0]];
		expect(
			debugDetails(build, "app-names", {
				parse: [],
				gate: [],
				exportReadiness: [],
				caseSchemas: [],
				content: [],
			}),
		).toEqual([
			`App app-names: ${RAW.appName}`,
			"  no blocker",
			`  generated-paths-move ${check}: Check`,
			`  generated-paths-move ${discharge}: Discharge`,
			`  generated-count-or-message-name-moves ${check}: Check`,
		]);
	});
});

describe("the Connect blocks a plan renames", () => {
	const connectDeployment = (deploymentId: string) => ({
		deploymentId,
		server: "production" as const,
		domain: "field-ops",
		remoteAppId: "hq-app",
		outcome: "unreadable" as const,
		buildSpecVersion: null,
		pairing: null,
		identities: [],
		unpaired: [],
		formIdsUnknown: [],
		keyUses: [],
		notices: [],
	});
	const renamed = (block: string) => ({
		reason: "connect-block-renamed" as const,
		entity: {
			type: "form" as const,
			uuid: testUuid("connect-form"),
			nameAtMigration: "Visit form",
		},
		detail: { block, from: "task", to: "q_task" },
	});
	const build = {
		plan: {
			format: "hq-round-trip-emission-1",
			apps: [
				appPlan("app-deliver", {
					changes: [renamed("deliver_unit"), renamed("task")],
					deployments: [connectDeployment("d-deliver")],
				}),
				appPlan("app-assessment", {
					changes: [renamed("assessment")],
					deployments: [connectDeployment("d-assessment")],
				}),
				appPlan("app-kept", { deployments: [connectDeployment("d-kept")] }),
			],
			lookupTagRenames: [],
			projectBlockers: [],
			digest: "d".repeat(64),
		},
		targets: new Map(),
		apps: [],
		deployments: [],
		lookupContexts: new Map(),
	} as unknown as CutoverPlanBuild;
	const source: FleetSource = {
		apps: [],
		projects: new Map(),
		privateWork: {
			openWorkspaces: 0,
			openChangeSets: 0,
			activeCandidates: 0,
			endingSessions: [],
		},
	};

	it("lists each deployment whose deliver unit, learn module or task the plan renames, by id and kind, and none whose ids it keeps", () => {
		const report = new CutoverReport("scan");
		planSections(report, source, build, NO_HOLDERS);
		expect(
			report.all().find((line) => line.section === "connect-renames"),
		).toEqual({
			report: "hq-round-trip-emission",
			mode: "scan",
			section: "connect-renames",
			deployments: [
				{
					appId: "app-deliver",
					deploymentId: "d-deliver",
					blocks: ["deliver_unit", "task"],
				},
			],
		});
		expect(report.text()).not.toContain("q_task");
		expect(report.text()).not.toContain("Visit form");
	});

	it("prints each place a content blocker met, and each line the notice holds, under --debug-details alone", () => {
		expect(
			debugDetails(build, "app-deliver", {
				parse: [],
				gate: [],
				exportReadiness: [],
				caseSchemas: [],
				content: [
					{
						code: "form-root-read",
						where: "fields.f.calculate",
						message: '"count(/data)" reads the form\'s root alone.',
					},
				],
			}),
		).toEqual([
			"App app-deliver: (unread)",
			'  form-root-read fields.f.calculate: "count(/data)" reads the form\'s root alone.',
			`  connect-block-renamed form ${testUuid("connect-form")}: Visit form block="deliver_unit" from="task" to="q_task"`,
			`  connect-block-renamed form ${testUuid("connect-form")}: Visit form block="task" from="task" to="q_task"`,
		]);
	});
});
