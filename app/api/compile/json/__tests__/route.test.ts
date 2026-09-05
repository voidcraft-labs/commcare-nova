/**
 * `POST /api/compile/json`: media-aware HQ-JSON export.
 *
 * An app that depends on nothing outside itself returns a plain JSON file
 * (unchanged). An app WITH media returns a `.zip` bundling the media-ON
 * JSON + a CommCare-HQ bulk-upload-format `multimedia.zip` (each media
 * file at `commcare/<hash><ext>`, the path HQ's `process_bulk_upload_zip`
 * maps via `get_form_path` to `jr://file/commcare/<hash><ext>` and matches
 * against the imported app's refs) + a README for the manual import. An
 * app that reads lookup tables ships the fixapi workbook the same way, so
 * a hand-imported app carries the data a directly-uploaded one is pushed.
 *
 * Boundaries mocked: `requireSession`, `resolveAppAccess` (loads the
 * blueprint server-side), the boundary gate, manifest, and expand.
 */

import AdmZip from "adm-zip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { requireSession } from "@/lib/auth-utils";
import { expandDoc } from "@/lib/commcare/expander";
import {
	decodeProjectSpaceCompatibilityReport,
	PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER,
} from "@/lib/commcare/projectSpaceCompatibility";
import { validationError } from "@/lib/commcare/validator/errors";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { attachmentDeploymentTargetFor } from "@/lib/deployment/attachmentSpace";
import { proseText } from "@/lib/domain/prose";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { POST } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", () => ({ resolveAppAccess: vi.fn() }));
vi.mock("@/lib/export/boundaryValidation", () => ({
	prepareExportBoundary: vi.fn(),
}));
vi.mock("@/lib/media/manifest", () => ({ resolveMediaManifest: vi.fn() }));
vi.mock("@/lib/commcare/expander", () => ({ expandDoc: vi.fn() }));
vi.mock("@/lib/deployment/attachmentSpace", () => ({
	attachmentDeploymentTargetFor: vi.fn(),
}));

const SESSION = { user: { id: "u1" } };

/** The blueprint `resolveAppAccess` loads server-side. */
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

function docWithCaseSearch() {
	const doc = validDoc();
	const moduleUuid = doc.moduleOrder[0];
	if (!moduleUuid) throw new Error("fixture module missing");
	doc.modules[moduleUuid].caseSearchConfig = {};
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
		projectId: "project-1",
		role: "owner",
		actorUserId: "u1",
	} as never);
}

beforeEach(() => {
	vi.mocked(requireSession).mockResolvedValue(SESSION as never);
	loadsDoc(validDoc());
	vi.mocked(resolveMediaManifest).mockResolvedValue(new Map());
	// No project space holds the fixture app, which is the ordinary state
	// for a download: an attachment link has nowhere to resolve.
	vi.mocked(attachmentDeploymentTargetFor).mockResolvedValue({ kind: "none" });
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
	vi.mocked(expandDoc).mockReturnValue({
		doc_type: "Application",
		name: "Vaccine Tracker",
	} as never);
});

describe("POST /api/compile/json", () => {
	it("returns a plain JSON file for a media-free app", async () => {
		const res = await POST(reqWith({ appId: "a1", server: "production" }));

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.headers.get("content-disposition")).toContain(".json");
		// The seq rides out-of-band in the response header: the JSON body stays
		// the byte-identical HQ-import artifact.
		expect(res.headers.get("x-compiled-at-seq")).toBe("13");
		expect(JSON.parse(await res.text())).toMatchObject({
			name: "Vaccine Tracker",
		});
		expect(prepareExportBoundary).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "hq-json" }),
		);
		expect(
			decodeProjectSpaceCompatibilityReport(
				res.headers.get(PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER),
			)?.status,
		).toBe("not_needed");
	});

	it("returns a zip bundling the json + HQ-format multimedia.zip when the app has media", async () => {
		const asset = {
			assetId: testMediaAssetId("a1"),
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

		const res = await POST(reqWith({ appId: "a1", server: "production" }));

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/zip");
		expect(res.headers.get("content-disposition")).toContain(".zip");
		// The media-bearing shape carries the seq in the same header, the zip
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

	it("ships the fixapi workbook beside the json for a media-free app", async () => {
		/* The three emission paths offer the same thing: the `.ccz` embeds
		 * its tables, the direct upload pushes them, and a hand-imported app
		 * gets the workbook to upload itself. Media-free here on purpose —
		 * the zip is what carries a COMPANION, and media is only one kind. */
		vi.mocked(prepareExportBoundary).mockResolvedValueOnce({
			ok: true,
			prepared: {
				mode: "hq-json",
				doc: validDoc(),
				compiledAtSeq: 13,
				assets: new Map(),
				lookupTargets: { tableIds: [], columns: [] },
				lookupSnapshot: undefined,
				lookupContext: { kind: "unavailable" },
				lookupWorkbook: {
					bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
					tables: [
						{
							tableId: "018f0000-0000-7000-8000-000000000001",
							tag: "districts",
							columnCount: 2,
							rowCount: 3,
						},
					],
					totalWorkbookRows: 6,
				},
			},
		} as never);

		const res = await POST(reqWith({ appId: "a1", server: "production" }));

		expect(res.headers.get("content-type")).toContain("application/zip");
		const bundle = new AdmZip(Buffer.from(await res.arrayBuffer()));
		const names = bundle.getEntries().map((e) => e.entryName);
		expect(names).toContain("lookup-tables.xlsx");
		expect(names).toContain("README.txt");
		/* No media, so no empty multimedia.zip and no step about one. */
		expect(names).not.toContain("multimedia.zip");
		expect(bundle.getEntry("lookup-tables.xlsx")?.getData()).toEqual(
			Buffer.from([0x50, 0x4b, 0x03, 0x04]),
		);
		const readme = bundle.readAsText("README.txt");
		expect(readme).toContain("=== 1. Upload the lookup tables ===");
		expect(readme).toContain("districts");
	});

	it("returns unchecked destination compatibility as response metadata", async () => {
		loadsDoc(docWithCaseSearch());
		const res = await POST(reqWith({ appId: "a1", server: "production" }));
		const report = decodeProjectSpaceCompatibilityReport(
			res.headers.get(PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER),
		);
		expect(report?.status).toBe("not_checked");
		expect(report?.blockers).toEqual([]);
		expect(report?.required_capabilities).toEqual([
			expect.objectContaining({ id: "case-search", state: "not_checked" }),
		]);
		expect(JSON.parse(await res.text())).toMatchObject({
			name: "Vaccine Tracker",
		});
	});

	it("returns 422 (not 500) when a media reference is stale", async () => {
		vi.mocked(prepareExportBoundary).mockResolvedValueOnce({
			ok: false,
			violations: [
				validationError(
					"MEDIA_KIND_MISMATCH",
					"field",
					"The attached asset is an audio file but the slot expects an image.",
					{ formName: "Reg", fieldId: "case_name" },
				),
			],
		} as never);

		const res = await POST(reqWith({ appId: "a1", server: "production" }));
		// Read the body (asserting the message + closing the response
		// stream: an unread error body leaks under the async-leak gate).
		const body = (await res.json()) as { error: string; details?: string[] };

		expect(res.status).toBe(422);
		expect(body.error).toContain("isn't ready to export");
		expect(body.details?.[0]).toContain("wrong type");
		// The boundary gate short-circuits before expand.
		expect(expandDoc).not.toHaveBeenCalled();
	});

	it("keeps an operational lookup-read failure operational and emits nothing", async () => {
		vi.mocked(prepareExportBoundary).mockRejectedValueOnce(
			new Error("lookup database unavailable"),
		);

		const res = await POST(reqWith({ appId: "a1", server: "production" }));
		const body = (await res.json()) as { error: string };

		expect(res.status).toBe(500);
		expect(body.error).not.toContain("isn't ready to export");
		expect(expandDoc).not.toHaveBeenCalled();
	});
});
/**
 * A download carries no target of its own, so whatever the deployment record
 * resolves has to survive all the way to the emitter. It travels through the
 * export boundary and out the other side, and the failure mode if a hop drops
 * it is invisible: the archive still compiles, still downloads, and quietly
 * stops recording where its photos went.
 */
describe("POST /api/compile/json — attachment link target", () => {
	it("hands the emitter nothing while no project space holds the app", async () => {
		const res = await POST(reqWith({ appId: "a1", server: "production" }));
		// Read the body so the response stream closes (async-leak gate).
		await res.json();

		expect(expandDoc).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ attachmentTarget: null }),
		);
	});

	it("hands the emitter the origin and project space that do", async () => {
		vi.mocked(attachmentDeploymentTargetFor).mockResolvedValue({
			kind: "known",
			target: { server: "india", domain: "acme" },
		});

		const res = await POST(reqWith({ appId: "a1" }));
		// Read the body so the response stream closes (async-leak gate).
		await res.json();

		expect(expandDoc).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				attachmentTarget: {
					origin: "https://india.commcarehq.org",
					domain: "acme",
				},
			}),
		);
	});
});
