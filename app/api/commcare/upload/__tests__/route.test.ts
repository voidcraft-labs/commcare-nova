/**
 * `POST /api/commcare/upload` — media-validation gate tests.
 *
 * This route is media-ON: a stale media reference would make `expandDoc`
 * throw `requireAssetRef` → opaque 500. The gate runs media validation
 * first and returns an actionable 400 instead. These tests prove the
 * gate fires AND that the handler returns on it (the un-typed
 * fall-through risk: calling the gate, getting errors, but forgetting to
 * return and 500ing anyway).
 *
 * Boundaries are mocked: `requireSession` (so `req` is never read beyond
 * `json()`), credentials/manifest/import/expand, and the media gate
 * itself. A stub `NextRequest` carries the body via `json()`. The route
 * runs the REAL `blueprintDocSchema`, so the fixture doc is schema-valid
 * (built via `buildDoc`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { requireSession } from "@/lib/auth-utils";
import {
	importApp,
	mediaUploadAssetsFromManifest,
	uploadAppMedia,
} from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { validationError } from "@/lib/commcare/validator/errors";
import { getDecryptedCredentialsWithDomain } from "@/lib/db/settings";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { collectMediaValidationErrors } from "@/lib/media/mediaValidation";
import { POST } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/settings", () => ({
	getDecryptedCredentialsWithDomain: vi.fn(),
}));
vi.mock("@/lib/media/mediaValidation", () => ({
	collectMediaValidationErrors: vi.fn(),
}));
vi.mock("@/lib/media/manifest", () => ({ resolveMediaManifest: vi.fn() }));
vi.mock("@/lib/commcare/expander", () => ({ expandDoc: vi.fn() }));
vi.mock("@/lib/commcare/client", async (orig) => ({
	// Keep the real `isValidDomainSlug` (the route calls it); mock the
	// network surfaces.
	...(await orig<typeof import("@/lib/commcare/client")>()),
	importApp: vi.fn(),
	uploadAppMedia: vi.fn(),
	mediaUploadAssetsFromManifest: vi.fn(() => []),
}));

const SESSION = { user: { id: "u1" } };
const DOMAIN = "acme";

/**
 * A schema-valid blueprint the route's `safeParse` accepts. The
 * persistable wire shape (`blueprintDocSchema`) is strict and excludes
 * `fieldParent` (the route rebuilds it), so strip it off the in-memory
 * `buildDoc` output before sending it as the request body.
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

/** Build the stub request — only `json()` is read after `requireSession`. */
function reqWith(body: unknown) {
	return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
	vi.mocked(requireSession).mockReset();
	vi.mocked(getDecryptedCredentialsWithDomain).mockReset();
	vi.mocked(collectMediaValidationErrors).mockReset();
	vi.mocked(resolveMediaManifest).mockReset();
	vi.mocked(expandDoc).mockReset();
	vi.mocked(importApp).mockReset();
	vi.mocked(uploadAppMedia).mockReset();
	vi.mocked(mediaUploadAssetsFromManifest).mockReset();

	vi.mocked(requireSession).mockResolvedValue(SESSION as never);
	// Creds whose domain matches the request body so control reaches the
	// media gate (which sits after the domain-auth check).
	vi.mocked(getDecryptedCredentialsWithDomain).mockResolvedValue({
		creds: { username: "alice", apiKey: "k" },
		domain: { name: DOMAIN, displayName: "ACME" },
	} as never);
	vi.mocked(collectMediaValidationErrors).mockResolvedValue([]);
	vi.mocked(resolveMediaManifest).mockResolvedValue(new Map());
	vi.mocked(expandDoc).mockReturnValue({} as never);
	vi.mocked(mediaUploadAssetsFromManifest).mockReturnValue([]);
	vi.mocked(uploadAppMedia).mockResolvedValue({ uploaded: 0, failures: [] });
});

describe("POST /api/commcare/upload — media validation gate", () => {
	it("returns 400 with the rule's message (not a 500) when a media ref is stale", async () => {
		vi.mocked(collectMediaValidationErrors).mockResolvedValueOnce([
			validationError(
				"MEDIA_ASSET_NOT_READY",
				"field",
				'At the label media on field "case_name" in form "Reg", the media is still uploading.',
				{ formName: "Reg", fieldId: "case_name" },
			),
		]);

		const res = await POST(
			reqWith({ domain: DOMAIN, appName: "T", doc: validDoc() }),
		);
		const body = (await res.json()) as { error: string; details?: string[] };

		expect(res.status).toBe(400);
		expect(body.details?.[0]).toContain("still uploading");
		/* The gate must short-circuit BEFORE import — a media-invalid app
		 * never reaches HQ. */
		expect(importApp).not.toHaveBeenCalled();
		expect(expandDoc).not.toHaveBeenCalled();
	});

	it("proceeds to import + media upload when media validation is clean", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-1",
			appUrl: "https://hq.example/app",
			warnings: [],
		});

		const res = await POST(
			reqWith({ domain: DOMAIN, appName: "T", doc: validDoc() }),
		);

		expect(res.status).toBe(201);
		expect(collectMediaValidationErrors).toHaveBeenCalledWith(
			expect.objectContaining({ appName: "Vaccine Tracker" }),
			"u1",
		);
		expect(importApp).toHaveBeenCalledTimes(1);
		expect(uploadAppMedia).toHaveBeenCalledTimes(1);
	});
});
