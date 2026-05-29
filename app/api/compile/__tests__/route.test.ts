/**
 * `POST /api/compile` (.ccz download) — media-validation gate tests.
 *
 * This route is media-ON (the archive bundles media bytes): a stale
 * media reference would make `expandDoc` throw `requireAssetRef` → 500.
 * The gate runs media validation first and returns an actionable 400
 * instead. Tests prove the gate fires AND that the handler returns on it
 * (no fall-through into expand/compile).
 *
 * Boundaries mocked: `requireSession`, the media gate, manifest, expand,
 * compile, and the ccz store. The route runs the REAL `blueprintDocSchema`
 * (fixture built via `buildDoc`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { requireSession } from "@/lib/auth-utils";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { validationError } from "@/lib/commcare/validator/errors";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { collectMediaValidationErrors } from "@/lib/media/mediaValidation";
import { saveCcz } from "@/lib/store";
import { POST } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/media/mediaValidation", () => ({
	collectMediaValidationErrors: vi.fn(),
}));
vi.mock("@/lib/media/manifest", () => ({ resolveMediaManifest: vi.fn() }));
vi.mock("@/lib/commcare/expander", () => ({ expandDoc: vi.fn() }));
vi.mock("@/lib/commcare/compiler", () => ({ compileCcz: vi.fn() }));
vi.mock("@/lib/store", () => ({ saveCcz: vi.fn() }));

const SESSION = { user: { id: "u1" } };

/**
 * A schema-valid blueprint the route's `safeParse` accepts. The strict
 * persistable schema excludes `fieldParent` (the route rebuilds it), so
 * strip it off the in-memory `buildDoc` output before sending as body.
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
	return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
	vi.mocked(requireSession).mockReset();
	vi.mocked(collectMediaValidationErrors).mockReset();
	vi.mocked(resolveMediaManifest).mockReset();
	vi.mocked(expandDoc).mockReset();
	vi.mocked(compileCcz).mockReset();
	vi.mocked(saveCcz).mockReset();

	vi.mocked(requireSession).mockResolvedValue(SESSION as never);
	vi.mocked(collectMediaValidationErrors).mockResolvedValue([]);
	vi.mocked(resolveMediaManifest).mockResolvedValue(new Map());
	vi.mocked(expandDoc).mockReturnValue({} as never);
	vi.mocked(compileCcz).mockReturnValue(Buffer.from("ccz"));
	vi.mocked(saveCcz).mockResolvedValue(undefined as never);
});

describe("POST /api/compile — media validation gate", () => {
	it("returns 400 with the rule's message (not a 500) when a media ref is stale", async () => {
		vi.mocked(collectMediaValidationErrors).mockResolvedValueOnce([
			validationError(
				"MEDIA_KIND_MISMATCH",
				"field",
				'At the label media on field "case_name" in form "Reg", the attached asset is an audio file but the slot expects an image.',
				{ formName: "Reg", fieldId: "case_name" },
			),
		]);

		const res = await POST(reqWith({ doc: validDoc() }));
		const body = (await res.json()) as { error: string; details?: string[] };

		expect(res.status).toBe(400);
		expect(body.details?.[0]).toContain("audio file");
		/* The gate short-circuits BEFORE expand + compile — neither runs
		 * on a media-invalid doc. */
		expect(expandDoc).not.toHaveBeenCalled();
		expect(compileCcz).not.toHaveBeenCalled();
	});

	it("proceeds to expand + compile when media validation is clean", async () => {
		const res = await POST(reqWith({ doc: validDoc() }));
		const body = (await res.json()) as {
			success?: boolean;
			compileId?: string;
		};

		expect(res.status).toBe(200);
		expect(body.success).toBe(true);
		expect(collectMediaValidationErrors).toHaveBeenCalledWith(
			expect.objectContaining({ appName: "Vaccine Tracker" }),
			"u1",
		);
		expect(compileCcz).toHaveBeenCalledTimes(1);
	});
});
