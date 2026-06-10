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
 * Boundaries mocked; the real `blueprintDocSchema` runs against a
 * `buildDoc` fixture.
 */

import AdmZip from "adm-zip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { requireSession } from "@/lib/auth-utils";
import { expandDoc } from "@/lib/commcare/expander";
import { validationError } from "@/lib/commcare/validator/errors";
import { asAssetId } from "@/lib/domain/multimedia";
import { collectBoundaryViolations } from "@/lib/media/boundaryValidation";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { POST } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/media/boundaryValidation", () => ({
	collectBoundaryViolations: vi.fn(),
}));
vi.mock("@/lib/media/manifest", () => ({ resolveMediaManifest: vi.fn() }));
vi.mock("@/lib/commcare/expander", () => ({ expandDoc: vi.fn() }));

const SESSION = { user: { id: "u1" } };

/** A schema-valid blueprint the route's `safeParse` accepts. */
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
	return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
	vi.mocked(requireSession).mockResolvedValue(SESSION as never);
	vi.mocked(collectBoundaryViolations).mockResolvedValue([]);
	vi.mocked(resolveMediaManifest).mockResolvedValue(new Map());
	vi.mocked(expandDoc).mockReturnValue({
		doc_type: "Application",
		name: "Vaccine Tracker",
	} as never);
});

describe("POST /api/compile/json", () => {
	it("returns a plain JSON file for a media-free app", async () => {
		const res = await POST(reqWith({ doc: validDoc() }));

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.headers.get("content-disposition")).toContain(".json");
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

		const res = await POST(reqWith({ doc: validDoc() }));

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/zip");
		expect(res.headers.get("content-disposition")).toContain(".zip");

		const bundle = new AdmZip(Buffer.from(await res.arrayBuffer()));
		const names = bundle.getEntries().map((e) => e.entryName);
		// The bundle carries the app json, the media zip, and the README.
		expect(names).toContain("multimedia.zip");
		expect(names).toContain("README.txt");
		const jsonName = names.find((n) => n.endsWith(".json"));
		expect(jsonName).toBeDefined();

		// The bundled JSON is the (media-ON) app source.
		const jsonEntry = bundle.getEntry(jsonName as string);
		expect(
			JSON.parse((jsonEntry?.getData() as Buffer).toString("utf-8")),
		).toMatchObject({ name: "Vaccine Tracker" });

		// The multimedia.zip is HQ's bulk-upload format: each file lives at
		// `commcare/<hash><ext>` so get_form_path matches the app's refs.
		const mediaZip = new AdmZip(bundle.getEntry("multimedia.zip")?.getData());
		const mediaNames = mediaZip.getEntries().map((e) => e.entryName);
		expect(mediaNames).toEqual(["commcare/abc123def.png"]);
		expect(
			(
				mediaZip.getEntry("commcare/abc123def.png")?.getData() as Buffer
			).toString(),
		).toBe("PNG-BYTES");
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

		const res = await POST(reqWith({ doc: validDoc() }));
		// Read the body (asserting the message + closing the response
		// stream — an unread error body leaks under the async-leak gate).
		const body = (await res.json()) as { error: string; details?: string[] };

		expect(res.status).toBe(422);
		expect(body.error).toContain("isn't ready to export");
		expect(body.details?.[0]).toContain("audio file");
		// The boundary gate short-circuits before expand.
		expect(expandDoc).not.toHaveBeenCalled();
	});
});
