/**
 * `registerGetApp` unit tests.
 *
 * Covers the four paths the route handler has to care about:
 *   - Happy path: the tool summarizes an owned app through the shared
 *     `summarizeBlueprint` renderer. The assertion checks for stable
 *     structural strings (app name, module name, the "Structure:"
 *     heading) rather than a full markdown byte comparison — a future
 *     renderer tweak (e.g. pluralization, whitespace) shouldn't break
 *     this contract.
 *   - Ownership failure: a cross-tenant probe short-circuits before
 *     `loadApp` is called. The wire collapses `"not_owner"` to
 *     `"not_found"` (IDOR hardening) so a probing client cannot
 *     enumerate existing app ids.
 *   - App not found: either ownership returns null (app never existed)
 *     or `loadApp` returns null (concurrent hard-delete between the
 *     ownership check and the load); both collapse to a content
 *     payload carrying `error_type: "not_found"`.
 *   - Wire parity: cross-tenant and missing-id envelopes must be
 *     byte-identical so a probing client has zero signal to
 *     distinguish the two cases.
 *
 * The MCP SDK is mocked at the boundary through the shared
 * `makeFakeServer` helper that captures the handler callback.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadApp, loadAppOwner } from "@/lib/db/apps";
import type { AppDoc } from "@/lib/db/types";
import type { BlueprintDoc } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { registerGetApp } from "../tools/getApp";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* `vi.mock` hoists above imports so the mock installs before
 * `../tools/getApp` resolves `@/lib/db/apps`. Only the two functions
 * the tool actually uses are replaced. */
vi.mock("@/lib/db/apps", () => ({
	loadApp: vi.fn(),
	loadAppOwner: vi.fn(),
}));

/* --- Helpers --------------------------------------------------------- */

/**
 * Build a minimal but renderer-complete blueprint: one module with one
 * form and a single field. Uses an `Omit<BlueprintDoc, "fieldParent">`
 * return shape to mirror the on-disk `PersistableDoc` — the tool
 * rebuilds `fieldParent` itself on load, and this fixture doubles as
 * evidence that code path runs cleanly.
 */
function mockBlueprint(
	overrides?: Partial<Omit<BlueprintDoc, "fieldParent">>,
): Omit<BlueprintDoc, "fieldParent"> {
	/* The branded `Uuid` type requires the narrowing cast rather than a
	 * raw string literal — `asUuid` is the project-standard helper. */
	const modUuid = asUuid("11111111-1111-1111-1111-111111111111");
	const formUuid = asUuid("22222222-2222-2222-2222-222222222222");
	const fieldUuid = asUuid("33333333-3333-3333-3333-333333333333");
	return {
		appId: "a1",
		appName: "Vaccine Tracker",
		connectType: null,
		caseTypes: null,
		modules: {
			[modUuid]: {
				uuid: modUuid,
				id: "patients",
				name: "Patients",
				caseType: "patient",
			},
		},
		forms: {
			[formUuid]: {
				uuid: formUuid,
				id: "register",
				name: "Register Patient",
				type: "registration",
			},
		},
		fields: {
			[fieldUuid]: {
				uuid: fieldUuid,
				id: "patient_name",
				kind: "text",
				label: "Patient Name",
				/* `required` on an input field is an XPath string, not a
				 * boolean — "true()" is the canonical always-required
				 * form used throughout the blueprint. */
				required: "true()",
			},
		},
		moduleOrder: [modUuid],
		formOrder: { [modUuid]: [formUuid] },
		fieldOrder: { [formUuid]: [fieldUuid] },
		...overrides,
	};
}

/**
 * Build a mocked `AppDoc` shell around a blueprint. Firestore
 * `Timestamp` values never get inspected by the tool or the renderer,
 * so we cast a plain `Date` through `unknown` to avoid pulling in the
 * Firestore Admin SDK solely to fabricate stamps.
 */
function mockAppDoc(
	blueprint: Omit<BlueprintDoc, "fieldParent">,
	overrides?: Partial<AppDoc>,
): AppDoc {
	return {
		owner: "u1",
		app_name: blueprint.appName,
		blueprint: blueprint as unknown as BlueprintDoc,
		connect_type: null,
		module_count: blueprint.moduleOrder.length,
		form_count: Object.values(blueprint.formOrder).reduce(
			(sum, ids) => sum + ids.length,
			0,
		),
		status: "complete",
		error_type: null,
		/* Soft-delete fields default to null for any row that hasn't been
		 * soft-deleted. The tool under test never reads them; they're
		 * only here to keep the fixture a complete `AppDoc` shape. */
		deleted_at: null,
		recoverable_until: null,
		run_id: null,
		// Tool doesn't read timestamps — any placeholder works; casting through
		// `unknown` avoids pulling in the Firestore Admin SDK just to fabricate
		// real `Timestamp` instances in a unit test.
		created_at: new Date() as unknown as AppDoc["created_at"],
		updated_at: new Date() as unknown as AppDoc["updated_at"],
		...overrides,
	};
}

const toolCtx: ToolContext = { userId: "u1", scopes: [] };

beforeEach(() => {
	vi.mocked(loadApp).mockReset();
	vi.mocked(loadAppOwner).mockReset();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerGetApp — happy path", () => {
	it("returns the shared summarizeBlueprint output for an owned app", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		const blueprint = mockBlueprint();
		vi.mocked(loadApp).mockResolvedValueOnce(mockAppDoc(blueprint));

		const { server, capture } = makeFakeServer();
		registerGetApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		const text = out.content[0]?.text ?? "";
		/* Check for structural markers rather than a byte-for-byte match
		 * so a future renderer whitespace / pluralization tweak doesn't
		 * break the contract we're testing. */
		expect(text).toContain("Vaccine Tracker");
		expect(text).toContain("Patients");
		expect(text).toContain("**Structure:**");
		expect(text).toContain("Register Patient");
		/* Field id should appear in the per-field bullet line. */
		expect(text).toContain("patient_name");
	});
});

describe("registerGetApp — ownership failure", () => {
	it("collapses not_owner to not_found on the wire (IDOR hardening)", async () => {
		/* IDOR hardening: when the caller doesn't own the app, the wire
		 * response must be indistinguishable from a missing-id probe so
		 * a malicious client cannot enumerate existing app ids by
		 * watching the response. The internal `McpAccessError.reason`
		 * stays `"not_owner"` for the server-side audit log; on the
		 * wire it collapses to `"not_found"`. */
		vi.mocked(loadAppOwner).mockResolvedValueOnce("someone-else");

		const { server, capture } = makeFakeServer();
		registerGetApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			message: string;
			app_id: string;
		};
		expect(payload.error_type).toBe("not_found");
		expect(payload.message).toBe("App not found.");
		expect(payload.app_id).toBe("a1");
		/* The load must not run — an ownership mismatch short-circuits. */
		expect(loadApp).not.toHaveBeenCalled();
	});
});

describe("registerGetApp — not found", () => {
	it("maps ownership-null to error_type = 'not_found'", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce(null);

		const { server, capture } = makeFakeServer();
		registerGetApp(server, toolCtx);

		const out = (await capture()({ app_id: "ghost" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			app_id: string;
		};
		expect(payload.error_type).toBe("not_found");
		expect(payload.app_id).toBe("ghost");
	});

	it("maps race (owner ok, load returns null) to error_type = 'not_found'", async () => {
		/* Concurrent hard-delete between the ownership check and the
		 * load returns ownership first, then a null app. The tool must
		 * collapse this to the same `not_found` reason a missing-app
		 * probe gets, so MCP clients see one consistent error. */
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(loadApp).mockResolvedValueOnce(null);

		const { server, capture } = makeFakeServer();
		registerGetApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			app_id: string;
		};
		expect(payload.error_type).toBe("not_found");
		expect(payload.app_id).toBe("a1");
	});
});

describe("registerGetApp — wire parity (IDOR regression lock)", () => {
	it("not_owner and not_found produce byte-identical envelopes", async () => {
		/* Regression lock for the IDOR hardening: a probing client
		 * comparing two responses — one for an id they own (collapsed to
		 * not_found) and one for a genuinely missing id — must see the
		 * same text and error_type. */
		vi.mocked(loadAppOwner).mockResolvedValueOnce("someone-else");
		const { server: sA, capture: capA } = makeFakeServer();
		registerGetApp(sA, toolCtx);
		const ownerMismatch = await capA()({ app_id: "owned-by-other" }, {});

		vi.mocked(loadAppOwner).mockResolvedValueOnce(null);
		const { server: sB, capture: capB } = makeFakeServer();
		registerGetApp(sB, toolCtx);
		const notFound = await capB()({ app_id: "owned-by-other" }, {});

		/* Identical serialization proves there's no wire signal a
		 * probing client could use to distinguish the two cases. */
		expect(JSON.stringify(ownerMismatch)).toBe(JSON.stringify(notFound));
	});
});
