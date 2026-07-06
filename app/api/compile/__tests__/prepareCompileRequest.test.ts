/**
 * `prepareCompileRequest` — the shared front half of the two export routes
 * (`/api/compile` + `/api/compile/json`). The route tests cover its boundary-
 * gate and success paths end-to-end; this file covers the failure boundaries
 * neither route test reaches — `appId is required` and the boundary-rejection
 * envelope — because a regression in any now breaks BOTH endpoints at once
 * (that's the whole reason the preamble was extracted into one place).
 *
 * The client sends only `{ appId }`; the blueprint loads server-side via
 * `resolveAppAccess` (membership gate). Boundaries mocked: `requireSession`,
 * `resolveAppAccess`, the boundary gate, and the manifest.
 */

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { ApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { validationError } from "@/lib/commcare/validator/errors";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { collectBoundaryViolations } from "@/lib/media/boundaryValidation";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { prepareCompileRequest } from "../prepareCompileRequest";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", () => ({ resolveAppAccess: vi.fn() }));
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
		arrayBuffer: async () =>
			new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
	} as unknown as NextRequest;
}

/** Mock `resolveAppAccess` to load `doc` for app owner `u1` in `project-1`
 *  at the given committed `mutation_seq`. */
function loadsDoc(doc: ReturnType<typeof validDoc>, mutationSeq = 7) {
	vi.mocked(resolveAppAccess).mockResolvedValue({
		app: { blueprint: doc, owner: "u1", mutation_seq: mutationSeq },
		projectId: "project-1",
	} as never);
}

beforeEach(() => {
	vi.mocked(requireSession).mockResolvedValue(SESSION as never);
	vi.mocked(collectBoundaryViolations).mockResolvedValue([]);
	vi.mocked(resolveMediaManifest).mockResolvedValue(new Map());
	loadsDoc(validDoc());
});

describe("prepareCompileRequest", () => {
	it("throws a 400 ApiError when the body carries no appId", async () => {
		const err = await prepareCompileRequest(reqWith({}), {
			boundaryErrorVerb: "compile",
		}).catch((e) => e);

		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(400);
		expect((err as ApiError).message).toBe("appId is required");
		// No load, gate, or manifest I/O on a missing appId.
		expect(resolveAppAccess).not.toHaveBeenCalled();
		expect(collectBoundaryViolations).not.toHaveBeenCalled();
		expect(resolveMediaManifest).not.toHaveBeenCalled();
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

		const compileErr = await prepareCompileRequest(reqWith({ appId: "a1" }), {
			boundaryErrorVerb: "compile",
		}).catch((e) => e);
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
		const exportErr = await prepareCompileRequest(reqWith({ appId: "a1" }), {
			boundaryErrorVerb: "export",
		}).catch((e) => e);
		expect((exportErr as ApiError).message).toBe(
			"This app isn't ready to export — fix the issues below, then try again.",
		);

		// The gate short-circuits before manifest resolution either way.
		expect(resolveMediaManifest).not.toHaveBeenCalled();
	});

	it("returns the loaded doc (with fieldParent rebuilt) + manifest on success", async () => {
		const result = await prepareCompileRequest(reqWith({ appId: "a1" }), {
			boundaryErrorVerb: "compile",
		});

		expect(result.doc.appName).toBe("Vaccine Tracker");
		// `fieldParent` is the derived index the routes' expand/compile walk needs.
		expect(result.doc.fieldParent).toBeDefined();
		expect(result.assets.size).toBe(0);
		// `compiledAtSeq` is the `mutation_seq` off the SAME loaded snapshot as
		// the blueprint — each export names the exact document version it emitted.
		expect(result.compiledAtSeq).toBe(7);
		// Media resolves at the app's PROJECT scope (the sharing boundary).
		expect(resolveMediaManifest).toHaveBeenCalledWith(
			expect.objectContaining({ appName: "Vaccine Tracker" }),
			"project-1",
			{ withBytes: true },
		);
	});
});
