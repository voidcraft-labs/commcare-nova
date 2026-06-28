/**
 * `POST /api/compile` (.ccz compile) — boundary gate + inline-return tests.
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
import { validationError } from "@/lib/commcare/validator/errors";
import { resolveAppAccess } from "@/lib/db/appAccess";
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

/** Mock `resolveAppAccess` to load `doc` for app owner `u1`. */
function loadsDoc(doc: ReturnType<typeof validDoc>) {
	vi.mocked(resolveAppAccess).mockResolvedValue({
		app: { blueprint: doc, owner: "u1" },
	} as never);
}

beforeEach(() => {
	vi.mocked(requireSession).mockReset();
	vi.mocked(resolveAppAccess).mockReset();
	vi.mocked(collectBoundaryViolations).mockReset();
	vi.mocked(resolveMediaManifest).mockReset();
	vi.mocked(expandDoc).mockReset();
	vi.mocked(compileCcz).mockReset();

	vi.mocked(requireSession).mockResolvedValue(SESSION as never);
	loadsDoc(validDoc());
	vi.mocked(collectBoundaryViolations).mockResolvedValue([]);
	vi.mocked(resolveMediaManifest).mockResolvedValue(new Map());
	vi.mocked(expandDoc).mockReturnValue({} as never);
	vi.mocked(compileCcz).mockReturnValue(Buffer.from("ccz-bytes"));
});

describe("POST /api/compile — boundary gate", () => {
	it("returns 422 with the rule's message (not a 500) when a media ref is stale", async () => {
		vi.mocked(collectBoundaryViolations).mockResolvedValueOnce([
			validationError(
				"MEDIA_KIND_MISMATCH",
				"field",
				'At the label media on field "case_name" in form "Reg", the attached asset is an audio file but the slot expects an image.',
				{ formName: "Reg", fieldId: "case_name" },
			),
		]);

		const res = await POST(reqWith({ appId: "a1" }));
		const body = (await res.json()) as { error: string; details?: string[] };

		expect(res.status).toBe(422);
		expect(body.details?.[0]).toContain("wrong type");
		/* The gate short-circuits BEFORE expand + compile — neither runs
		 * on a media-invalid doc. */
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
		// compiled archive — there is no storage round-trip or download URL.
		expect(res.headers.get("content-disposition")).toBe(
			'attachment; filename="Vaccine Tracker.ccz"',
		);
		const bytes = Buffer.from(await res.arrayBuffer());
		expect(bytes.toString()).toBe("ccz-bytes");
		expect(res.headers.get("content-length")).toBe(String(bytes.length));

		expect(collectBoundaryViolations).toHaveBeenCalledWith(
			expect.objectContaining({ appName: "Vaccine Tracker" }),
			"u1",
		);
		expect(compileCcz).toHaveBeenCalledTimes(1);
	});
});
