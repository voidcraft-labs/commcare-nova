/**
 * `POST /api/commcare/upload` — boundary gate tests.
 *
 * This route is media-ON and boundary-gated: any validator finding
 * returns an actionable 422 before the HQ import (a stale media
 * reference would otherwise make `expandDoc` throw `requireAssetRef` →
 * opaque 500). These tests prove the gate fires AND that the handler
 * returns on it (the un-typed fall-through risk: calling the gate,
 * getting errors, but forgetting to return and 500ing anyway).
 *
 * Boundaries are mocked: `requireSession` (so `req` is never read beyond
 * `json()`), `resolveAppAccess` (loads the blueprint server-side from the
 * posted `appId`), credentials/manifest/import/expand, and the boundary gate
 * itself. A stub `NextRequest` carries the body via `json()`. The loaded
 * fixture doc is schema-valid (built via `buildDoc`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { requireSession } from "@/lib/auth-utils";
import { importApp, uploadAppMediaBundle } from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { validationError } from "@/lib/commcare/validator/errors";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { POST } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", () => ({ resolveAppAccess: vi.fn() }));
vi.mock("@/lib/db/settings", () => ({
	getCredentialsForUpload: vi.fn(),
}));
vi.mock("@/lib/export/boundaryValidation", () => ({
	prepareExportBoundary: vi.fn(),
}));
// `resolveMediaManifest` is mocked (it reads Postgres + GCS); `assetWirePaths`
// is a pure projection, so give the mock its real behavior — the outcome
// interpreter joins it against the doc to name the unmatched carrier.
vi.mock("@/lib/media/manifest", () => ({
	resolveMediaManifest: vi.fn(),
	assetWirePaths: (manifest: Map<string, { wirePath: string }>) => {
		const out = new Map<string, string>();
		for (const [id, asset] of manifest) out.set(id, asset.wirePath);
		return out;
	},
}));
vi.mock("@/lib/commcare/expander", () => ({ expandDoc: vi.fn() }));
vi.mock("@/lib/commcare/client", async (orig) => ({
	// Keep the real `isValidDomainSlug` (the route calls it); mock the
	// network surfaces.
	...(await orig<typeof import("@/lib/commcare/client")>()),
	importApp: vi.fn(),
	uploadAppMediaBundle: vi.fn(),
}));
// The bulk-zip builder needs real bytes; the route only checks the manifest
// is non-empty before calling it, so a stub buffer keeps it network-free.
vi.mock("@/lib/commcare/multimedia/bulkUploadZip", () => ({
	buildMediaBulkUploadZip: vi.fn(() => Buffer.from("zip")),
}));

const SESSION = { user: { id: "u1" } };
const DOMAIN = "acme";

/**
 * The blueprint `resolveAppAccess` loads server-side. The persistable wire
 * shape (`blueprintDocSchema`) excludes the derived `fieldParent` (the route
 * rebuilds it), so strip it off the in-memory `buildDoc` output.
 */
function validDoc() {
	const { fieldParent: _fieldParent, ...doc } = buildDoc({
		appName: "Vaccine Tracker",
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
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
								label: "Name",
								case_property_on: "patient",
							},
						],
					},
				],
			},
		],
	});
	return doc;
}

/**
 * A schema-valid doc whose `photo` question carries `assetId` as its label
 * image — so the real `walkAssetRefs` (run inside the route's outcome
 * interpreter) resolves an unmatched wire path back to this carrier.
 */
function docWithFieldImage(assetId: string) {
	const { fieldParent: _fieldParent, ...doc } = buildDoc({
		appName: "Vaccine Tracker",
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
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
								label: "Name",
								case_property_on: "patient",
							},
							{
								kind: "text",
								id: "photo",
								label: "Photo",
								label_media: { image: assetId },
							},
						],
					},
				],
			},
		],
	});
	return doc;
}

/** Build the stub request — only `json()` is read after `requireSession`. */
function reqWith(body: unknown) {
	return {
		headers: new Headers(),
		json: async () => body,
		arrayBuffer: async () =>
			new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
	} as unknown as Parameters<typeof POST>[0];
}

/** Mock `resolveAppAccess` to load `doc` for app owner `u1` in `project-1`. */
function loadsDoc(doc: ReturnType<typeof validDoc>) {
	vi.mocked(resolveAppAccess).mockResolvedValue({
		app: { blueprint: doc, owner: "u1", mutation_seq: 12 },
		projectId: "project-1",
		role: "owner",
		actorUserId: "u1",
	} as never);
}

beforeEach(() => {
	vi.mocked(requireSession).mockReset();
	vi.mocked(resolveAppAccess).mockReset();
	vi.mocked(getCredentialsForUpload).mockReset();
	vi.mocked(prepareExportBoundary).mockReset();
	vi.mocked(resolveMediaManifest).mockReset();
	vi.mocked(expandDoc).mockReset();
	vi.mocked(importApp).mockReset();
	vi.mocked(uploadAppMediaBundle).mockReset();

	vi.mocked(requireSession).mockResolvedValue(SESSION as never);
	loadsDoc(validDoc());
	// Successful credential + target-space resolution (`{ ok: true }`) so
	// control passes the credential gate and reaches the media gate. The
	// requested-space authorization lives inside `getCredentialsForUpload`,
	// so a resolved result here means the key can reach the requested space.
	vi.mocked(getCredentialsForUpload).mockResolvedValue({
		ok: true,
		creds: { username: "alice", apiKey: "k" },
		domain: { name: DOMAIN, displayName: "ACME" },
	} as never);
	vi.mocked(resolveMediaManifest).mockResolvedValue(new Map());
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
	vi.mocked(expandDoc).mockReturnValue({} as never);
	vi.mocked(uploadAppMediaBundle).mockResolvedValue({
		matched: 0,
		unmatched: 0,
		unmatchedFiles: [],
		errors: [],
		timedOut: false,
	});
});

describe("POST /api/commcare/upload — boundary gate", () => {
	it("returns 422 with the rule's message (not a 500) when a media ref is stale", async () => {
		vi.mocked(prepareExportBoundary).mockResolvedValueOnce({
			ok: false,
			violations: [
				validationError(
					"MEDIA_ASSET_NOT_READY",
					"field",
					'At the label media on field "case_name" in form "Reg", the media is still uploading.',
					{ formName: "Reg", fieldId: "case_name" },
				),
			],
		} as never);

		const res = await POST(
			reqWith({ domain: DOMAIN, appName: "T", appId: "a1" }),
		);
		const body = (await res.json()) as { error: string; details?: string[] };

		expect(res.status).toBe(422);
		expect(body.details?.[0]).toContain("uploading");
		/* The gate must short-circuit BEFORE import — an invalid app
		 * never reaches HQ. */
		expect(importApp).not.toHaveBeenCalled();
		expect(expandDoc).not.toHaveBeenCalled();
		expect(uploadAppMediaBundle).not.toHaveBeenCalled();
	});

	it("keeps an operational lookup-read failure operational and calls no HQ boundary", async () => {
		vi.mocked(prepareExportBoundary).mockRejectedValueOnce(
			new Error("lookup database unavailable"),
		);

		const res = await POST(
			reqWith({ domain: DOMAIN, appName: "T", appId: "a1" }),
		);
		const body = (await res.json()) as { error: string };

		expect(res.status).toBe(500);
		expect(body.error).not.toContain("isn't ready to upload");
		expect(expandDoc).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
		expect(uploadAppMediaBundle).not.toHaveBeenCalled();
	});

	it("proceeds to import + bulk media upload when the boundary gate is clean", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-1",
			appUrl: "https://hq.example/app",
			warnings: [],
		});
		// A non-empty manifest so the route reaches the media upload (a
		// media-free app skips it — covered below).
		vi.mocked(resolveMediaManifest).mockResolvedValueOnce(
			new Map([["a1", {} as never]]) as never,
		);

		const res = await POST(
			reqWith({ domain: DOMAIN, appName: "T", appId: "a1" }),
		);
		// Drain the response body — an unread `NextResponse.json` stream is a
		// dangling async resource the leak detector flags; reading it also lets
		// us assert the response shape, not just the status.
		const body = (await res.json()) as { appId: string; warnings: string[] };

		expect(res.status).toBe(201);
		expect(body.appId).toBe("hq-1");
		// Default bundle result is a clean match → no warnings.
		expect(body.warnings).toEqual([]);
		// Uploading PUBLISHES the app, so the membership gate is EDIT, not view
		// (a viewer can't push a shared app to HQ).
		expect(resolveAppAccess).toHaveBeenCalledWith("a1", "u1", "edit");
		expect(prepareExportBoundary).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "hq-upload",
				doc: expect.objectContaining({ appName: "Vaccine Tracker" }),
			}),
		);
		expect(importApp).toHaveBeenCalledTimes(1);
		expect(uploadAppMediaBundle).toHaveBeenCalledTimes(1);
	});

	it("skips the media upload for a media-free app", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-2",
			appUrl: "https://hq.example/app",
			warnings: [],
		});
		// Default manifest is empty → no media to ship.
		const res = await POST(
			reqWith({ domain: DOMAIN, appName: "T", appId: "a1" }),
		);
		await res.json();

		expect(res.status).toBe(201);
		expect(uploadAppMediaBundle).not.toHaveBeenCalled();
	});

	it("names the carrier when HQ leaves a form's media unmatched", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-3",
			appUrl: "https://hq.example/app",
			warnings: [],
		});
		// The doc references asset `a1` as a field's label image; the manifest
		// resolves it to a wire path, and HQ reports THAT path unmatched. The
		// route must name where the media lives, not just count it.
		loadsDoc(docWithFieldImage("a1"));
		vi.mocked(resolveMediaManifest).mockResolvedValueOnce(
			new Map([["a1", { wirePath: "commcare/img.png" } as never]]) as never,
		);
		vi.mocked(uploadAppMediaBundle).mockResolvedValueOnce({
			matched: 0,
			unmatched: 1,
			unmatchedFiles: [
				{ path: "commcare/img.png", reason: "Did not match any Image paths." },
			],
			errors: [],
			timedOut: false,
		});

		const res = await POST(
			reqWith({ domain: DOMAIN, appName: "T", appId: "a1" }),
		);
		const body = (await res.json()) as { warnings: string[] };

		expect(res.status).toBe(201);
		const text = body.warnings.join(" ");
		expect(text).toMatch(/couldn't attach/i);
		// The carrier is named — the question id and form, not a bare number.
		expect(text).toContain("photo");
		expect(text).toContain("Reg");
	});

	it("treats a standalone logo as a heads-up, not a failure", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-4",
			appUrl: "https://hq.example/app",
			warnings: [],
		});
		// The logo image is used nowhere else, so HQ reports it unmatched by
		// design (logos aren't in its bulk-match set). The route explains it
		// gently rather than telling the user to "re-upload".
		loadsDoc({ ...validDoc(), logo: "logoA" } as ReturnType<typeof validDoc>);
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

		const res = await POST(
			reqWith({ domain: DOMAIN, appName: "T", appId: "a1" }),
		);
		const body = (await res.json()) as { warnings: string[] };

		expect(res.status).toBe(201);
		const text = body.warnings.join(" ");
		expect(text).toMatch(/logo/i);
		expect(text).toContain("CommCare HQ");
		// The logo case is NOT framed as a failed attach.
		expect(text).not.toMatch(/couldn't attach/i);
	});
});
