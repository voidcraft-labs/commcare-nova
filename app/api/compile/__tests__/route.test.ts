/**
 * `POST /api/compile` (.ccz compile): boundary gate + inline-return tests.
 *
 * This route is media-ON (the archive bundles media bytes) and boundary-
 * gated: any validator finding returns an actionable 422 before expand
 * (a stale media reference would otherwise make `expandDoc` throw
 * `requireAssetRef` → 500). Tests prove the gate fires AND that the handler returns on it
 * (no fall-through into expand/compile), and that a clean compile returns
 * the archive bytes inline (octet-stream) rather than a download URL.
 *
 * Boundaries mocked: `requireSession`, `resolveAppAccess` (loads the
 * blueprint server-side), the boundary gate, manifest, expand, and compile.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { requireSession } from "@/lib/auth-utils";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import {
	decodeHqFeatureFlagReport,
	HQ_FEATURE_FLAG_REPORT_HEADER,
} from "@/lib/commcare/featureFlags";
import { validationError } from "@/lib/commcare/validator/errors";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { attachmentDeploymentTargetFor } from "@/lib/deployment/attachmentSpace";
import { proseText } from "@/lib/domain/prose";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { resolveMediaManifest } from "@/lib/media/manifest";
import {
	decodeExportAdvisories,
	EXPORT_ADVISORY_HEADER,
} from "@/lib/publish/exportAdvisories";
import { POST } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", () => ({ resolveAppAccess: vi.fn() }));
vi.mock("@/lib/export/boundaryValidation", () => ({
	prepareExportBoundary: vi.fn(),
}));
vi.mock("@/lib/media/manifest", () => ({ resolveMediaManifest: vi.fn() }));
vi.mock("@/lib/deployment/attachmentSpace", () => ({
	attachmentDeploymentTargetFor: vi.fn(),
}));
vi.mock("@/lib/commcare/expander", () => ({ expandDoc: vi.fn() }));
vi.mock("@/lib/commcare/compiler", () => ({ compileCcz: vi.fn() }));

const SESSION = { user: { id: "u1" } };

/**
 * The blueprint `resolveAppAccess` loads server-side. The persistable wire
 * shape excludes the derived `fieldParent` (the route rebuilds it), so strip
 * it off the in-memory `buildDoc` output.
 */
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

/** An app whose photo question saves a link to the file it captures. */
function docWithAttachmentLink() {
	const doc = validDoc();
	const moduleUuid = doc.moduleOrder[0];
	if (!moduleUuid) throw new Error("fixture module missing");
	const formUuid = doc.formOrder[moduleUuid][0];
	const photo = buildDoc({
		modules: [
			{
				name: "M",
				forms: [
					{
						name: "F",
						type: "survey",
						fields: [
							{
								kind: "image",
								id: "photo",
								label: proseText("Photo"),
								caseWrite: {
									caseType: "patient",
									property: "photo_url",
									mode: "url",
								},
							},
						],
					},
				],
			},
		],
	});
	const [photoUuid] = Object.keys(photo.fields);
	doc.fields[photoUuid] = photo.fields[photoUuid];
	doc.fieldOrder[formUuid].push(photoUuid);
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

/** Mock `resolveAppAccess` to load `doc` for app owner `u1` in `project-1`
 *  at the given committed `mutation_seq`. */
function loadsDoc(doc: ReturnType<typeof validDoc>, mutationSeq = 42) {
	vi.mocked(resolveAppAccess).mockResolvedValue({
		app: { blueprint: doc, owner: "u1", mutation_seq: mutationSeq },
		projectId: "project-1",
		role: "owner",
		actorUserId: "u1",
	} as never);
}

beforeEach(() => {
	vi.mocked(requireSession).mockReset();
	vi.mocked(resolveAppAccess).mockReset();
	vi.mocked(prepareExportBoundary).mockReset();
	vi.mocked(resolveMediaManifest).mockReset();
	vi.mocked(attachmentDeploymentTargetFor).mockReset();
	vi.mocked(expandDoc).mockReset();
	vi.mocked(compileCcz).mockReset();

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
	vi.mocked(expandDoc).mockReturnValue({} as never);
	vi.mocked(compileCcz).mockReturnValue(Buffer.from("ccz-bytes"));
});

describe("POST /api/compile — boundary gate", () => {
	it("returns 422 with the rule's message (not a 500) when a media ref is stale", async () => {
		vi.mocked(prepareExportBoundary).mockResolvedValueOnce({
			ok: false,
			violations: [
				validationError(
					"MEDIA_KIND_MISMATCH",
					"field",
					'At the label media on field "case_name" in form "Reg", the attached asset is an audio file but the slot expects an image.',
					{ formName: "Reg", fieldId: "case_name" },
				),
			],
		} as never);

		const res = await POST(reqWith({ appId: "a1" }));
		const body = (await res.json()) as { error: string; details?: string[] };

		expect(res.status).toBe(422);
		expect(body.details?.[0]).toContain("wrong type");
		/* The gate short-circuits BEFORE expand + compile: neither runs
		 * on a media-invalid doc. */
		expect(expandDoc).not.toHaveBeenCalled();
		expect(compileCcz).not.toHaveBeenCalled();
	});

	it("keeps an operational lookup-read failure operational and emits nothing", async () => {
		vi.mocked(prepareExportBoundary).mockRejectedValueOnce(
			new Error("lookup database unavailable"),
		);

		const res = await POST(reqWith({ appId: "a1" }));
		const body = (await res.json()) as { error: string };

		expect(res.status).toBe(500);
		expect(body.error).not.toContain("isn't ready to compile");
		expect(expandDoc).not.toHaveBeenCalled();
		expect(compileCcz).not.toHaveBeenCalled();
	});
});

describe("POST /api/compile — inline archive return", () => {
	it("returns the compiled .ccz bytes inline (octet-stream) when the boundary gate is clean", async () => {
		const res = await POST(reqWith({ appId: "a1" }));

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		// Filename derives from the (sanitized) app name; the bytes ARE the
		// compiled archive: there is no storage round-trip or download URL.
		expect(res.headers.get("content-disposition")).toBe(
			'attachment; filename="Vaccine Tracker.ccz"',
		);
		const bytes = Buffer.from(await res.arrayBuffer());
		expect(bytes.toString()).toBe("ccz-bytes");
		expect(res.headers.get("content-length")).toBe(String(bytes.length));

		expect(prepareExportBoundary).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "ccz",
				doc: expect.objectContaining({ appName: "Vaccine Tracker" }),
			}),
		);
		expect(compileCcz).toHaveBeenCalledTimes(1);
	});

	it("threads the loaded `mutation_seq` into compileCcz as `compiledAtSeq`", async () => {
		loadsDoc(validDoc(), 99);

		const res = await POST(reqWith({ appId: "a1" }));
		expect(res.status).toBe(200);
		// Read the body so the response stream closes (async-leak gate).
		await res.arrayBuffer();

		// The seq stamps the archive's `cc-content-version` (verified against a
		// real profile in the compiler unit test); here we assert the route
		// forwards the loaded `mutation_seq` into the compile options.
		expect(compileCcz).toHaveBeenCalledWith(
			expect.anything(),
			"Vaccine Tracker",
			expect.anything(),
			expect.objectContaining({ compiledAtSeq: 99 }),
		);
	});

	it("returns unverified destination requirements without changing CCZ bytes", async () => {
		loadsDoc(docWithCaseSearch());
		const res = await POST(reqWith({ appId: "a1" }));
		const report = decodeHqFeatureFlagReport(
			res.headers.get(HQ_FEATURE_FLAG_REPORT_HEADER),
		);
		expect(report?.verification).toBe("not_checked");
		expect(report?.missing_flags).toEqual([]);
		expect(report?.required_flags).toEqual([
			expect.objectContaining({ slug: "search_claim" }),
		]);
		expect(report?.message).toContain("support@dimagi.com");
		expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("ccz-bytes");
	});
});
/**
 * A download carries no target of its own, so whatever the deployment record
 * resolves has to survive all the way to the emitter. It travels through the
 * export boundary and out the other side, and the failure mode if a hop drops
 * it is invisible: the archive still compiles, still downloads, and quietly
 * stops recording where its photos went.
 */
describe("POST /api/compile — attachment link target", () => {
	it("hands the emitter nothing while no project space holds the app", async () => {
		const res = await POST(reqWith({ appId: "a1" }));
		// Read the body so the response stream closes (async-leak gate).
		await res.arrayBuffer();

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
		await res.arrayBuffer();

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

	it("says what the file could not carry, without changing the bytes", async () => {
		loadsDoc(docWithAttachmentLink());

		const res = await POST(reqWith({ appId: "a1" }));
		const advisories = decodeExportAdvisories(
			res.headers.get(EXPORT_ADVISORY_HEADER),
		);

		expect(advisories[0]?.id).toBe("attachment_links_without_target");
		expect(advisories[0]?.message).toContain("photo_url");
		// The advisory rides beside the archive. It is not a refusal, and the
		// bytes are exactly what a clean compile returns.
		expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("ccz-bytes");
		expect(res.status).toBe(200);
	});

	it("stays quiet on an app with no attachment links", async () => {
		const res = await POST(reqWith({ appId: "a1" }));
		const header = res.headers.get(EXPORT_ADVISORY_HEADER);
		await res.arrayBuffer();

		expect(decodeExportAdvisories(header)).toEqual([]);
	});
});
