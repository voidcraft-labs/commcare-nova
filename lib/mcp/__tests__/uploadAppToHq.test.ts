/**
 * `registerUploadAppToHq` unit tests.
 *
 * Each test exercises one path through the handler's gate sequence, plus the
 * ownership pre-gate, the app-name fallback, progress emissions on the happy
 * path, and log-writer drain on a mid-upload throw.
 *
 * Hard invariants the suite encodes:
 *   - Gate "hq_not_configured" / "domain_ambiguous" exit BEFORE a `LogWriter`
 *     is ever constructed — the writer allocation sits inside the post-gate
 *     block. This is what `LogWriterMock.instances` is asserted on.
 *   - `importApp` is only reached once all pre-network gates pass. Each gate's
 *     failure test asserts `importApp` was never called.
 *   - A mid-upload throw still flushes the writer via the `finally` block.
 *   - The optional `domain` arg threads to `getCredentialsForUpload`: omitted
 *     → resolves the sole reachable space (single-space key); supplied → an
 *     explicit target that can fail as `domain_not_authorized`; multi-space with
 *     no `domain` → `domain_ambiguous` (the tool refuses to guess).
 *
 * The MCP SDK is mocked at the boundary via the `makeFakeServer` helper
 * (same pattern the sibling tests use). `@/lib/mcp/loadApp` is mocked
 * directly rather than mocking `@/lib/db/apps::loadApp`, so individual
 * tests pin the exact `{ doc, app }` pair without going through the
 * `rebuildFieldParent` path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* The deployment store is the only new boundary: mocking it (and the
 * organization snapshot the setup artifact reads) lets the REAL
 * `publishAppToHq` run through this tool, so every assertion below about
 * import ordering, media, and the boundary gate still exercises the real
 * path rather than a stand-in for it. */
vi.mock("@/lib/organization/service", () => ({
	readOrganization: vi.fn(async () => ({ revision: "1", locations: [] })),
}));
vi.mock("@/lib/deployment/store", () => {
	const record = (over: Record<string, unknown> = {}) => ({
		id: "dep-1",
		appId: "app-1",
		projectId: "proj-1",
		server: "production",
		domain: "acme",
		state: "preflight",
		resumePhase: null,
		phases: {
			preflight: null,
			resources: null,
			upload: null,
			build: null,
			release: null,
			probe: null,
		},
		createdBy: "u1",
		createdAt: "2026-08-06T00:00:00.000Z",
		updatedAt: "2026-08-06T00:00:00.000Z",
		lastObservedAt: null,
		...over,
	});
	return {
		readDeployment: vi.fn(async () => null),
		foldDeploymentAttempt: vi.fn(
			async (
				_scope: unknown,
				_target: unknown,
				phase: "preflight" | "resources" | "upload",
				outcome: { status: string },
			) => ({
				deployment: record(
					outcome.status === "failed"
						? { state: "incomplete", resumePhase: phase }
						: {},
				),
				active: [],
				superseded: [],
			}),
		),
		recordRemoteResource: vi.fn(
			async (
				_scope: unknown,
				_target: unknown,
				input: {
					remoteId: string;
					ownership: string;
					pushedRevision: number | null;
				},
			) => ({
				deployment: record({ state: "uploaded" }),
				active: [
					{
						deploymentId: "dep-1",
						kind: "app",
						novaResourceId: "app-1",
						remoteId: input.remoteId,
						ownership: input.ownership,
						pushedRevision: input.pushedRevision,
						pushedAt: null,
						pushedIdentity: null,
						adoptedAt: null,
						adoptedBy: null,
						remoteRevision: null,
						remoteObservedAt: null,
						supersededAt: null,
					},
				],
				superseded: [],
			}),
		),
		/* The lookup push's ledger write. Present because the mock must be
		 * exactly the store surface `service.ts` imports: a missing export is
		 * an unhelpful `internal` on every test that reaches a publish. */
		recordPushedResources: vi.fn(async () => ({
			deployment: record({ state: "resources" }),
			active: [],
			superseded: [],
		})),
		applyDeploymentObservation: vi.fn(),
	};
});

import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import {
	importApp,
	probeHqProjectSpaceCompatibility,
	uploadAppMediaBundle,
} from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { readHqAppSourceProfile } from "@/lib/commcare/hq/appSource";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import type { HqApplication } from "@/lib/commcare/types";
import { validationError } from "@/lib/commcare/validator/errors";
import {
	getCredentialsForUpload,
	resolveUploadTarget,
} from "@/lib/db/settings";
import type { AppDoc } from "@/lib/db/types";
import {
	applyDeploymentObservation,
	foldDeploymentAttempt,
	recordRemoteResource,
} from "@/lib/deployment/store";
import type { BlueprintDoc } from "@/lib/domain";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { resolveMediaManifest } from "@/lib/media/manifest";
import {
	projectSpaceAdvisoryUse,
	projectSpaceCapabilityUse,
	projectSpaceCompatibilityForTarget,
} from "@/lib/publish/projectSpaceCompatibility";
import { type LoadedApp, loadAppBlueprint } from "../loadApp";
import { McpAccessError } from "../ownership";
import { SCOPES } from "../scopes";
import {
	registerUploadAppToHq,
	UPLOAD_ERROR_TAGS,
} from "../tools/uploadAppToHq";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* --- Mocks ----------------------------------------------------------- */

/* `vi.mock` hoists above imports so every boundary is stubbed before
 * the handler file resolves its imports. The upload-tool flow doesn't
 * fire any blueprint-write side effects, so the apps module is mocked
 * to an empty surface — present as a no-op intercept rather than as
 * a stub for any specific function. */
vi.mock("@/lib/db/apps", () => ({}));
/* Both are mocked so a test can assert which one the tool reached for.
 * `getCredentialsForUpload` decrypts; `resolveUploadTarget` does not, and
 * the tool must use the second — it needs the project space and the server,
 * never the key. */
vi.mock("@/lib/db/settings", () => ({
	getCredentialsForUpload: vi.fn(),
	resolveUploadTarget: vi.fn(),
}));
vi.mock("@/lib/commcare/client", () => ({
	importApp: vi.fn(),
	probeHqProjectSpaceCompatibility: vi.fn(),
	uploadAppMediaBundle: vi.fn(),
}));
vi.mock("@/lib/commcare/hq/appSource", () => ({
	readHqAppSourceProfile: vi.fn(),
}));
// The bulk-zip builder needs real bytes; the tool only checks the manifest
// is non-empty before calling it, so a stub buffer keeps it network-free.
vi.mock("@/lib/commcare/multimedia/bulkUploadZip", () => ({
	buildMediaBulkUploadZip: vi.fn(() => Buffer.from("zip")),
}));
vi.mock("@/lib/commcare/expander", () => ({
	expandDoc: vi.fn(),
}));
vi.mock("@/lib/media/manifest", () => ({
	resolveMediaManifest: vi.fn(),
	// Pure projection — give the mock its real behavior so the outcome
	// interpreter can join wire paths against the doc's references.
	assetWirePaths: (manifest: Map<string, { wirePath: string }>) => {
		const out = new Map<string, string>();
		for (const [id, asset] of manifest) out.set(id, asset.wirePath);
		return out;
	},
}));
/* The media-validation gate reads the DB; mock it so the unit suite
 * stays hermetic. Default `[]` = no media issues = proceed past the gate;
 * the media-rejection test overrides per-call. */
vi.mock("@/lib/export/boundaryValidation", () => ({
	prepareExportBoundary: vi.fn(),
}));
vi.mock("../loadApp", () => ({
	loadAppBlueprint: vi.fn(),
}));

/* Hoisted `LogWriter` mock — same pattern as `sharedToolAdapter.test.ts`.
 * The class is declared inside `vi.hoisted` so the mock factory can
 * reach it (mocks hoist above top-level statements); tests look up the
 * freshest `flush` spy via `LogWriterMock.instances.at(-1)` to assert
 * the adapter drained the buffer. `beforeEach` clears the array so
 * cross-test bleed is impossible. */
const { LogWriterMock } = vi.hoisted(() => {
	class LogWriterMock {
		logEvent = vi.fn();
		flush = vi.fn().mockResolvedValue(undefined);
		static instances: LogWriterMock[] = [];
		constructor() {
			LogWriterMock.instances.push(this);
		}
	}
	return { LogWriterMock };
});
vi.mock("@/lib/log/writer", () => ({ LogWriter: LogWriterMock }));

/* --- Helpers --------------------------------------------------------- */

/** Minimal `BlueprintDoc` — the expander is mocked, so fields are unused. */
function fixtureBlueprint(): BlueprintDoc {
	return {
		appId: "a1",
		appName: "Vaccine Tracker",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

/** Minimal `AppDoc` — only `app_name` is consumed on the happy path. */
function fixtureAppDoc(overrides?: Partial<AppDoc>): AppDoc {
	return {
		owner: "u1",
		project_id: "project-1",
		app_name: "Vaccine Tracker",
		blueprint: fixtureBlueprint(),
		mutation_seq: 0,
		connect_type: null,
		module_count: 0,
		form_count: 0,
		status: "complete",
		error_type: null,
		deleted_at: null,
		recoverable_until: null,
		run_id: null,
		run_holder_nonce: null,
		created_at: new Date() as unknown as AppDoc["created_at"],
		updated_at: new Date() as unknown as AppDoc["updated_at"],
		...overrides,
	};
}

/** `{ doc, app, access }` value the mocked loader returns on happy paths. */
function fixtureLoadedApp(appOverrides?: Partial<AppDoc>): LoadedApp {
	return {
		doc: fixtureBlueprint(),
		app: fixtureAppDoc(appOverrides),
		access: {
			projectId: "project-1",
			role: "owner",
			actorUserId: "u1",
		},
	};
}

/**
 * Stand-in `HqApplication` the mocked `expandDoc` returns. Round-trips
 * through `JSON.stringify` — tests don't care about the internal shape.
 */
const FAKE_HQ_JSON = {
	doc_type: "Application" as const,
	name: "Vaccine Tracker",
	langs: ["en"],
	modules: [],
} as unknown as HqApplication;

/**
 * What `resolveUploadTarget` returns: which space, which server, and the key
 * STILL ENCRYPTED. This is what the tool sees.
 */
const FIXTURE_TARGET = {
	ok: true as const,
	username: "alice@example.com",
	server: "production" as const,
	domain: { name: "acme-research", displayName: "ACME Research" },
	encryptedApiKey: "ciphertext-xyz",
};

/**
 * What `getCredentialsForUpload` returns: the same, plus a decrypted key.
 * Only the publish lifecycle asks for this, at the point it sends the app.
 */
const FIXTURE_CREDS = {
	ok: true as const,
	creds: {
		username: "alice@example.com",
		apiKey: "key-xyz",
		server: "production" as const,
	},
	domain: { name: "acme-research", displayName: "ACME Research" },
};

/* The `nova.hq.write` scope is required by the per-tool guard inside
 * `registerUploadAppToHq`. Floor scopes (`nova.read` / `nova.write`)
 * are irrelevant in unit tests — they're checked at the route's verify
 * layer before the handler is reached, which we bypass entirely here.
 * Including only the scope the handler actually inspects keeps the
 * fixture honest about what's being asserted. */
const toolCtx: ToolContext = {
	userId: "u1",
	scopes: [SCOPES.hqWrite],
	authKind: "oauth",
};

beforeEach(() => {
	vi.mocked(loadAppBlueprint).mockReset();
	vi.mocked(resolveUploadTarget).mockReset();
	vi.mocked(importApp).mockReset();
	vi.mocked(expandDoc).mockReset();
	vi.mocked(resolveMediaManifest).mockReset();
	vi.mocked(uploadAppMediaBundle).mockReset();
	vi.mocked(probeHqProjectSpaceCompatibility).mockReset();
	vi.mocked(readHqAppSourceProfile).mockReset();
	vi.mocked(prepareExportBoundary).mockReset();
	LogWriterMock.instances = [];

	/* Default happy-path mocks — individual tests override via
	 * `mockReturnValueOnce` / `mockResolvedValueOnce` where needed. The
	 * defaults mean tests only have to pin the deviation they care about. */
	vi.mocked(resolveUploadTarget).mockResolvedValue(FIXTURE_TARGET);
	vi.mocked(getCredentialsForUpload).mockResolvedValue(FIXTURE_CREDS);
	vi.mocked(loadAppBlueprint).mockResolvedValue(fixtureLoadedApp());
	vi.mocked(expandDoc).mockReturnValue(FAKE_HQ_JSON);
	/* Media-free defaults: empty manifest → the tool skips the upload.
	 * Media-flow tests override the manifest + the bundle result. */
	vi.mocked(resolveMediaManifest).mockResolvedValue(new Map());
	vi.mocked(uploadAppMediaBundle).mockResolvedValue({
		matched: 0,
		unmatched: 0,
		unmatchedFiles: [],
		errors: [],
		timedOut: false,
	});
	vi.mocked(probeHqProjectSpaceCompatibility).mockImplementation(
		async (_credentials, domain) => ({
			capabilities: [],
			advisories: [],
			availableAdvisories: [],
			report: projectSpaceCompatibilityForTarget(domain, [], []),
		}),
	);
	vi.mocked(readHqAppSourceProfile).mockResolvedValue({ profile: {} });
	/* Neutral export prep is transparent by default. The media-rejection test
	 * overrides with a rejected boundary result. */
	vi.mocked(prepareExportBoundary).mockImplementation(
		async (input) =>
			({
				ok: true,
				prepared: {
					...input,
					assets: await resolveMediaManifest(
						input.doc,
						input.access.projectId,
						{ withBytes: true },
					),
				},
			}) as never,
	);
});

/* --- Tests ----------------------------------------------------------- */

describe("registerUploadAppToHq — happy path", () => {
	it("instructs bare MCP clients to check the chosen project space before upload", () => {
		const { server, registeredConfig } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const config = registeredConfig() as { description?: string };
		expect(config.description).toContain(
			"call `check_project_space_compatibility`",
		);
		expect(config.description).toContain("explicit chosen domain");
		expect(config.description).toContain(
			"final authoritative compatibility check",
		);
		expect(config.description).toContain("`project_space_incompatible`");
		expect(config.description).toContain("a performance advisory never blocks");
		expect(config.description).toContain("`hq_app_state_unknown`");
		expect(config.description).not.toContain("get_app_hq_feature_flags");
	});

	it("resolves the sole space (no domain arg) and returns the HQ app id + URL", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-123",
			version: null,
			warnings: [],
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()(
			{ app_id: "a1", app_name: "Imported" },
			{},
		)) as {
			content: Array<{ type: "text"; text: string }>;
		};

		/* No `domain` arg → the resolver is asked with `undefined` and resolves
		 * the sole reachable space (the only no-arg success case); that resolved
		 * domain is what reaches `importApp`. */
		expect(resolveUploadTarget).toHaveBeenCalledWith("u1", undefined);

		/* The tool works out WHICH space with the non-decrypting resolver, and
		 * the key is decrypted exactly once — by the publish lifecycle, at the
		 * point it sends the app. Two decrypts meant a second plaintext copy
		 * of a live production credential in memory that nothing ever used. */
		expect(getCredentialsForUpload).toHaveBeenCalledTimes(1);
		expect(importApp).toHaveBeenCalledWith(
			FIXTURE_CREDS.creds,
			"acme-research",
			"Imported",
			FAKE_HQ_JSON,
			// No active mapping for this target, so the publish creates.
			undefined,
		);

		const parsed = JSON.parse(out.content[0]?.text ?? "{}");
		expect(parsed).toMatchObject({
			stage: "upload_complete",
			app_id: "a1",
			hq_app_id: "hq-123",
			hq_app_action: "created",
			warnings: [],
			project_space_compatibility: expect.objectContaining({
				status: "not_needed",
				required_capabilities: [],
			}),
		});
		/* Uploading is not releasing: the state a successful publish reaches
		 * is `uploaded`, and a client that reported it as live would be
		 * wrong. The setup artifact rides along so it can say what is left. */
		expect(parsed.deployment_state).toBe("uploaded");
		expect(parsed.deployment).toMatchObject({
			state: "uploaded",
			hq_app_id: "hq-123",
			ownership: "nova-created",
			left_behind: [],
		});
		expect(parsed.setup_artifact.sections).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "build-and-release" }),
			]),
		);

		/* LogWriter allocated + flushed exactly once — the finally block
		 * runs regardless of outcome. */
		expect(LogWriterMock.instances).toHaveLength(1);
		expect(LogWriterMock.instances[0]?.flush).toHaveBeenCalledTimes(1);
	});

	it("forwards an explicit `domain` arg to resolution and uploads to it", async () => {
		vi.mocked(resolveUploadTarget).mockResolvedValue({
			...FIXTURE_TARGET,
			domain: { name: "connect-ace-prod", displayName: "ACE Prod" },
		});
		vi.mocked(getCredentialsForUpload).mockResolvedValue({
			...FIXTURE_CREDS,
			domain: { name: "connect-ace-prod", displayName: "ACE Prod" },
		});
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-prod",
			version: null,
			warnings: [],
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		await capture()({ app_id: "a1", domain: "connect-ace-prod" }, {});

		expect(getCredentialsForUpload).toHaveBeenCalledWith(
			"u1",
			"connect-ace-prod",
		);
		expect(importApp).toHaveBeenCalledWith(
			FIXTURE_CREDS.creds,
			"connect-ace-prod",
			"Vaccine Tracker",
			FAKE_HQ_JSON,
			undefined,
		);
	});

	it("uploads with a ready semantic report when only a performance advisory is missing", async () => {
		const doc = fixtureBlueprint();
		doc.modules = {
			patients: {
				uuid: "patients",
				id: "patients",
				name: "Patients",
				caseType: "patient",
				caseSearchConfig: {},
			} as BlueprintDoc["modules"][string],
		};
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(
			fixtureLoadedBlueprintForTest(doc),
		);
		const search = projectSpaceCapabilityUse("case-search", [
			"The app searches for cases that may not already be available.",
		]);
		const performance = projectSpaceAdvisoryUse("large-search-performance", [
			"The app searches for cases that may not already be available.",
		]);
		const capabilities = [{ capability: search, state: "available" as const }];
		const advisories = [{ advisory: performance, state: "missing" as const }];
		vi.mocked(probeHqProjectSpaceCompatibility).mockResolvedValueOnce({
			capabilities,
			advisories,
			availableAdvisories: [],
			report: projectSpaceCompatibilityForTarget(
				"acme-research",
				capabilities,
				advisories,
			),
		});
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-search",
			version: null,
			warnings: [],
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);
		const out = (await capture()({ app_id: "a1" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};
		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
			project_space_compatibility: {
				status: string;
				required_capabilities: { id: string; state: string }[];
				advisories: { id: string; state: string }[];
			};
		};

		expect(importApp).toHaveBeenCalledTimes(1);
		expect(parsed.project_space_compatibility).toMatchObject({
			status: "ready",
			required_capabilities: [
				expect.objectContaining({ id: "case-search", state: "available" }),
			],
			advisories: [
				expect.objectContaining({
					id: "large-search-performance",
					state: "missing",
				}),
			],
		});
	});

	it("blocks before upload when required project-space support is missing", async () => {
		const doc = fixtureBlueprint();
		doc.connectType = "learn";
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(
			fixtureLoadedBlueprintForTest(doc),
		);
		const connect = projectSpaceCapabilityUse("commcare-connect", [
			"The app uses CommCare Connect Learn.",
		]);
		const capabilities = [{ capability: connect, state: "missing" as const }];
		vi.mocked(probeHqProjectSpaceCompatibility).mockResolvedValueOnce({
			capabilities,
			advisories: [],
			availableAdvisories: [],
			report: projectSpaceCompatibilityForTarget(
				"acme-research",
				capabilities,
				[],
			),
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);
		const out = (await capture()({ app_id: "a1" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};
		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			project_space_compatibility: {
				status: string;
				blockers: { id: string; state: string }[];
			};
		};
		expect(parsed.error_type).toBe("project_space_incompatible");
		expect(parsed.project_space_compatibility.status).toBe("blocked");
		expect(parsed.project_space_compatibility.blockers).toEqual([
			expect.objectContaining({
				id: "commcare-connect",
				state: "missing",
			}),
		]);
		expect(importApp).not.toHaveBeenCalled();
		const serialized = JSON.stringify(parsed);
		expect(serialized).not.toMatch(/slug|namespace|profile|toggle|setting/i);
		expect(serialized).not.toMatch(
			/search_claim|case_search_advanced|commcare_connect|mm_case_properties|view_form_attachments|custom_properties|NAMESPACE_|TAG_/i,
		);
	});
});

function fixtureLoadedBlueprintForTest(doc: BlueprintDoc): LoadedApp {
	return {
		...fixtureLoadedApp(),
		doc,
		app: fixtureAppDoc({ blueprint: doc, connect_type: doc.connectType }),
	};
}

describe("registerUploadAppToHq — media upload ordering", () => {
	/** A manifest stand-in — its contents don't matter because
	 *  `buildMediaBulkUploadZip` is mocked; only that it's threaded from
	 *  `resolveMediaManifest` → `expandDoc` does. */
	const FAKE_MANIFEST: AssetManifest = new Map();

	it("imports the app first, then uploads media against the returned app id", async () => {
		const order: string[] = [];
		// Non-empty manifest so the tool reaches the media upload.
		vi.mocked(resolveMediaManifest).mockImplementation(async () => {
			order.push("resolve");
			return new Map([["a1", {} as never]]) as never;
		});
		vi.mocked(importApp).mockImplementation(async () => {
			order.push("import");
			return {
				success: true,
				appId: "hq-789",
				version: null,
				warnings: [],
			};
		});
		vi.mocked(uploadAppMediaBundle).mockImplementation(async () => {
			order.push("upload");
			return {
				matched: 1,
				unmatched: 0,
				unmatchedFiles: [],
				errors: [],
				timedOut: false,
			};
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);
		await capture()({ app_id: "a1" }, {});

		/* Strict sequence: resolve manifest → import app → upload media.
		 * Import must precede upload because the upload URL embeds the
		 * app id `importApp` returns. */
		expect(order).toEqual(["resolve", "import", "upload"]);

		/* The bundle is uploaded against the id `importApp` returned, to the
		 * stored domain, as the ZIP `buildMediaBulkUploadZip` produced from
		 * the resolved manifest. */
		expect(uploadAppMediaBundle).toHaveBeenCalledWith(
			FIXTURE_CREDS.creds,
			"acme-research",
			"hq-789",
			Buffer.from("zip"),
		);
	});

	it("expands media-ON with the resolved manifest threaded into expandDoc", async () => {
		vi.mocked(resolveMediaManifest).mockResolvedValue(FAKE_MANIFEST);
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-1",
			version: null,
			warnings: [],
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);
		await capture()({ app_id: "a1" }, {});

		/* expandDoc receives `{ assets: manifest }` — this is the media-ON
		 * flip: the emitted forms carry the jr:// itext references the
		 * subsequent byte upload resolves. It also receives the attachment
		 * target, which on this path is not resolved from history and never
		 * absent: an upload IS the act of putting the app on this project
		 * space, so the address its attachment links resolve against is the
		 * one being published to. */
		expect(expandDoc).toHaveBeenCalledWith(fixtureBlueprint(), {
			assets: FAKE_MANIFEST,
			attachmentTarget: {
				origin: "https://www.commcarehq.org",
				domain: "acme-research",
			},
		});
		/* The manifest is resolved WITH bytes — the upload needs them, at the
		 * app's PROJECT scope (the sharing boundary), not the acting caller. */
		expect(resolveMediaManifest).toHaveBeenCalledWith(
			fixtureBlueprint(),
			"project-1",
			{
				withBytes: true,
			},
		);
	});

	it("surfaces a standalone-logo heads-up as a warning without failing the upload", async () => {
		const logoId = testMediaAssetId("logoA");
		// The loaded app's logo image is used nowhere else, so HQ reports it
		// unmatched by design (logos aren't in its bulk-match set). This is the
		// real NOVA-1P scenario — surfaced gently, never as a failed attach.
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce({
			doc: {
				...fixtureBlueprint(),
				logo: logoId,
			},
			app: fixtureAppDoc(),
			access: fixtureLoadedApp().access,
		});
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-1",
			version: null,
			warnings: [],
		});
		vi.mocked(resolveMediaManifest).mockResolvedValueOnce(
			new Map([[logoId, { wirePath: "commcare/logo.png" } as never]]) as never,
		);
		vi.mocked(uploadAppMediaBundle).mockResolvedValueOnce({
			matched: 0,
			unmatched: 1,
			unmatchedFiles: [
				{ path: "commcare/logo.png", reason: "Did not match any Image paths." },
			],
			errors: [],
			timedOut: false,
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);
		const out = (await capture()({ app_id: "a1" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
			stage: string;
			hq_app_id: string;
			warnings: string[];
		};
		/* Still a success envelope — the app was created. */
		expect(parsed.stage).toBe("upload_complete");
		expect(parsed.hq_app_id).toBe("hq-1");
		/* The logo becomes a single gentle warning, not a "couldn't attach". */
		expect(parsed.warnings).toHaveLength(1);
		expect(parsed.warnings[0]).toMatch(/logo/i);
		expect(parsed.warnings[0]).toContain("CommCare HQ");
		expect(parsed.warnings[0]).not.toMatch(/couldn't attach/i);
	});
});

describe("registerUploadAppToHq — pre-gate 0: missing nova.hq.write", () => {
	it("returns scope_missing without touching ownership, settings, or HQ", async () => {
		const { server, capture } = makeFakeServer();
		/* Token has the route-layer floor but lacks the orthogonal HQ
		 * write scope. The per-tool guard must short-circuit before any
		 * DB read or HQ network call. */
		registerUploadAppToHq(server, {
			userId: "u1",
			scopes: [SCOPES.read, SCOPES.write],
			authKind: "oauth",
		});

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			required_scope?: string;
			app_id?: string;
		};
		expect(payload.error_type).toBe("scope_missing");
		expect(payload.required_scope).toBe(SCOPES.hqWrite);
		/* Wire-shape uniformity: every upload-tool failure envelope
		 * carries `app_id`. A client switching on `error_type` should
		 * never need to special-case `scope_missing` for that field. */
		expect(payload.app_id).toBe("a1");

		/* Pre-gate 0 fires BEFORE every other I/O — no blueprint load,
		 * no settings read, no HQ call, no log writer allocation. The
		 * scope failure leaks nothing about the user's data. */
		expect(getCredentialsForUpload).not.toHaveBeenCalled();
		expect(loadAppBlueprint).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
		expect(LogWriterMock.instances).toHaveLength(0);
	});
});

describe("registerUploadAppToHq — gate 2: HQ not configured", () => {
	it("returns error_type 'hq_not_configured' when no creds exist", async () => {
		vi.mocked(resolveUploadTarget).mockResolvedValueOnce({
			ok: false,
			error: "not_configured",
		});
		/* Ownership + blueprint load resolves cleanly (it's the creds gate
		 * that fails, not the ownership gate). */
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(fixtureLoadedApp());

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			app_id: string;
		};
		expect(payload.error_type).toBe(UPLOAD_ERROR_TAGS.hq_not_configured);
		expect(payload.app_id).toBe("a1");
		/* Gate failure short-circuits before any HQ network call. */
		expect(importApp).not.toHaveBeenCalled();
		/* And — critically — no `LogWriter` was allocated for a gate
		 * that has nothing to flush. The writer ctor lives past this gate. */
		expect(LogWriterMock.instances).toHaveLength(0);
	});
});

describe("registerUploadAppToHq — gate 2: domain not authorized", () => {
	it("returns 'domain_not_authorized' naming the reachable set when the requested space is unreachable", async () => {
		const reachable = [
			{ name: "acme-research", displayName: "ACME Research" },
			{ name: "connect-ace-prod", displayName: "ACE Prod" },
		];
		vi.mocked(resolveUploadTarget).mockResolvedValueOnce({
			ok: false,
			error: "not_authorized",
			available: reachable,
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()(
			{ app_id: "a1", domain: "ghost-space" },
			{},
		)) as {
			isError: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			message: string;
			app_id: string;
		};
		expect(payload.error_type).toBe(UPLOAD_ERROR_TAGS.domain_not_authorized);
		/* The message names both the rejected request and the reachable set
		 * so the caller (or the user behind it) can correct course. */
		expect(payload.message).toContain("ghost-space");
		expect(payload.message).toContain("acme-research");
		expect(payload.message).toContain("connect-ace-prod");
		expect(importApp).not.toHaveBeenCalled();
		expect(LogWriterMock.instances).toHaveLength(0);
	});
});

describe("registerUploadAppToHq — gate 2: ambiguous multi-space key", () => {
	it("returns 'domain_ambiguous' naming the spaces when no domain and no default", async () => {
		const reachable = [
			{ name: "connect-ace-prod", displayName: "ACE Prod" },
			{ name: "ace-crispr-connect", displayName: "CRISPR" },
		];
		vi.mocked(resolveUploadTarget).mockResolvedValueOnce({
			ok: false,
			error: "ambiguous",
			available: reachable,
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			message: string;
			app_id: string;
		};
		expect(payload.error_type).toBe(UPLOAD_ERROR_TAGS.domain_ambiguous);
		/* Both spaces are named so the caller can pick one — the whole
		 * point is to NOT silently bind to the first. */
		expect(payload.message).toContain("connect-ace-prod");
		expect(payload.message).toContain("ace-crispr-connect");
		/* Resolution failed before any network call or writer allocation. */
		expect(importApp).not.toHaveBeenCalled();
		expect(LogWriterMock.instances).toHaveLength(0);
	});
});

describe("registerUploadAppToHq — gate 3: HQ upload failed", () => {
	it("returns error_type 'hq_upload_failed' when importApp surfaces a non-success", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: false,
			status: 502,
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			app_id: string;
			message: string;
		};
		expect(payload.error_type).toBe(UPLOAD_ERROR_TAGS.hq_upload_failed);
		expect(payload.app_id).toBe("a1");
		/* The failure reads person-to-person rather than echoing a status
		 * code; `error_type` is the machine-readable half. The status is
		 * logged server-side by the client. Kept because
		 * the LLM can explain the failure category to the user. */
		expect(payload.message).toMatch(/unavailable right now/i);

		/* LogWriter WAS allocated (this gate sits past the writer ctor) AND
		 * flushed — the `finally` block drains even on non-success return. */
		expect(LogWriterMock.instances).toHaveLength(1);
		expect(LogWriterMock.instances[0]?.flush).toHaveBeenCalledTimes(1);
	});
});

describe("registerUploadAppToHq — in-place update", () => {
	/** A fold answer whose ledger already maps this target's HQ app, which
	 *  is what sends the real `publishAppToHq` down the update path. */
	function mappedFoldView(remoteId: string) {
		return {
			deployment: {
				id: "dep-1",
				appId: "app-1",
				projectId: "proj-1",
				server: "production",
				domain: "acme",
				state: "uploaded",
				resumePhase: null,
				phases: {
					preflight: null,
					upload: null,
					build: null,
					release: null,
					probe: null,
				},
				createdBy: "u1",
				createdAt: "2026-08-06T00:00:00.000Z",
				updatedAt: "2026-08-06T00:00:00.000Z",
				lastObservedAt: null,
			},
			active: [
				{
					deploymentId: "dep-1",
					kind: "app",
					novaResourceId: "app-1",
					remoteId,
					ownership: "nova-created",
					pushedRevision: 3,
					pushedAt: "2026-08-10T00:00:00.000Z",
					remoteRevision: 4,
					remoteObservedAt: null,
					supersededAt: null,
				},
			],
			superseded: [],
		};
	}

	it("sends the mapped app id and reports hq_app_action 'updated'", async () => {
		vi.mocked(foldDeploymentAttempt).mockResolvedValueOnce(
			mappedFoldView("hq-existing") as never,
		);
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-existing",
			version: 12,
			warnings: [],
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);
		const out = (await capture()({ app_id: "a1" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		/* The mapping's remote id rides the import, which is what makes
		 * CommCare HQ overwrite that app instead of minting a new one. */
		expect(vi.mocked(importApp).mock.calls[0]?.[4]).toBe("hq-existing");
		/* The same id is re-recorded with HQ's post-update version, so the
		 * live mapping's remote revision tracks what the target now holds. */
		expect(vi.mocked(recordRemoteResource).mock.calls[0]?.[2]).toMatchObject({
			remoteId: "hq-existing",
			remoteRevision: 12,
		});

		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
			hq_app_id: string;
			hq_app_action: string;
		};
		expect(parsed.hq_app_action).toBe("updated");
		expect(parsed.hq_app_id).toBe("hq-existing");
	});

	it("returns a typed refusal without uploading when the current HQ app source cannot be read", async () => {
		vi.mocked(foldDeploymentAttempt).mockResolvedValueOnce(
			mappedFoldView("hq-existing") as never,
		);
		vi.mocked(readHqAppSourceProfile).mockResolvedValueOnce({
			success: false,
			status: 502,
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);
		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			message: string;
			app_id: string;
		};
		expect(payload).toMatchObject({
			error_type: UPLOAD_ERROR_TAGS.hq_app_state_unknown,
			app_id: "a1",
		});
		expect(payload.message).toMatch(/left that app unchanged/i);
		expect(importApp).not.toHaveBeenCalled();
		expect(recordRemoteResource).not.toHaveBeenCalled();
	});

	it("refuses with 'remote_app_missing' when the mapped app is gone, folding the answer as an observation", async () => {
		vi.mocked(foldDeploymentAttempt).mockResolvedValueOnce(
			mappedFoldView("hq-deleted") as never,
		);
		vi.mocked(importApp).mockResolvedValueOnce({
			success: false,
			status: 404,
		});
		/* The publish folds the 404 through the observation path; hand the
		 * bare mock a view so the refusal can still carry the record. */
		vi.mocked(applyDeploymentObservation).mockResolvedValueOnce({
			view: {
				...mappedFoldView("hq-deleted"),
				deployment: {
					...mappedFoldView("hq-deleted").deployment,
					state: "incomplete",
					resumePhase: "upload",
				},
			},
		} as never);

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);
		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			message: string;
			app_id: string;
		};
		/* Its own tag, not the generic upload failure: "the upload broke"
		 * would send a client debugging its request when the truth is the
		 * target vanished and publishing again recreates it. */
		expect(payload.error_type).toBe(UPLOAD_ERROR_TAGS.remote_app_missing);
		expect(payload.app_id).toBe("a1");
		expect(payload.message).toMatch(/publish again/i);

		/* The 404 is target information: it folds as an observation against
		 * the exact mapping this publish read (id + its pushed-at staleness
		 * token), and no remote resource is recorded — nothing landed. */
		expect(
			vi.mocked(applyDeploymentObservation).mock.calls[0]?.[2],
		).toMatchObject({
			observedRemoteId: "hq-deleted",
			observedPushedAt: "2026-08-10T00:00:00.000Z",
		});
		expect(recordRemoteResource).not.toHaveBeenCalled();

		/* An upload genuinely went out, so the writer exists and drains. */
		expect(LogWriterMock.instances).toHaveLength(1);
		expect(LogWriterMock.instances[0]?.flush).toHaveBeenCalledTimes(1);
	});
});

describe("registerUploadAppToHq — boundary gate", () => {
	it("returns invalid_input (not an opaque internal error) when a media ref is stale", async () => {
		/* A stale media ref — the kind of issue that would otherwise make
		 * the media-ON `expandDoc` throw `requireAssetRef`, surfacing as a
		 * generic `internal` error. The gate surfaces the rule's
		 * actionable message as `invalid_input` instead. */
		vi.mocked(prepareExportBoundary).mockResolvedValueOnce({
			ok: false,
			violations: [
				validationError(
					"MEDIA_ASSET_NOT_FOUND",
					"field",
					"At the label on field 'photo' in form 'Intake', the referenced media asset no longer exists. Re-attach an asset or remove the reference.",
					{ formName: "Intake", fieldId: "photo" },
				),
			],
		} as never);

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			app_id: string;
			message: string;
		};
		/* Routed through `McpInvalidInputError` → `invalid_input`. */
		expect(payload.error_type).toBe("invalid_input");
		expect(payload.app_id).toBe("a1");
		expect(payload.message).toMatch(/media file is missing/i);

		/* The boundary gate runs inside the shared publish lifecycle, but
		 * the call collaborators are allocated in its upload-started hook,
		 * which a refused publish never reaches. An invalid app therefore
		 * still allocates no LogWriter and records no phantom run — a
		 * client retrying an invalid app in a loop must not fill admin
		 * inspect with uploads that never happened — and nothing reaches
		 * CommCare HQ. */
		expect(LogWriterMock.instances).toHaveLength(0);
		expect(expandDoc).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
		expect(uploadAppMediaBundle).not.toHaveBeenCalled();
	});

	it("does not recast an operational lookup-read failure as invalid_input", async () => {
		vi.mocked(prepareExportBoundary).mockRejectedValueOnce(
			new Error("lookup database unavailable"),
		);

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);
		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
		};

		expect(out.isError).toBe(true);
		expect(payload.error_type).not.toBe("invalid_input");
		expect(expandDoc).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
		expect(uploadAppMediaBundle).not.toHaveBeenCalled();
	});

	it("proceeds to import + upload when the boundary gate is clean", async () => {
		/* `prepareExportBoundary` defaults to a clean result (beforeEach) —
		 * the gate is transparent and the normal flow runs. */
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-clean",
			version: null,
			warnings: [],
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
			stage: string;
			hq_app_id: string;
		};
		expect(parsed.stage).toBe("upload_complete");
		expect(parsed.hq_app_id).toBe("hq-clean");
		expect(prepareExportBoundary).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "hq-upload" }),
		);
		expect(importApp).toHaveBeenCalledTimes(1);
	});
});

describe("registerUploadAppToHq — ownership failure", () => {
	it("collapses not_owner to not_found on the wire (IDOR hardening) and never fetches creds or calls importApp", async () => {
		/* IDOR hardening: an upload probe against an app owned by
		 * another user must look indistinguishable from a probe against
		 * a non-existent id. `loadAppBlueprint` throws
		 * `McpAccessError("not_owner")`; the wire collapses to
		 * `"not_found"`. */
		vi.mocked(loadAppBlueprint).mockRejectedValueOnce(
			new McpAccessError("not_owner"),
		);

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			message: string;
			app_id: string;
		};
		expect(payload.error_type).toBe("not_found");
		expect(payload.message).toBe("App not found.");
		expect(payload.app_id).toBe("a1");
		/* Ownership failure must short-circuit BEFORE any settings read
		 * or HQ call — the ownership pre-gate (folded into
		 * `loadAppBlueprint`) is the first line of defense against
		 * cross-tenant upload probes. */
		expect(getCredentialsForUpload).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
		expect(LogWriterMock.instances).toHaveLength(0);
	});
});

describe("registerUploadAppToHq — wire parity (IDOR regression lock)", () => {
	it("not_owner and not_found produce byte-identical envelopes", async () => {
		/* Regression lock for the IDOR hardening: both access-failure
		 * shapes must be byte-identical so a probing client cannot
		 * enumerate existing app ids. */
		vi.mocked(loadAppBlueprint).mockRejectedValueOnce(
			new McpAccessError("not_owner"),
		);
		const { server: sA, capture: capA } = makeFakeServer();
		registerUploadAppToHq(sA, toolCtx);
		const ownerMismatch = await capA()({ app_id: "probe-id" }, {});

		vi.mocked(loadAppBlueprint).mockRejectedValueOnce(
			new McpAccessError("not_found"),
		);
		const { server: sB, capture: capB } = makeFakeServer();
		registerUploadAppToHq(sB, toolCtx);
		const notFound = await capB()({ app_id: "probe-id" }, {});

		expect(JSON.stringify(ownerMismatch)).toBe(JSON.stringify(notFound));
		/* No settings fetch, no HQ call on either branch — both
		 * short-circuited at the ownership gate with identical
		 * envelopes. */
		expect(getCredentialsForUpload).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
	});
});

describe("registerUploadAppToHq — app name fallback", () => {
	it("falls back to the blueprint's app_name when app_name is omitted", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-1",
			version: null,
			warnings: [],
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		await capture()({ app_id: "a1" }, {});

		expect(importApp).toHaveBeenCalledWith(
			FIXTURE_CREDS.creds,
			"acme-research",
			"Vaccine Tracker",
			FAKE_HQ_JSON,
			undefined,
		);
	});

	it("falls back to the blueprint's app_name on a whitespace-only override", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-2",
			version: null,
			warnings: [],
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		await capture()({ app_id: "a1", app_name: "   " }, {});

		/* `?.trim() || app.app_name` must map whitespace-only to the
		 * blueprint name — a blank `app_name` on HQ is strictly worse
		 * than using the real name. */
		expect(importApp).toHaveBeenCalledWith(
			FIXTURE_CREDS.creds,
			"acme-research",
			"Vaccine Tracker",
			FAKE_HQ_JSON,
			undefined,
		);
	});
});

describe("registerUploadAppToHq — progress notifications", () => {
	it("emits upload_started + upload_complete when the client supplies a progress token", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-prog",
			version: null,
			warnings: [],
		});

		const { server, capture, callExtra, notificationSpy } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		await capture()({ app_id: "a1" }, callExtra("pt-1"));

		/* Each progress emission goes through the request-scoped
		 * `mcpReq.notify` sender
		 * with the stage packed into the formatted `message` string as
		 * `[<stage>] <text>[ | k=v...]`. Pull the prefixes off in order
		 * — a future regression that re-orders the pipeline or drops
		 * one of the emissions will flip this assertion. */
		const messages = notificationSpy.mock.calls
			.map((c) => c[0] as { params?: { message?: string } })
			.map((arg) => arg.params?.message ?? "");
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatch(/^\[upload_started\] /);
		expect(messages[1]).toMatch(/^\[upload_complete\] /);
	});

	it("no-ops progress notifications when no progress token is supplied", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-silent",
			version: null,
			warnings: [],
		});

		const { server, capture, callExtra, notificationSpy } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		await capture()({ app_id: "a1" }, callExtra());

		/* `createProgressEmitter` branches on `progressToken === undefined`
		 * and silently drops every `notify` call — nothing should have
		 * been dispatched through the request-scoped sender even though
		 * one was available. */
		expect(notificationSpy).not.toHaveBeenCalled();
	});
});

describe("registerUploadAppToHq — log writer drain on throw", () => {
	it("awaits flush() when importApp throws mid-upload", async () => {
		/* The writer is allocated BEFORE `importApp` runs, so a throw
		 * here must still flow through the `finally` drain. If the flush
		 * were skipped, queued log events would be lost. */
		vi.mocked(importApp).mockRejectedValueOnce(new Error("network down"));

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError: true;
			content: Array<{ type: "text"; text: string }>;
		};

		/* The throw surfaces through `toMcpErrorResult`'s shared
		 * taxonomy — not as one of the gate tags. */
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			app_id?: string;
		};
		expect(payload.error_type).not.toBe(UPLOAD_ERROR_TAGS.hq_upload_failed);
		/* Error content carries `app_id` so the model can correlate
		 * the failure back to the target app. */
		expect(payload.app_id).toBe("a1");

		/* Writer ran its finally block exactly once. */
		expect(LogWriterMock.instances).toHaveLength(1);
		expect(LogWriterMock.instances[0]?.flush).toHaveBeenCalledTimes(1);
	});
});
