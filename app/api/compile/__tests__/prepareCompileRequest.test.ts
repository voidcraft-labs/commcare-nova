/**
 * `prepareCompileRequest` — the shared front half of the two export routes
 * (`/api/compile` + `/api/compile/json`). The route tests cover its boundary-
 * gate and success paths end-to-end; this file covers the failure boundaries
 * neither route test reaches — `doc is required`, `Invalid doc`, and the
 * boundary-rejection envelope — because a regression in any now breaks BOTH
 * endpoints at once (that's the whole reason the preamble was extracted into
 * one place).
 *
 * Boundaries mocked: `requireSession`, the boundary gate, and the manifest.
 * The real `blueprintDocSchema` runs against a `buildDoc` fixture.
 */

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { ApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { validationError } from "@/lib/commcare/validator/errors";
import { collectBoundaryViolations } from "@/lib/media/boundaryValidation";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { prepareCompileRequest } from "../prepareCompileRequest";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/media/boundaryValidation", () => ({
	collectBoundaryViolations: vi.fn(),
}));
vi.mock("@/lib/media/manifest", () => ({ resolveMediaManifest: vi.fn() }));

const SESSION = { user: { id: "u1" } };

/** A schema-valid blueprint with the route-rebuilt `fieldParent` stripped off. */
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
	} as unknown as NextRequest;
}

beforeEach(() => {
	vi.mocked(requireSession).mockResolvedValue(SESSION as never);
	vi.mocked(collectBoundaryViolations).mockResolvedValue([]);
	vi.mocked(resolveMediaManifest).mockResolvedValue(new Map());
});

describe("prepareCompileRequest", () => {
	it("throws a 400 ApiError when the body carries no doc", async () => {
		const err = await prepareCompileRequest(reqWith({}), {
			boundaryErrorVerb: "compile",
		}).catch((e) => e);

		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(400);
		expect((err as ApiError).message).toBe("doc is required");
		// The schema parse + gate I/O must not run on a missing doc.
		expect(collectBoundaryViolations).not.toHaveBeenCalled();
		expect(resolveMediaManifest).not.toHaveBeenCalled();
	});

	it("throws a 400 ApiError with per-issue details for a schema-invalid doc", async () => {
		const err = await prepareCompileRequest(reqWith({ doc: { appName: 42 } }), {
			boundaryErrorVerb: "compile",
		}).catch((e) => e);

		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(400);
		expect((err as ApiError).message).toBe("Invalid doc");
		// Each issue is surfaced as a `path: message` detail line, not swallowed.
		expect((err as ApiError).details.length).toBeGreaterThan(0);
		expect((err as ApiError).details[0]).toContain(":");
		expect(collectBoundaryViolations).not.toHaveBeenCalled();
	});

	it("throws a 422 carrying the caller's verb + per-finding details on a boundary rejection", async () => {
		vi.mocked(collectBoundaryViolations).mockResolvedValueOnce([
			validationError(
				"EMPTY_FORM",
				"form",
				'"Reg" in "Patients" has no fields.',
				{ formName: "Reg" },
			),
			validationError("MEDIA_KIND_MISMATCH", "field", "stale ref", {
				formName: "Reg",
				fieldId: "case_name",
			}),
		]);

		const compileErr = await prepareCompileRequest(
			reqWith({ doc: validDoc() }),
			{ boundaryErrorVerb: "compile" },
		).catch((e) => e);
		expect(compileErr).toBeInstanceOf(ApiError);
		expect((compileErr as ApiError).status).toBe(422);
		expect((compileErr as ApiError).message).toBe(
			"This app isn't ready to compile — fix the issues below, then try again.",
		);
		// One detail line per finding, rendered in the CONCISE builder
		// voice (`userFacingError`) — not the verbose validator message the
		// SA reads. Each line names the finding's entity, no wire detail.
		expect((compileErr as ApiError).details).toEqual([
			'"Reg" doesn\'t have any fields yet. Add at least one.',
			"An attached file is the wrong type for its slot. Swap it out, or clear the slot.",
		]);

		vi.mocked(collectBoundaryViolations).mockResolvedValueOnce([
			validationError("MEDIA_KIND_MISMATCH", "field", "stale ref", {
				formName: "Reg",
				fieldId: "case_name",
			}),
		]);
		const exportErr = await prepareCompileRequest(
			reqWith({ doc: validDoc() }),
			{
				boundaryErrorVerb: "export",
			},
		).catch((e) => e);
		expect((exportErr as ApiError).message).toBe(
			"This app isn't ready to export — fix the issues below, then try again.",
		);

		// The gate short-circuits before manifest resolution either way.
		expect(resolveMediaManifest).not.toHaveBeenCalled();
	});

	it("returns the parsed doc (with fieldParent rebuilt) + manifest on success", async () => {
		const result = await prepareCompileRequest(reqWith({ doc: validDoc() }), {
			boundaryErrorVerb: "compile",
		});

		expect(result.doc.appName).toBe("Vaccine Tracker");
		// `fieldParent` is the derived index the routes' expand/compile walk needs.
		expect(result.doc.fieldParent).toBeDefined();
		expect(result.assets.size).toBe(0);
		expect(resolveMediaManifest).toHaveBeenCalledWith(
			expect.objectContaining({ appName: "Vaccine Tracker" }),
			"u1",
			{ withBytes: true },
		);
	});
});
