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
import { importApp, uploadAppMediaBundle } from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { validationError } from "@/lib/commcare/validator/errors";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { proseText } from "@/lib/domain/prose";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { observeDeployment } from "../observe";
import { publishAppToHq, refreshDeployment } from "../service";
import { applyAttemptOutcome } from "../stateMachine";
import {
	applyDeploymentObservation,
	foldDeploymentAttempt,
	readDeployment,
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
	readOrganization: vi.fn(async () => ({ revision: "1", locations: [] })),
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
	recordRemoteResource: vi.fn(),
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
 * `applyAttemptOutcome` to whatever `readDeployment` currently answers
 * (or to a fresh record when `ensure` is set), and return the folded
 * view. What the tests then assert about states is the state machine's
 * own answer, not a fixture's.
 */
function installRealisticFold() {
	vi.mocked(foldDeploymentAttempt).mockImplementation(
		async (_scope, _target, phase, outcome, options) => {
			const existing = await vi
				.mocked(readDeployment)
				.getMockImplementation()?.(_scope, _target);
			const base = existing ?? (options?.ensure === true ? view() : null);
			if (base === null) throw new Error("fold on a missing record");
			const next = applyAttemptOutcome(
				base.deployment as never,
				phase,
				outcome,
			);
			return { ...base, deployment: next } as never;
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

describe("publishAppToHq — update in place vs create", () => {
	it("creates on a first publish, sending no app id", async () => {
		const outcome = await publishAppToHq(publishInput());

		expect(vi.mocked(importApp).mock.calls[0]?.[4]).toBeUndefined();
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
