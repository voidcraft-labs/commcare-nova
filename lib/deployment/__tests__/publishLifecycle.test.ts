/**
 * `publishAppToHq` — the one publish lifecycle.
 *
 * These cover what a publish MEANS: which edges block before anything
 * externally visible happens, whether the import updates the app the
 * project space already holds or creates one, what gets recorded when
 * CommCare HQ accepts the app, which failures are warnings rather than
 * refusals, and whose report a refusal is. The route and the MCP tool
 * both go through this, so proving it here proves both.
 *
 * The store is mocked because the transitions it persists are proved
 * against real Postgres in `store.integration.test.ts`; here the subject
 * is the ordering and the decisions, not the SQL. The fold mock applies
 * the REAL state machine so what the mocked store returns is what the
 * real one would.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	importApp,
	probeHqProjectSpaceCompatibility,
	uploadAppMediaBundle,
} from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { readHqAppSourceProfile } from "@/lib/commcare/hq/appSource";
import {
	listHqLocations,
	listHqLocationTypes,
	patchHqLocations,
} from "@/lib/commcare/hq/locations";
import {
	listHqLookupTables,
	uploadLookupTableWorkbook,
} from "@/lib/commcare/hq/lookupTables";
import { validationError } from "@/lib/commcare/validator/errors";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { proseText } from "@/lib/domain/prose";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { readOrganization } from "@/lib/organization/service";
import { projectSpaceCompatibilityForTarget } from "@/lib/publish/projectSpaceCompatibility";
import { observeDeployment } from "../observe";
import { publishAppToHq, refreshDeployment } from "../service";
import { applyAttemptOutcome } from "../stateMachine";
import {
	applyDeploymentObservation,
	foldDeploymentAttempt,
	readDeployment,
	recordPushedResources,
	recordRemoteResource,
} from "../store";
import { NO_DEPLOYMENT_PHASE_OUTCOMES } from "../types";

vi.mock("@/lib/db/settings", () => ({ getCredentialsForUpload: vi.fn() }));
vi.mock("@/lib/export/boundaryValidation", () => ({
	prepareExportBoundary: vi.fn(),
}));
vi.mock("@/lib/commcare/expander", () => ({ expandDoc: vi.fn() }));
vi.mock("@/lib/commcare/client", async (orig) => ({
	...(await orig<typeof import("@/lib/commcare/client")>()),
	importApp: vi.fn(),
	probeHqProjectSpaceCompatibility: vi.fn(),
	uploadAppMediaBundle: vi.fn(),
}));
vi.mock("@/lib/commcare/hq/appSource", () => ({
	readHqAppSourceProfile: vi.fn(),
}));
vi.mock("@/lib/commcare/multimedia/bulkUploadZip", () => ({
	buildMediaBulkUploadZip: vi.fn(() => Buffer.from("zip")),
}));
vi.mock("@/lib/media/manifest", () => ({
	assetWirePaths: (manifest: Map<string, { wirePath: string }>) => {
		const out = new Map<string, string>();
		for (const [id, asset] of manifest) out.set(id, asset.wirePath);
		return out;
	},
}));
vi.mock("@/lib/organization/service", () => ({
	readOrganization: vi.fn(),
}));
vi.mock("../observe", () => ({ observeDeployment: vi.fn() }));
/* Exactly the store surface `service.ts` imports — no more, no less. A
 * mock naming something the module never imports proves nothing, and one
 * missing a name the module DOES import fails as `undefined is not a
 * function` deep inside the code under test rather than at the mock. */
vi.mock("../store", () => ({
	applyDeploymentObservation: vi.fn(),
	foldDeploymentAttempt: vi.fn(),
	readDeployment: vi.fn(),
	recordPushedResources: vi.fn(),
	recordRemoteResource: vi.fn(),
}));
vi.mock("@/lib/commcare/hq/lookupTables", () => ({
	listHqLookupTables: vi.fn(),
	uploadLookupTableWorkbook: vi.fn(),
}));
vi.mock("@/lib/commcare/hq/locations", () => ({
	listHqLocationTypes: vi.fn(),
	listHqLocations: vi.fn(),
	patchHqLocations: vi.fn(),
}));
vi.mock("@/lib/lookup/service", () => ({
	getLookupDefinitions: vi.fn(async () => ({
		projectId: "proj-1",
		projectRevision: "1",
		definitions: [],
	})),
}));

const SCOPE = {
	appId: "app-1",
	projectId: "proj-1",
	role: "owner",
	actorUserId: "u1",
};

function record(overrides: Record<string, unknown> = {}) {
	return {
		id: "dep-1",
		appId: SCOPE.appId,
		projectId: SCOPE.projectId,
		server: "production" as const,
		domain: "acme",
		state: "preflight" as const,
		resumePhase: null,
		phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
		createdBy: "u1",
		createdAt: "2026-08-06T00:00:00.000Z",
		updatedAt: "2026-08-06T00:00:00.000Z",
		lastObservedAt: null,
		...overrides,
	};
}

function view(overrides: Record<string, unknown> = {}) {
	return { deployment: record(overrides), active: [], superseded: [] };
}

/** An active ledger mapping — the app a previous publish put on the target. */
function mapping(overrides: Record<string, unknown> = {}) {
	return {
		deploymentId: "dep-1",
		kind: "app" as const,
		novaResourceId: SCOPE.appId,
		remoteId: "hq-1",
		ownership: "nova-created" as const,
		pushedRevision: 3,
		pushedAt: "2026-08-06T00:00:00.000Z",
		remoteRevision: null,
		remoteObservedAt: null,
		supersededAt: null,
		...overrides,
	};
}

/**
 * Make the fold mock behave like the real store: apply the REAL
 * `applyAttemptOutcome` to whatever the target currently holds (or to a
 * fresh record when `ensure` is set), and return the folded view. What
 * the tests then assert about states is the state machine's own answer,
 * not a fixture's.
 *
 * It REMEMBERS what it folded, because a publish folds more than once —
 * preflight creates the record, and a later phase folds onto that same
 * row. A mock that re-read the original answer each time would raise "no
 * such record" on the second fold of a first publish, which the real
 * store never does.
 */
function installRealisticFold() {
	let current: ReturnType<typeof view> | null = null;
	vi.mocked(foldDeploymentAttempt).mockImplementation(
		async (_scope, _target, phase, outcome, options) => {
			const existing =
				current ??
				(await vi.mocked(readDeployment).getMockImplementation()?.(
					_scope,
					_target,
				));
			const base = existing ?? (options?.ensure === true ? view() : null);
			if (base === null) throw new Error("fold on a missing record");
			const next = applyAttemptOutcome(
				base.deployment as never,
				phase,
				outcome,
			);
			current = { ...base, deployment: next } as never;
			return current as never;
		},
	);
}

function validDoc() {
	const { fieldParent: _fieldParent, ...doc } = buildDoc({
		appName: "Vaccine Tracker",
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
				forms: [
					{
						name: "Reg",
						type: "registration",
						fields: [
							{
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							},
						],
					},
				],
			},
		],
	});
	return doc;
}

function publishInput(overrides: Record<string, unknown> = {}) {
	return {
		scope: SCOPE,
		doc: validDoc() as never,
		compiledAtSeq: 7,
		appName: "Vaccine Tracker",
		server: "production" as const,
		domain: "acme",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(readOrganization).mockResolvedValue({
		revision: "1",
		locations: [],
	} as never);
	vi.mocked(readDeployment).mockImplementation(async () => null);
	installRealisticFold();
	vi.mocked(recordRemoteResource).mockImplementation(
		async (_scope, _target, input) =>
			({
				deployment: record({ state: "uploaded" }),
				active: [
					{
						deploymentId: "dep-1",
						kind: "app",
						novaResourceId: SCOPE.appId,
						remoteId: input.remoteId,
						ownership: input.ownership,
						pushedRevision: input.pushedRevision,
						pushedAt: null,
						remoteRevision: null,
						remoteObservedAt: null,
						supersededAt: null,
					},
				],
				superseded: [],
			}) as never,
	);
	vi.mocked(getCredentialsForUpload).mockResolvedValue({
		ok: true,
		creds: { username: "u", apiKey: "k", server: "production" },
		domain: { name: "acme", displayName: "Acme" },
	} as never);
	vi.mocked(prepareExportBoundary).mockResolvedValue({
		ok: true,
		prepared: {
			mode: "hq-upload",
			doc: validDoc(),
			compiledAtSeq: 7,
			assets: new Map(),
			lookupTargets: { tables: [], columns: [] },
			lookupSnapshot: undefined,
			lookupContext: { kind: "unavailable" },
		},
	} as never);
	vi.mocked(probeHqProjectSpaceCompatibility).mockImplementation(
		async (_creds, domain, plan) => {
			const capabilities = plan.capabilities.map((item) => ({
				capability: item.capability,
				state: "available" as const,
			}));
			const advisories = plan.advisories.map((item) => ({
				advisory: item.advisory,
				state: "available" as const,
			}));
			return {
				capabilities,
				advisories,
				availableAdvisories: advisories.map((item) => item.advisory.id),
				report: projectSpaceCompatibilityForTarget(
					domain,
					capabilities,
					advisories,
				),
			};
		},
	);
	vi.mocked(readHqAppSourceProfile).mockResolvedValue({ profile: {} });
	vi.mocked(expandDoc).mockReturnValue({} as never);
	vi.mocked(importApp).mockResolvedValue({
		success: true,
		appId: "hq-abc",
		version: null,
		warnings: [],
	} as never);
});

describe("publishAppToHq — blocking edges", () => {
	it("refuses before any network call when CommCare HQ is not connected", async () => {
		vi.mocked(getCredentialsForUpload).mockResolvedValue({
			ok: false,
			error: "not_configured",
		} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.phase).toBe("preflight");
		expect(outcome.refusal?.failure.code).toBe("hq_not_connected");
		expect(prepareExportBoundary).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
	});

	it("refuses a key that cannot reach the requested project space", async () => {
		vi.mocked(getCredentialsForUpload).mockResolvedValue({
			ok: false,
			error: "not_authorized",
			available: [{ name: "other", displayName: "Other" }],
		} as never);

		const outcome = await publishAppToHq(publishInput());

		const check = outcome.checks.find((c) => c.id === "hq-connection");
		expect(check?.status).toBe("blocked");
		expect(check?.items).toContain("other");
		expect(outcome.refusal?.failure.code).toBe("domain_not_authorized");
		expect(importApp).not.toHaveBeenCalled();
	});

	it("blocks required project-space support before any remote write", async () => {
		const capability = {
			id: "case-search" as const,
			label: "Case search",
			description:
				"Lets workers search across cases that are not already available in the app.",
			reasons: ["The app uses Search."],
		};
		const capabilities = [{ capability, state: "missing" as const }];
		vi.mocked(probeHqProjectSpaceCompatibility).mockResolvedValueOnce({
			capabilities,
			advisories: [],
			availableAdvisories: [],
			report: projectSpaceCompatibilityForTarget("acme", capabilities, []),
		});
		const onUploadStarted = vi.fn();

		const outcome = await publishAppToHq(publishInput({ onUploadStarted }));

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.failure.code).toBe("project_space_incompatible");
		expect(outcome.projectSpaceCompatibility).toMatchObject({
			status: "blocked",
			blockers: [{ id: "case-search", state: "missing" }],
		});
		expect(onUploadStarted).not.toHaveBeenCalled();
		expect(uploadLookupTableWorkbook).not.toHaveBeenCalled();
		expect(patchHqLocations).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
	});

	it("refuses a key whose server changed under the publish", async () => {
		/* The route resolved `production` from the stored key; by the time
		 * preflight re-reads it, another tab has saved an India key. Sending
		 * anyway would import the app onto one installation while the durable
		 * record named the other. */
		vi.mocked(getCredentialsForUpload).mockResolvedValue({
			ok: true,
			creds: { username: "u", apiKey: "k", server: "india" },
			domain: { name: "acme", displayName: "Acme" },
		} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.failure.message).toMatch(/changed while/i);
		expect(importApp).not.toHaveBeenCalled();
	});

	it("refuses a validator finding and never reaches CommCare HQ", async () => {
		vi.mocked(prepareExportBoundary).mockResolvedValue({
			ok: false,
			violations: [
				validationError(
					"MEDIA_ASSET_NOT_FOUND",
					"field",
					"That image is no longer in this project's media.",
					{ fieldId: "photo" },
				),
			],
		} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.refusal?.failure.code).toBe("app_not_ready");
		const check = outcome.checks.find((c) => c.id === "app-readiness");
		expect(check?.status).toBe("blocked");
		// The finding reaches the author as the rule's own person-facing
		// copy, not the internal message the validator carries.
		expect(check?.items.join(" ")).toMatch(/media file is missing/i);
		// The refusal carries the same findings, so no caller has to dig
		// them back out of the checks.
		expect(outcome.refusal?.failure.details.join(" ")).toMatch(
			/media file is missing/i,
		);
		expect(importApp).not.toHaveBeenCalled();
	});
});

describe("publishAppToHq — what a successful publish records", () => {
	it("records the CommCare HQ app it created, with the pushed revision", async () => {
		const outcome = await publishAppToHq(publishInput());

		expect(recordRemoteResource).toHaveBeenCalledTimes(1);
		const call = vi.mocked(recordRemoteResource).mock.calls[0];
		expect(call?.[2]).toMatchObject({
			kind: "app",
			novaResourceId: "app-1",
			remoteId: "hq-abc",
			ownership: "nova-created",
			pushedRevision: 7,
			// A create response carries no version; observation fills it in.
			remoteRevision: null,
		});
		expect(outcome.deployment?.deployment.state).toBe("uploaded");
	});

	it("lands on uploaded, never on released or runnable", async () => {
		const outcome = await publishAppToHq(publishInput());
		expect(outcome.landed).toBe(true);
		expect(outcome.refusal).toBeNull();
		expect(outcome.deployment?.deployment.state).toBe("uploaded");
	});

	it("announces the upload only after every blocking edge passed", async () => {
		const onUploadStarted = vi.fn(() => {
			// Fired before the import goes out, not after.
			expect(importApp).not.toHaveBeenCalled();
		});
		await publishAppToHq(publishInput({ onUploadStarted }));
		expect(onUploadStarted).toHaveBeenCalledTimes(1);
	});

	it("never announces an upload for a refused publish", async () => {
		vi.mocked(getCredentialsForUpload).mockResolvedValue({
			ok: false,
			error: "not_configured",
		} as never);
		const onUploadStarted = vi.fn();
		await publishAppToHq(publishInput({ onUploadStarted }));
		expect(onUploadStarted).not.toHaveBeenCalled();
	});

	it("regenerates a target-aware setup artifact naming the project space", async () => {
		const outcome = await publishAppToHq(publishInput());

		expect(outcome.artifact.domain).toBe("acme");
		expect(outcome.artifact.hqAppId).toBe("hq-abc");
		const release = outcome.artifact.sections.find(
			(section) => section.id === "build-and-release",
		);
		expect(release?.url).toBe(
			"https://www.commcarehq.org/a/acme/apps/view/hq-abc/releases/",
		);
	});

	it("skips the media upload for a media-free app", async () => {
		await publishAppToHq(publishInput());
		expect(uploadAppMediaBundle).not.toHaveBeenCalled();
	});
});

describe("publishAppToHq — the app's data goes first", () => {
	const TABLE = "018f0000-0000-7000-8000-000000000001";
	const WORKBOOK = {
		bytes: Uint8Array.from([1, 2, 3]),
		tables: [{ tableId: TABLE, tag: "districts", columnCount: 2, rowCount: 4 }],
		totalWorkbookRows: 8,
	};

	function preparedWithTables() {
		vi.mocked(prepareExportBoundary).mockResolvedValue({
			ok: true,
			prepared: {
				mode: "hq-upload",
				doc: validDoc(),
				compiledAtSeq: 7,
				assets: new Map(),
				lookupTargets: { tableIds: [TABLE], columns: [] },
				lookupSnapshot: {
					projectId: "proj-1",
					projectRevision: "9",
					definitions: [
						{
							id: TABLE,
							name: "Districts",
							tag: "districts",
							definitionRevision: "2",
							columns: [],
						},
					],
					rowsByTable: new Map(),
				},
				lookupContext: { kind: "unavailable" },
				lookupWorkbook: WORKBOOK,
			},
		} as never);
	}

	beforeEach(() => {
		preparedWithTables();
		vi.mocked(listHqLookupTables).mockResolvedValue([]);
		vi.mocked(uploadLookupTableWorkbook).mockResolvedValue({
			success: true,
			message: "Table(s) uploaded.",
		} as never);
		vi.mocked(recordPushedResources).mockImplementation(
			async () => view({ state: "resources" }) as never,
		);
	});

	it("pushes the tables BEFORE the app, and records what landed", async () => {
		vi.mocked(listHqLookupTables)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ id: "hq-districts", tag: "districts" },
			] as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(true);
		/* The app's selects read these tables by name while somebody is
		 * using it, so an app that arrived first would be installable and
		 * broken. */
		expect(
			vi.mocked(uploadLookupTableWorkbook).mock.invocationCallOrder[0],
		).toBeLessThan(vi.mocked(importApp).mock.invocationCallOrder[0] ?? 0);
		expect(uploadLookupTableWorkbook).toHaveBeenCalledWith(
			expect.anything(),
			"acme",
			WORKBOOK.bytes,
			{ replace: true },
		);
		expect(recordPushedResources).toHaveBeenCalledWith(
			SCOPE,
			{ server: "production", domain: "acme" },
			[
				expect.objectContaining({
					kind: "lookup-table",
					novaResourceId: TABLE,
					remoteId: "hq-districts",
					ownership: "nova-created",
					pushedIdentity: "districts",
				}),
			],
			{
				status: "complete",
				kinds: ["lookup-table"],
				pushedAt: expect.any(String),
			},
		);
	});

	it("refuses at the data, without sending the app, when a name is taken", async () => {
		vi.mocked(listHqLookupTables).mockResolvedValue([
			{ id: "somebody-elses", tag: "districts" },
		] as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.failure.code).toBe("hq_resource_conflict");
		/* The refusal names the table twice over, because the two ways out
		 * both need it: rename it in Nova, or take that exact table over. */
		expect(outcome.refusal?.resourceConflicts).toEqual([
			{
				kind: "lookup-table",
				novaResourceId: TABLE,
				name: "Districts",
				identity: "districts",
				remoteId: "somebody-elses",
			},
		]);
		expect(uploadLookupTableWorkbook).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
	});

	it("pushes into a named table once somebody says it is theirs", async () => {
		vi.mocked(listHqLookupTables).mockResolvedValue([
			{ id: "hq-districts", tag: "districts" },
		] as never);

		const outcome = await publishAppToHq(
			publishInput({ adoptResourceIds: [TABLE] }),
		);

		expect(outcome.landed).toBe(true);
		expect(recordPushedResources).toHaveBeenCalledWith(
			SCOPE,
			expect.anything(),
			[
				expect.objectContaining({
					ownership: "adopted",
					/* Attributed to the person who said so, which the ledger
					 * requires rather than trusting each writer to remember. */
					adoptedBy: "u1",
				}),
			],
			{
				status: "complete",
				kinds: ["lookup-table"],
				pushedAt: expect.any(String),
			},
		);
	});

	it("stops rather than push when it cannot see what is already there", async () => {
		/* Reading the table list needs a paid privilege the upload does not,
		 * so this is genuinely reachable on a project space that would have
		 * accepted the push. Reading the failure as "there are none" is the
		 * one interpretation that overwrites somebody's data. */
		vi.mocked(listHqLookupTables).mockResolvedValue({
			success: false,
			status: 403,
		} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.failure.code).toBe("hq_resource_state_unknown");
		expect(outcome.refusal?.failure.message).toContain("Access APIs");
		expect(uploadLookupTableWorkbook).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
	});

	it("resumes at the data push when CommCare HQ rejected the workbook", async () => {
		vi.mocked(uploadLookupTableWorkbook).mockResolvedValue({
			success: false,
			status: 405,
			mayHaveLanded: false,
			message:
				"Please fix the following formatting issues in your Excel file: Fixture upload couldn't succeed due to the following error: Excel file has unrecognised format",
		} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.phase).toBe("resources");
		expect(outcome.refusal?.failure.code).toBe("hq_rejected_resource_push");
		expect(outcome.deployment?.deployment.resumePhase).toBe("resources");
		/* CommCare HQ's own sentence is the only thing that names what was
		 * wrong with the data. Summarizing it away would leave a person
		 * told that the upload was refused and nothing else. */
		expect(outcome.refusal?.failure.details).toEqual([
			"Please fix the following formatting issues in your Excel file: Fixture upload couldn't succeed due to the following error: Excel file has unrecognised format",
		]);
		/* A `fail` verdict is raised by `validate_fixture_file_format`
		 * before anything is written, so there is nothing over there to
		 * claim. */
		expect(recordPushedResources).not.toHaveBeenCalled();
		/* Nothing of the app itself went out, which is what makes the retry
		 * cheap: it re-pushes the data and never re-imports the app. */
		expect(importApp).not.toHaveBeenCalled();
	});

	it("keeps the tables it made when CommCare HQ took only some of them", async () => {
		/* 402 is `warning`: `_upload_fixture_api` reaches it only after
		 * `upload_fixture_file` ran, so the tables ARE on the project
		 * space. Walking away without a mapping would make the next
		 * publish read Nova's own table as a stranger's and stop to ask
		 * somebody to adopt it. */
		vi.mocked(uploadLookupTableWorkbook).mockResolvedValue({
			success: false,
			status: 402,
			mayHaveLanded: true,
			message: "Rows were not added for table districts",
		} as never);
		vi.mocked(listHqLookupTables)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ id: "hq-districts", tag: "districts" },
			] as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.failure.code).toBe("hq_rejected_resource_push");
		expect(outcome.refusal?.failure.details).toEqual([
			"Rows were not added for table districts",
		]);
		expect(recordPushedResources).toHaveBeenCalledWith(
			SCOPE,
			expect.anything(),
			[expect.objectContaining({ remoteId: "hq-districts" })],
			{ status: "partial" },
		);
		expect(importApp).not.toHaveBeenCalled();
	});

	it("keeps CommCare HQ's complaint when it then won't say what it holds", async () => {
		/* Two stories end at the same read. This one starts with a refusal,
		 * so reporting it as "CommCare HQ took your tables but wouldn't
		 * confirm them" would announce a success that did not happen and
		 * bury the only sentence naming what was wrong with the data. */
		vi.mocked(uploadLookupTableWorkbook).mockResolvedValue({
			success: false,
			status: 402,
			mayHaveLanded: true,
			message: "Rows were not added for table districts",
		} as never);
		vi.mocked(listHqLookupTables)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce({ success: false, status: 401 } as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.refusal?.failure.code).toBe("hq_rejected_resource_push");
		expect(outcome.refusal?.failure.message).not.toContain("took this app's");
		expect(outcome.refusal?.failure.details).toEqual([
			"Rows were not added for table districts",
		]);
		expect(importApp).not.toHaveBeenCalled();
	});

	it("says what a half-taken workbook did to the project space", async () => {
		/* The push replaces, so the tables CommCare HQ DID take now hold
		 * what Nova sent. "Nothing was taken" would invite somebody to
		 * believe their project space is as they left it. */
		vi.mocked(uploadLookupTableWorkbook).mockResolvedValue({
			success: false,
			status: 402,
			mayHaveLanded: true,
			message: "Rows were not added for table districts",
		} as never);
		vi.mocked(listHqLookupTables)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ id: "hq-districts", tag: "districts" },
			] as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.refusal?.failure.message).toContain("only part of");
		expect(outcome.refusal?.failure.message).not.toContain("nothing on the");
	});

	it("refuses when the tables are not there after CommCare HQ said yes", async () => {
		vi.mocked(uploadLookupTableWorkbook).mockResolvedValue({
			success: true,
			message: "Table(s) uploaded.",
		} as never);
		vi.mocked(listHqLookupTables).mockResolvedValue([]);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.failure.code).toBe("hq_rejected_resource_push");
		expect(outcome.refusal?.failure.details).toEqual(["districts"]);
		/* Nothing came back to claim, so nothing is written. The ledger
		 * never holds a mapping Nova cannot name a remote id for. */
		expect(recordPushedResources).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
	});

	it("tells a progress-reporting caller once the data is there", async () => {
		vi.mocked(listHqLookupTables)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ id: "hq-districts", tag: "districts" },
			] as never);
		const pushed = vi.fn();

		await publishAppToHq(publishInput({ onResourcesPushed: pushed }));

		expect(pushed).toHaveBeenCalledWith({ tables: 1, places: 0 });
	});

	it("says nothing about data for an app that reads none", async () => {
		/* The default prepared boundary carries no workbook. A publish must
		 * not announce a step this app does not have. */
		vi.mocked(prepareExportBoundary).mockResolvedValue({
			ok: true,
			prepared: {
				mode: "hq-upload",
				doc: validDoc(),
				compiledAtSeq: 7,
				assets: new Map(),
				lookupTargets: { tableIds: [], columns: [] },
				lookupSnapshot: undefined,
				lookupContext: { kind: "unavailable" },
			},
		} as never);
		const pushed = vi.fn();

		const outcome = await publishAppToHq(
			publishInput({ onResourcesPushed: pushed }),
		);

		expect(outcome.landed).toBe(true);
		expect(listHqLookupTables).not.toHaveBeenCalled();
		expect(uploadLookupTableWorkbook).not.toHaveBeenCalled();
		expect(pushed).not.toHaveBeenCalled();
		expect(outcome.checks.some((check) => check.id === "project-data")).toBe(
			false,
		);
	});
});

describe("publishAppToHq — the app's places go first too", () => {
	const STATE = "018f0000-0000-7000-8000-0000000000a1";
	const CITY = "018f0000-0000-7000-8000-0000000000a2";
	const COLORADO = "018f0000-0000-7000-8000-000000000001";
	const DENVER = "018f0000-0000-7000-8000-000000000002";

	function docWithLevels() {
		return {
			...validDoc(),
			organizationLevels: {
				[STATE]: {
					uuid: STATE,
					code: "state",
					name: "State",
					caseFlow: { workers: "none", ownsCases: false },
					addressBook: { reach: "own-branch" },
				},
				[CITY]: {
					uuid: CITY,
					code: "city",
					name: "City",
					parentLevelUuid: STATE,
					caseFlow: { workers: "none", ownsCases: false },
					addressBook: { reach: "own-branch" },
				},
			},
			organizationLevelOrder: [STATE, CITY],
		};
	}

	function storedPlace(over: Record<string, unknown> = {}) {
		return {
			id: COLORADO,
			levelUuid: STATE,
			parentId: null,
			siteCode: "colorado",
			name: "Colorado",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
			archivedAt: null,
			orderKey: "a0",
			...over,
		};
	}

	beforeEach(() => {
		const doc = docWithLevels();
		vi.mocked(prepareExportBoundary).mockResolvedValue({
			ok: true,
			prepared: {
				mode: "hq-upload",
				doc,
				compiledAtSeq: 7,
				assets: new Map(),
				lookupTargets: { tableIds: [], columns: [] },
				lookupSnapshot: undefined,
				lookupContext: { kind: "unavailable" },
			},
		} as never);
		vi.mocked(readOrganization).mockResolvedValue({
			revision: "4",
			locations: [
				storedPlace(),
				storedPlace({
					id: DENVER,
					levelUuid: CITY,
					parentId: COLORADO,
					siteCode: "denver",
					name: "Denver",
					orderKey: "a1",
				}),
			],
		} as never);
		vi.mocked(listHqLocationTypes).mockResolvedValue([
			{
				id: "1",
				name: "State",
				code: "state",
				parentCode: null,
				administrative: true,
				sharesCases: false,
				viewDescendants: false,
			},
			{
				id: "2",
				name: "City",
				code: "city",
				parentCode: "state",
				administrative: true,
				sharesCases: false,
				viewDescendants: false,
			},
		] as never);
		vi.mocked(listHqLocations).mockResolvedValue([]);
		vi.mocked(patchHqLocations)
			.mockResolvedValueOnce({ ids: ["hq-colorado"] } as never)
			.mockResolvedValueOnce({ ids: ["hq-denver"] } as never);
		vi.mocked(recordPushedResources).mockImplementation(
			async () => view({ state: "resources" }) as never,
		);
	});

	it("sends one batch per level, threading each parent's returned id", async () => {
		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(true);
		expect(vi.mocked(patchHqLocations).mock.calls).toHaveLength(2);
		expect(vi.mocked(patchHqLocations).mock.calls[0]?.[2]).toEqual([
			{
				name: "Colorado",
				siteCode: "colorado",
				locationTypeCode: "state",
			},
		]);
		/* The child names its parent by the id the FIRST batch answered
		 * with, which is the whole reason the push is ordered. */
		expect(vi.mocked(patchHqLocations).mock.calls[1]?.[2]).toEqual([
			{
				name: "Denver",
				siteCode: "denver",
				locationTypeCode: "city",
				parentLocationId: "hq-colorado",
			},
		]);
		expect(
			vi.mocked(patchHqLocations).mock.invocationCallOrder[0],
		).toBeLessThan(vi.mocked(importApp).mock.invocationCallOrder[0] ?? 0);
	});

	it("records both places, keyed by the site code they were pushed under", async () => {
		await publishAppToHq(publishInput());

		expect(recordPushedResources).toHaveBeenCalledWith(
			SCOPE,
			{ server: "production", domain: "acme" },
			[
				expect.objectContaining({
					kind: "location",
					novaResourceId: COLORADO,
					remoteId: "hq-colorado",
					pushedIdentity: "colorado",
					ownership: "nova-created",
				}),
				expect.objectContaining({
					kind: "location",
					novaResourceId: DENVER,
					remoteId: "hq-denver",
					pushedIdentity: "denver",
				}),
			],
			{
				status: "complete",
				kinds: ["location"],
				pushedAt: expect.any(String),
			},
		);
	});

	it("keeps what landed when a later batch is refused", async () => {
		/* `patch_list` is atomic per batch, so the first level really is on
		 * the project space. Forgetting it would make the retry create a
		 * second copy of every place in it. */
		vi.mocked(patchHqLocations)
			.mockReset()
			.mockResolvedValueOnce({ ids: ["hq-colorado"] } as never)
			.mockResolvedValueOnce({
				success: false,
				status: 400,
				message: "Location with same name and parent already exists.",
			} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.phase).toBe("resources");
		expect(outcome.refusal?.failure.code).toBe("hq_rejected_resource_push");
		/* CommCare HQ's own sentence, verbatim: it names the place and the
		 * rule, which is more specific than anything Nova could say about a
		 * refusal it did not predict. */
		expect(outcome.refusal?.failure.details).toEqual([
			"Location with same name and parent already exists.",
		]);
		expect(recordPushedResources).toHaveBeenCalledWith(
			SCOPE,
			expect.anything(),
			[expect.objectContaining({ novaResourceId: COLORADO })],
			{ status: "partial" },
		);
		expect(importApp).not.toHaveBeenCalled();
	});

	it("stops rather than push when it cannot see what is already there", async () => {
		vi.mocked(listHqLocationTypes).mockResolvedValue({
			success: false,
			status: 403,
		} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.failure.code).toBe("hq_resource_state_unknown");
		expect(outcome.refusal?.failure.message).toContain("Edit Locations");
		expect(patchHqLocations).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
	});

	it("refuses a site code the target already holds, and names it both ways", async () => {
		vi.mocked(listHqLocations).mockResolvedValue([
			{
				locationId: "somebody-elses",
				name: "CO",
				siteCode: "colorado",
				locationTypeCode: "state",
				parentLocationId: null,
				values: {},
			},
		] as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.failure.code).toBe("hq_resource_conflict");
		expect(outcome.refusal?.resourceConflicts).toEqual([
			{
				kind: "location",
				novaResourceId: COLORADO,
				name: "Colorado",
				identity: "colorado",
				remoteId: "somebody-elses",
			},
		]);
		expect(patchHqLocations).not.toHaveBeenCalled();
	});

	it("refuses a tree the target's levels cannot hold, before any batch", async () => {
		vi.mocked(listHqLocationTypes).mockResolvedValue([
			{
				id: "1",
				name: "State",
				code: "state",
				parentCode: null,
				administrative: true,
				sharesCases: false,
				viewDescendants: false,
			},
		] as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.failure.code).toBe("hq_organization_mismatch");
		expect(outcome.refusal?.failure.details).toEqual([
			expect.stringContaining("Denver (denver)"),
		]);
		expect(patchHqLocations).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
	});

	it("says nothing about places for an app with no organization", async () => {
		vi.mocked(prepareExportBoundary).mockResolvedValue({
			ok: true,
			prepared: {
				mode: "hq-upload",
				doc: validDoc(),
				compiledAtSeq: 7,
				assets: new Map(),
				lookupTargets: { tableIds: [], columns: [] },
				lookupSnapshot: undefined,
				lookupContext: { kind: "unavailable" },
			},
		} as never);
		const pushed = vi.fn();

		const outcome = await publishAppToHq(
			publishInput({ onResourcesPushed: pushed }),
		);

		expect(outcome.landed).toBe(true);
		expect(listHqLocationTypes).not.toHaveBeenCalled();
		expect(pushed).not.toHaveBeenCalled();
		expect(outcome.checks.some((check) => check.id === "organization")).toBe(
			false,
		);
	});

	it("stops claiming a place the app no longer has", async () => {
		/* Archiving the last place leaves whatever Nova pushed sitting on
		 * the project space. Nova deletes nothing there, so the only honest
		 * move is to stop claiming it and start reporting it, which is what
		 * superseding the mapping does. */
		vi.mocked(readOrganization).mockResolvedValue({
			revision: "5",
			locations: [],
		} as never);
		vi.mocked(readDeployment).mockImplementation(
			async () =>
				({
					deployment: record({ state: "released" }),
					active: [
						mapping(),
						mapping({
							kind: "location",
							novaResourceId: COLORADO,
							remoteId: "hq-colorado",
							pushedIdentity: "colorado",
						}),
					],
					superseded: [],
				}) as never,
		);

		await publishAppToHq(publishInput());

		expect(recordPushedResources).toHaveBeenCalledWith(
			SCOPE,
			expect.anything(),
			[],
			{
				status: "complete",
				kinds: ["lookup-table", "location"],
				pushedAt: expect.any(String),
			},
		);
	});
});

describe("publishAppToHq — update in place vs create", () => {
	it("creates on a first publish, sending no app id", async () => {
		const outcome = await publishAppToHq(publishInput());

		expect(vi.mocked(importApp).mock.calls[0]?.[4]).toBeUndefined();
		expect(readHqAppSourceProfile).not.toHaveBeenCalled();
		expect(outcome.landed).toBe(true);
		expect(outcome).toMatchObject({ hqAppAction: "created" });
	});

	it("updates the mapped app in place when the project space still holds it", async () => {
		vi.mocked(readDeployment).mockImplementation(
			async () =>
				({
					deployment: record({ state: "released" }),
					active: [mapping()],
					superseded: [],
				}) as never,
		);
		vi.mocked(importApp).mockResolvedValue({
			success: true,
			appId: "hq-1",
			version: 12,
			warnings: [],
		} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(readHqAppSourceProfile).toHaveBeenCalledWith(
			{ username: "u", apiKey: "k", server: "production" },
			"acme",
			"hq-1",
		);
		expect(
			vi.mocked(readHqAppSourceProfile).mock.invocationCallOrder[0],
		).toBeLessThan(vi.mocked(importApp).mock.invocationCallOrder[0] ?? 0);
		expect(vi.mocked(importApp).mock.calls[0]?.[4]).toBe("hq-1");
		// Same remote id back, plus the version the update reported — the
		// store's same-remote-id arm updates the live mapping in place.
		expect(vi.mocked(recordRemoteResource).mock.calls[0]?.[2]).toMatchObject({
			remoteId: "hq-1",
			pushedRevision: 7,
			remoteRevision: 12,
		});
		expect(outcome.landed).toBe(true);
		expect(outcome).toMatchObject({ hqAppAction: "updated" });
	});

	it("refuses an update when the current HQ app source is unavailable", async () => {
		vi.mocked(readDeployment).mockImplementation(
			async () =>
				({
					deployment: record({ state: "released" }),
					active: [mapping()],
					superseded: [],
				}) as never,
		);
		vi.mocked(readHqAppSourceProfile).mockResolvedValueOnce({
			success: false,
			status: 502,
		});

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal).toMatchObject({
			phase: "upload",
			failure: { code: "hq_app_state_unknown" },
		});
		expect(importApp).not.toHaveBeenCalled();
		expect(recordRemoteResource).not.toHaveBeenCalled();
	});

	it("records a source 404 as a missing app so the next publish can recreate it", async () => {
		vi.mocked(readDeployment).mockImplementation(
			async () =>
				({
					deployment: record({ state: "released" }),
					active: [mapping()],
					superseded: [],
				}) as never,
		);
		vi.mocked(readHqAppSourceProfile).mockResolvedValueOnce({
			success: false,
			status: 404,
		});
		vi.mocked(applyDeploymentObservation).mockResolvedValue({
			view: {
				deployment: record({ state: "incomplete", resumePhase: "upload" }),
				active: [mapping()],
				superseded: [],
			},
			applied: true,
		} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.refusal?.failure.code).toBe("remote_app_missing");
		expect(importApp).not.toHaveBeenCalled();
		expect(applyDeploymentObservation).toHaveBeenCalledWith(
			SCOPE,
			{ server: "production", domain: "acme" },
			expect.objectContaining({
				observedRemoteId: "hq-1",
				observedPushedAt: "2026-08-06T00:00:00.000Z",
				outcomes: [
					[
						"upload",
						expect.objectContaining({
							failure: expect.objectContaining({
								code: "remote_app_missing",
							}),
						}),
					],
				],
			}),
		);
	});

	it.each(["remote_app_missing", "hq_rejected_upload"])(
		"creates afresh over a persisted upload failure (%s), even beside an active mapping",
		async (code) => {
			/* A persisted upload failure next to an active mapping means an
			 * observation found the mapped app gone — attempt failures never
			 * persist on a reached target. The predicate is ANY code, not
			 * `remote_app_missing` alone: a later refused CREATE attempt
			 * overwrites the code (the second case here), and keying on it
			 * would send that state back down the update path against an app
			 * CommCare HQ already said is missing. */
			vi.mocked(readDeployment).mockImplementation(
				async () =>
					({
						deployment: record({
							state: "incomplete",
							resumePhase: "upload",
							phases: {
								...NO_DEPLOYMENT_PHASE_OUTCOMES,
								upload: {
									status: "failed",
									at: "now",
									failure: { code, message: "gone", details: [] },
								},
							},
						}),
						active: [mapping()],
						superseded: [],
					}) as never,
			);

			const outcome = await publishAppToHq(publishInput());

			expect(vi.mocked(importApp).mock.calls[0]?.[4]).toBeUndefined();
			expect(vi.mocked(recordRemoteResource).mock.calls[0]?.[2]).toMatchObject({
				remoteId: "hq-abc",
			});
			expect(outcome.landed).toBe(true);
			expect(outcome).toMatchObject({ hqAppAction: "created" });
		},
	);

	it("refuses when CommCare HQ says the app to update is gone", async () => {
		vi.mocked(readDeployment).mockImplementation(
			async () =>
				({
					deployment: record({ state: "released" }),
					active: [mapping()],
					superseded: [],
				}) as never,
		);
		vi.mocked(importApp).mockResolvedValue({
			success: false,
			status: 404,
		} as never);
		vi.mocked(applyDeploymentObservation).mockResolvedValue({
			view: {
				deployment: record({ state: "incomplete", resumePhase: "upload" }),
				active: [mapping()],
				superseded: [],
			},
			applied: true,
		} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.phase).toBe("upload");
		expect(outcome.refusal?.failure.code).toBe("remote_app_missing");
		expect(outcome.refusal?.failure.message).toMatch(/publish again/i);
		/* The 404 is an answer ABOUT THE TARGET — the mapped app is gone —
		 * so it folds as an observation of the mapping this publish read,
		 * carrying its pushed-at staleness token. Never as an attempt
		 * outcome, which deliberately writes nothing on a reached target. */
		expect(applyDeploymentObservation).toHaveBeenCalledWith(
			SCOPE,
			{ server: "production", domain: "acme" },
			expect.objectContaining({
				observedRemoteId: "hq-1",
				observedPushedAt: "2026-08-06T00:00:00.000Z",
				remoteRevision: null,
				outcomes: [
					[
						"upload",
						expect.objectContaining({
							status: "failed",
							failure: expect.objectContaining({
								code: "remote_app_missing",
							}),
						}),
					],
				],
			}),
		);
		// Only the preflight ensure-fold ran; the 404 never folds as an
		// upload attempt, and nothing lands in the resource ledger.
		expect(foldDeploymentAttempt).toHaveBeenCalledTimes(1);
		expect(recordRemoteResource).not.toHaveBeenCalled();
		expect(outcome.deployment?.deployment.state).toBe("incomplete");
	});
});

describe("publishAppToHq — failures that are not refusals of the target", () => {
	it("keeps a media transport failure a warning, with the app still recorded", async () => {
		vi.mocked(prepareExportBoundary).mockResolvedValue({
			ok: true,
			prepared: {
				mode: "hq-upload",
				doc: validDoc(),
				compiledAtSeq: 7,
				assets: new Map([
					[
						"asset-1",
						{ wirePath: "commcare/abc.png", bytes: Buffer.from("x") },
					],
				]),
				lookupTargets: { tables: [], columns: [] },
				lookupSnapshot: undefined,
				lookupContext: { kind: "unavailable" },
			},
		} as never);
		vi.mocked(uploadAppMediaBundle).mockResolvedValue({
			success: false,
			status: 500,
		} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.deployment?.deployment.state).toBe("uploaded");
		expect(outcome.warnings.join(" ")).toMatch(/media/i);
	});

	it("leaves NO record behind when a first publish never reaches the project space", async () => {
		/* Nothing is on that project space, and no code path anywhere deletes
		 * a deployment — so writing the row before preflight proved the key
		 * could reach the target would leave a typo'd slug listed in the
		 * publish dialog permanently. */
		vi.mocked(getCredentialsForUpload).mockResolvedValue({
			ok: false,
			error: "not_configured",
		} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.deployment).toBeNull();
		expect(foldDeploymentAttempt).not.toHaveBeenCalled();
		// The caller is still told what happened, and what to fix.
		expect(outcome.refusal?.failure.code).toBe("hq_not_connected");
		expect(outcome.checks.find((c) => c.id === "hq-connection")?.status).toBe(
			"blocked",
		);
	});

	it("creates the record once preflight proves the key reaches the target", async () => {
		await publishAppToHq(publishInput());

		expect(foldDeploymentAttempt).toHaveBeenCalledWith(
			SCOPE,
			{ server: "production", domain: "acme" },
			"preflight",
			expect.objectContaining({ status: "succeeded" }),
			{ ensure: true },
		);
	});

	it("does not call a blocked preflight a success just because the target is live", async () => {
		// The deployment is already released on this project space, so a
		// blocked preflight leaves the record released — it still is. The
		// ATTEMPT must not read as a success off that state.
		vi.mocked(readDeployment).mockImplementation(
			async () => view({ state: "runnable" }) as never,
		);
		vi.mocked(getCredentialsForUpload).mockResolvedValue({
			ok: false,
			error: "not_configured",
		} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.failure.code).toBe("hq_not_connected");
		// The record still describes the target, untouched by the attempt.
		expect(outcome.deployment?.deployment.state).toBe("runnable");
		expect(outcome.deployment?.deployment.phases).toEqual(
			NO_DEPLOYMENT_PHASE_OUTCOMES,
		);
		expect(importApp).not.toHaveBeenCalled();
	});

	it("refuses when CommCare HQ rejects the import, and says where to retry", async () => {
		vi.mocked(importApp).mockResolvedValue({
			success: false,
			status: 403,
		} as never);
		/* After the ensure-fold, the record exists at `preflight`; make the
		 * later reads see it so the upload failure folds against it. */
		let created = false;
		vi.mocked(readDeployment).mockImplementation(async () =>
			created ? (view() as never) : null,
		);
		vi.mocked(foldDeploymentAttempt).mockImplementation(
			async (_scope, _target, phase, outcome, options) => {
				if (options?.ensure === true) created = true;
				const next = applyAttemptOutcome(record() as never, phase, outcome);
				return { deployment: next, active: [], superseded: [] } as never;
			},
		);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.landed).toBe(false);
		expect(outcome.refusal?.phase).toBe("upload");
		expect(outcome.refusal?.failure.code).toBe("hq_rejected_upload");
		expect(outcome.deployment?.deployment.state).toBe("incomplete");
		expect(outcome.deployment?.deployment.resumePhase).toBe("upload");
		expect(recordRemoteResource).not.toHaveBeenCalled();
	});
});

/**
 * `refreshDeployment` — Check status.
 *
 * The rule these hold is one sentence: a check that could not be MADE is
 * the caller's problem, never the deployment's. Persisting it would knock
 * a live app to `incomplete` for every member of the Project because one
 * editor's key expired, and the app would still be released and in use the
 * whole time.
 */
describe("refreshDeployment", () => {
	function published(overrides: Record<string, unknown> = {}) {
		return {
			deployment: record({ state: "released", ...overrides }),
			active: [mapping()],
			superseded: [],
		};
	}

	beforeEach(() => {
		vi.mocked(readDeployment).mockImplementation(
			async () => published() as never,
		);
		vi.mocked(observeDeployment).mockResolvedValue({
			kind: "checked",
			outcomes: [["upload", { status: "succeeded", at: "now" }]],
			remoteRevision: 4,
			releasedBuildId: null,
		} as never);
		vi.mocked(applyDeploymentObservation).mockImplementation(async () => ({
			view: published() as never,
			applied: true,
		}));
	});

	it("answers null when the app has never been published to that space", async () => {
		vi.mocked(readDeployment).mockResolvedValueOnce(null);
		await expect(
			refreshDeployment(
				SCOPE,
				{ server: "production", domain: "acme" },
				validDoc() as never,
			),
		).resolves.toBeNull();
	});

	it("raises a missing CommCare HQ connection instead of recording a refusal", async () => {
		vi.mocked(getCredentialsForUpload).mockResolvedValue({
			ok: false,
			error: "not_configured",
		} as never);

		await expect(
			refreshDeployment(
				SCOPE,
				{ server: "production", domain: "acme" },
				validDoc() as never,
			),
		).rejects.toMatchObject({ code: "hq_not_connected" });
		expect(applyDeploymentObservation).not.toHaveBeenCalled();
	});

	it("raises a key that cannot reach the project space, and still writes nothing", async () => {
		vi.mocked(getCredentialsForUpload).mockResolvedValue({
			ok: false,
			error: "domain_not_authorized",
		} as never);

		await expect(
			refreshDeployment(
				SCOPE,
				{ server: "production", domain: "acme" },
				validDoc() as never,
			),
		).rejects.toMatchObject({ code: "domain_not_authorized" });
		expect(applyDeploymentObservation).not.toHaveBeenCalled();
	});

	it("raises a key on the wrong CommCare server before asking anything", async () => {
		vi.mocked(getCredentialsForUpload).mockResolvedValue({
			ok: true,
			creds: { username: "u", apiKey: "k", server: "india" },
			domain: { name: "acme", displayName: "Acme" },
		} as never);

		await expect(
			refreshDeployment(
				SCOPE,
				{ server: "production", domain: "acme" },
				validDoc() as never,
			),
		).rejects.toThrow(/separate installations/);
		expect(observeDeployment).not.toHaveBeenCalled();
	});

	it("says so plainly when the app is not on the project space at all", async () => {
		vi.mocked(readDeployment).mockResolvedValueOnce(view() as never);

		await expect(
			refreshDeployment(
				SCOPE,
				{ server: "production", domain: "acme" },
				validDoc() as never,
			),
		).rejects.toThrow(/hasn't reached/);
		expect(getCredentialsForUpload).not.toHaveBeenCalled();
	});

	it("refuses to check a publish that stopped before the app got there", async () => {
		/* This deployment holds an EARLIER publish's mapping. Observing it
		 * would fold succeeded outcomes over the refusal and turn the record
		 * green from a button next to the refusal. */
		const stalled = published();
		vi.mocked(readDeployment).mockResolvedValueOnce({
			...stalled,
			deployment: record({
				state: "incomplete",
				resumePhase: "upload",
				phases: {
					...NO_DEPLOYMENT_PHASE_OUTCOMES,
					upload: {
						status: "failed",
						at: "now",
						failure: {
							code: "hq_rejected_upload",
							message: "refused",
							details: [],
						},
					},
				},
			}),
		} as never);

		await expect(
			refreshDeployment(
				SCOPE,
				{ server: "production", domain: "acme" },
				validDoc() as never,
			),
		).rejects.toThrow(/stopped before the app reached CommCare HQ/);
		expect(applyDeploymentObservation).not.toHaveBeenCalled();
	});

	it("still checks a deployment whose app went missing, so it can heal", async () => {
		/* `remote_app_missing` was WRITTEN BY observation, about the current
		 * mapping. Asking again is exactly right — both to re-confirm, and to
		 * notice the app coming back after CommCare HQ's own undo. */
		const gone = published();
		vi.mocked(readDeployment).mockResolvedValueOnce({
			...gone,
			deployment: record({
				state: "incomplete",
				resumePhase: "upload",
				phases: {
					...NO_DEPLOYMENT_PHASE_OUTCOMES,
					upload: {
						status: "failed",
						at: "now",
						failure: {
							code: "remote_app_missing",
							message: "gone",
							details: [],
						},
					},
				},
			}),
		} as never);

		const result = await refreshDeployment(
			SCOPE,
			{ server: "production", domain: "acme" },
			validDoc() as never,
		);

		expect(result).not.toBeNull();
		expect(applyDeploymentObservation).toHaveBeenCalledWith(
			SCOPE,
			{ server: "production", domain: "acme" },
			expect.objectContaining({ observedRemoteId: "hq-1" }),
		);
	});

	it("hands the observation to the guarded write, naming the app it observed", async () => {
		await refreshDeployment(
			SCOPE,
			{ server: "production", domain: "acme" },
			validDoc() as never,
		);

		expect(applyDeploymentObservation).toHaveBeenCalledWith(
			SCOPE,
			{ server: "production", domain: "acme" },
			expect.objectContaining({
				observedRemoteId: "hq-1",
				// The staleness token: the guard discards this pass if a
				// publish re-stamps the mapping while it was in flight.
				observedPushedAt: "2026-08-06T00:00:00.000Z",
				remoteRevision: 4,
			}),
		);
	});

	it("writes nothing when CommCare HQ could not be asked", async () => {
		vi.mocked(observeDeployment).mockResolvedValue({
			kind: "unavailable",
			message: "Nova couldn't reach CommCare HQ.",
		} as never);

		await expect(
			refreshDeployment(
				SCOPE,
				{ server: "production", domain: "acme" },
				validDoc() as never,
			),
		).rejects.toThrow(/couldn't reach CommCare HQ/);
		expect(applyDeploymentObservation).not.toHaveBeenCalled();
	});
});
