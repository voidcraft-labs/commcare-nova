/**
 * `POST /api/compile/json` — media-aware HQ-JSON export.
 *
 * A media-free app returns a plain JSON file (unchanged). An app WITH
 * media returns a `.zip` bundling the media-ON JSON + a CommCare-HQ
 * bulk-upload-format `multimedia.zip` (each media file at
 * `commcare/<hash><ext>`, the path HQ's `process_bulk_upload_zip` maps via
 * `get_form_path` to `jr://file/commcare/<hash><ext>` and matches against
 * the imported app's refs) + a README for the two-step manual import.
 *
 * Boundaries mocked: `requireSession`, `resolveAppAccess` (loads the
 * blueprint server-side), the boundary gate, manifest, and expand.
 */

import AdmZip from "adm-zip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { requireSession } from "@/lib/auth-utils";
import { expandDoc } from "@/lib/commcare/expander";
import { validationError } from "@/lib/commcare/validator/errors";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { asAssetId } from "@/lib/domain/multimedia";
import { collectBoundaryViolations } from "@/lib/media/boundaryValidation";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { POST } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", () => ({ resolveAppAccess: vi.fn() }));
vi.mock("@/lib/media/boundaryValidation", () => ({
	collectBoundaryViolations: vi.fn(),
}));
vi.mock("@/lib/media/manifest", () => ({ resolveMediaManifest: vi.fn() }));
vi.mock("@/lib/commcare/expander", () => ({ expandDoc: vi.fn() }));

const SESSION = { user: { id: "u1" } };

/** The blueprint `resolveAppAccess` loads server-side. */
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

function reqWith(body: unknown) {
	return {
		headers: new Headers(),
		json: async () => body,
		arrayBuffer: async () =>
			new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
	} as unknown as Parameters<typeof POST>[0];
}

/** Mock `resolveAppAccess` to load `doc` for app owner `u1` at the given
 *  committed `mutation_seq`. */
function loadsDoc(doc: ReturnType<typeof validDoc>, mutationSeq = 13) {
	vi.mocked(resolveAppAccess).mockResolvedValue({
		app: { blueprint: doc, owner: "u1", mutation_seq: mutationSeq },
	} as never);
}

beforeEach(() => {
	vi.mocked(requireSession).mockResolvedValue(SESSION as never);
	loadsDoc(validDoc());
	vi.mocked(collectBoundaryViolations).mockResolvedValue([]);
	vi.mocked(resolveMediaManifest).mockResolvedValue(new Map());
	vi.mocked(expandDoc).mockReturnValue({
		doc_type: "Application",
		name: "Vaccine Tracker",
	} as never);
});

describe("POST /api/compile/json", () => {
	it("returns a plain JSON file for a media-free app", async () => {
		const res = await POST(reqWith({ appId: "a1" }));

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.headers.get("content-disposition")).toContain(".json");
		// The seq rides out-of-band in the response header — the JSON body stays
		// the byte-identical HQ-import artifact.
		expect(res.headers.get("x-compiled-at-seq")).toBe("13");
		expect(JSON.parse(await res.text())).toMatchObject({
			name: "Vaccine Tracker",
		});
	});

	it("returns a zip bundling the json + HQ-format multimedia.zip when the app has media", async () => {
		const asset = {
			assetId: asAssetId("a1"),
			wirePath: "commcare/abc123def.png",
			kind: "image" as const,
			mimeType: "image/png",
			contentHash: "abc123def",
			extension: ".png",
			bytes: Buffer.from("PNG-BYTES"),
		};
		vi.mocked(resolveMediaManifest).mockResolvedValue(
			new Map([[asset.assetId, asset]]),
		);

		const res = await POST(reqWith({ appId: "a1" }));

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/zip");
		expect(res.headers.get("content-disposition")).toContain(".zip");
		// The media-bearing shape carries the seq in the same header — the zip
		// body (JSON + multimedia + README) stays byte-identical.
		expect(res.headers.get("x-compiled-at-seq")).toBe("13");

		const bundle = new AdmZip(Buffer.from(await res.arrayBuffer()));
		const names = bundle.getEntries().map((e) => e.entryName);
		// The bundle carries the app json, the media zip, and the README.
		expect(names).toContain("multimedia.zip");
		expect(names).toContain("README.txt");
		const jsonName = names.find((n) => n.endsWith(".json"));
		expect(jsonName).toBeDefined();

		// The bundled JSON is the (media-ON) app source.
		const jsonEntry = bundle.getEntry(jsonName as string);
		if (!jsonEntry) throw new Error("app json entry missing from the bundle");
		expect(JSON.parse(jsonEntry.getData().toString("utf-8"))).toMatchObject({
			name: "Vaccine Tracker",
		});

		// The multimedia.zip is HQ's bulk-upload format: each file lives at
		// `commcare/<hash><ext>` so get_form_path matches the app's refs.
		const mediaZip = new AdmZip(bundle.getEntry("multimedia.zip")?.getData());
		const mediaNames = mediaZip.getEntries().map((e) => e.entryName);
		expect(mediaNames).toEqual(["commcare/abc123def.png"]);
		const pngEntry = mediaZip.getEntry("commcare/abc123def.png");
		if (!pngEntry) throw new Error("png entry missing from multimedia.zip");
		expect(pngEntry.getData().toString()).toBe("PNG-BYTES");
	});

	it("returns 422 (not 500) when a media reference is stale", async () => {
		vi.mocked(collectBoundaryViolations).mockResolvedValueOnce([
			validationError(
				"MEDIA_KIND_MISMATCH",
				"field",
				"The attached asset is an audio file but the slot expects an image.",
				{ formName: "Reg", fieldId: "case_name" },
			),
		]);

		const res = await POST(reqWith({ appId: "a1" }));
		// Read the body (asserting the message + closing the response
		// stream — an unread error body leaks under the async-leak gate).
		const body = (await res.json()) as { error: string; details?: string[] };

		expect(res.status).toBe(422);
		expect(body.error).toContain("isn't ready to export");
		expect(body.details?.[0]).toContain("wrong type");
		// The boundary gate short-circuits before expand.
		expect(expandDoc).not.toHaveBeenCalled();
	});
});
