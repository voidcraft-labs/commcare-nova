/**
 * `publishAppToHq` — the one publish lifecycle.
 *
 * These cover what a publish MEANS: which edges block before anything
 * externally visible happens, what gets recorded when CommCare HQ accepts
 * the app, and which failures are warnings rather than refusals. The
 * route and the MCP tool both go through this, so proving it here proves
 * both.
 *
 * The store is mocked because the transitions it persists are proved
 * against real Postgres in `store.integration.test.ts`; here the subject
 * is the ordering and the decisions, not the SQL.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { importApp, uploadAppMediaBundle } from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { validationError } from "@/lib/commcare/validator/errors";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { proseText } from "@/lib/domain/prose";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { publishAppToHq } from "../service";
import {
	ensureDeployment,
	recordRemoteResource,
	saveDeploymentProgress,
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
	probeHqFeatureFlags: vi.fn(async () => []),
	uploadAppMediaBundle: vi.fn(),
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
	readOrganizationAuthoringSnapshot: vi.fn(async () => ({
		blueprint: {},
		blueprintSeq: 1,
		organization: { revision: "1", locations: [] },
	})),
}));
vi.mock("../store", () => ({
	ensureDeployment: vi.fn(),
	saveDeploymentProgress: vi.fn(),
	recordRemoteResource: vi.fn(),
	recordRemoteRevision: vi.fn(),
	readDeployment: vi.fn(),
	readDeploymentsForApp: vi.fn(async () => []),
	assertRemoteAppUnclaimed: vi.fn(),
	activeRemoteApp: (view: { active: { remoteId: string }[] }) =>
		view.active[0] ?? null,
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

function publishInput() {
	return {
		scope: SCOPE,
		doc: validDoc() as never,
		compiledAtSeq: 7,
		appName: "Vaccine Tracker",
		server: "production" as const,
		domain: "acme",
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(ensureDeployment).mockResolvedValue(view() as never);
	vi.mocked(saveDeploymentProgress).mockImplementation(
		async (_scope, _id, next) =>
			({
				deployment: record({
					state: next.state,
					resumePhase: next.resumePhase,
					phases: next.phases,
				}),
				active: [],
				superseded: [],
			}) as never,
	);
	vi.mocked(recordRemoteResource).mockImplementation(
		async (_scope, _id, input) =>
			({
				deployment: record({ state: input.progress.state }),
				active: [
					{
						deploymentId: "dep-1",
						kind: "app",
						novaResourceId: SCOPE.appId,
						remoteId: input.remoteId,
						ownership: input.ownership,
						adoptedAt: null,
						adoptedBy: null,
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
	vi.mocked(expandDoc).mockReturnValue({} as never);
	vi.mocked(importApp).mockResolvedValue({
		success: true,
		appId: "hq-abc",
		appUrl: "https://www.commcarehq.org/a/acme/apps/view/hq-abc/",
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

		expect(outcome.deployment.deployment.state).toBe("incomplete");
		expect(outcome.deployment.deployment.resumePhase).toBe("preflight");
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

		expect(outcome.deployment.deployment.state).toBe("incomplete");
		const check = outcome.checks.find((c) => c.id === "app-readiness");
		expect(check?.status).toBe("blocked");
		// The finding reaches the author as the rule's own person-facing
		// copy, not the internal message the validator carries.
		expect(check?.items.join(" ")).toMatch(/media file is missing/i);
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
		});
		expect(call?.[2].progress.state).toBe("uploaded");
		expect(outcome.deployment.deployment.state).toBe("uploaded");
	});

	it("lands on uploaded, never on released or runnable", async () => {
		const outcome = await publishAppToHq(publishInput());
		expect(outcome.deployment.deployment.state).toBe("uploaded");
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

describe("publishAppToHq — failures that are not refusals", () => {
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

		expect(outcome.deployment.deployment.state).toBe("uploaded");
		expect(outcome.warnings.join(" ")).toMatch(/media/i);
	});

	it("refuses when CommCare HQ rejects the import, and says where to retry", async () => {
		vi.mocked(importApp).mockResolvedValue({
			success: false,
			status: 403,
		} as never);

		const outcome = await publishAppToHq(publishInput());

		expect(outcome.deployment.deployment.state).toBe("incomplete");
		expect(outcome.deployment.deployment.resumePhase).toBe("upload");
		expect(recordRemoteResource).not.toHaveBeenCalled();
	});
});
