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
import { importApp, uploadAppMediaBundle } from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import type { HqApplication } from "@/lib/commcare/types";
import { validationError } from "@/lib/commcare/validator/errors";
import { getCredentialsForUpload } from "@/lib/db/settings";
import type { AppDoc } from "@/lib/db/types";
import type { BlueprintDoc } from "@/lib/domain";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { resolveMediaManifest } from "@/lib/media/manifest";
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
vi.mock("@/lib/db/settings", () => ({
	getCredentialsForUpload: vi.fn(),
}));
vi.mock("@/lib/commcare/client", () => ({
	importApp: vi.fn(),
	uploadAppMediaBundle: vi.fn(),
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
 * Canonical success result — mirrors the `{ ok: true, creds, domain }` shape
 * `getCredentialsForUpload` returns once a target space resolves.
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
	vi.mocked(getCredentialsForUpload).mockReset();
	vi.mocked(importApp).mockReset();
	vi.mocked(expandDoc).mockReset();
	vi.mocked(resolveMediaManifest).mockReset();
	vi.mocked(uploadAppMediaBundle).mockReset();
	vi.mocked(prepareExportBoundary).mockReset();
	LogWriterMock.instances = [];

	/* Default happy-path mocks — individual tests override via
	 * `mockReturnValueOnce` / `mockResolvedValueOnce` where needed. The
	 * defaults mean tests only have to pin the deviation they care about. */
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
	it("resolves the sole space (no domain arg) and returns the HQ app id + URL", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-123",
			appUrl: "https://hq.example/app",
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
		expect(getCredentialsForUpload).toHaveBeenCalledWith("u1", undefined);
		expect(importApp).toHaveBeenCalledWith(
			FIXTURE_CREDS.creds,
			"acme-research",
			"Imported",
			FAKE_HQ_JSON,
		);

		const parsed = JSON.parse(out.content[0]?.text ?? "{}");
		expect(parsed).toEqual({
			stage: "upload_complete",
			app_id: "a1",
			hq_app_id: "hq-123",
			url: "https://hq.example/app",
			warnings: [],
		});

		/* LogWriter allocated + flushed exactly once — the finally block
		 * runs regardless of outcome. */
		expect(LogWriterMock.instances).toHaveLength(1);
		expect(LogWriterMock.instances[0]?.flush).toHaveBeenCalledTimes(1);
	});

	it("forwards an explicit `domain` arg to resolution and uploads to it", async () => {
		vi.mocked(getCredentialsForUpload).mockResolvedValueOnce({
			ok: true,
			creds: FIXTURE_CREDS.creds,
			domain: { name: "connect-ace-prod", displayName: "ACE Prod" },
		});
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-prod",
			appUrl: "https://hq.example/app",
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
		);
	});
});

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
				appUrl: "https://hq.example/app",
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
			appUrl: "https://hq.example/app",
			warnings: [],
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);
		await capture()({ app_id: "a1" }, {});

		/* expandDoc receives `{ assets: manifest }` — this is the media-ON
		 * flip: the emitted forms carry the jr:// itext references the
		 * subsequent byte upload resolves. */
		expect(expandDoc).toHaveBeenCalledWith(fixtureBlueprint(), {
			assets: FAKE_MANIFEST,
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
		// The loaded app's logo image is used nowhere else, so HQ reports it
		// unmatched by design (logos aren't in its bulk-match set). This is the
		// real NOVA-1P scenario — surfaced gently, never as a failed attach.
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce({
			doc: { ...fixtureBlueprint(), logo: "logoA" },
			app: fixtureAppDoc(),
			access: fixtureLoadedApp().access,
		});
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-1",
			appUrl: "https://hq.example/app",
			warnings: [],
		});
		vi.mocked(resolveMediaManifest).mockResolvedValueOnce(
			new Map([["logoA", { wirePath: "commcare/logo.png" } as never]]) as never,
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
		vi.mocked(getCredentialsForUpload).mockResolvedValueOnce({
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
		vi.mocked(getCredentialsForUpload).mockResolvedValueOnce({
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
		vi.mocked(getCredentialsForUpload).mockResolvedValueOnce({
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
		/* The HQ status code is surfaced in the user-facing message so
		 * the LLM can explain the failure category to the user. */
		expect(payload.message).toContain("502");

		/* LogWriter WAS allocated (this gate sits past the writer ctor) AND
		 * flushed — the `finally` block drains even on non-success return. */
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
		expect(payload.message).toContain("no longer exists");

		/* The gate fires BEFORE import + the LogWriter ctor — a
		 * media-invalid doc never reaches HQ and never allocates a writer. */
		expect(expandDoc).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
		expect(uploadAppMediaBundle).not.toHaveBeenCalled();
		expect(LogWriterMock.instances).toHaveLength(0);
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
		expect(LogWriterMock.instances).toHaveLength(0);
	});

	it("proceeds to import + upload when the boundary gate is clean", async () => {
		/* `prepareExportBoundary` defaults to a clean result (beforeEach) —
		 * the gate is transparent and the normal flow runs. */
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-clean",
			appUrl: "https://hq.example/app",
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
			appUrl: "https://hq.example/app",
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
		);
	});

	it("falls back to the blueprint's app_name on a whitespace-only override", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-2",
			appUrl: "https://hq.example/app",
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
		);
	});
});

describe("registerUploadAppToHq — progress notifications", () => {
	it("emits upload_started + upload_complete when the client supplies a progress token", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-prog",
			appUrl: "https://hq.example/app",
			warnings: [],
		});

		const { server, capture, notificationSpy } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		await capture()({ app_id: "a1" }, { _meta: { progressToken: "pt-1" } });

		/* Each progress emission goes through `server.server.notification`
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
			appUrl: "https://hq.example/app",
			warnings: [],
		});

		const { server, capture, notificationSpy } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		await capture()({ app_id: "a1" }, {});

		/* `createProgressEmitter` branches on `progressToken === undefined`
		 * and silently drops every `notify` call — no notification should
		 * have been dispatched through the low-level API. */
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
