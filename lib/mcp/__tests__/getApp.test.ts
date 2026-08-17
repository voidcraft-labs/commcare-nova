/**
 * `registerGetApp` unit tests.
 *
 * Covers the four paths the route handler has to care about:
 *   - Happy path: the tool summarizes an owned app through the shared
 *     `summarizeBlueprint` renderer, headed by the app's Nova Project
 *     (name resolved from the caller's own memberships). The assertion
 *     checks for stable structural strings (app name, module name, the
 *     "Structure:" heading) rather than a full markdown byte
 *     comparison — a future renderer tweak (e.g. pluralization,
 *     whitespace) shouldn't break this contract.
 *   - Ownership failure: a cross-tenant probe surfaces as
 *     `loadAppBlueprint` throwing `McpAccessError("not_owner")`. The
 *     wire collapses to `"not_found"` (IDOR hardening) so a probing
 *     client cannot enumerate existing app ids.
 *   - App not found: `loadApp` returns null inside `loadAppBlueprint`,
 *     which throws `McpAccessError("not_found")`. Same wire shape.
 *   - Wire parity: cross-tenant and missing-id envelopes must be
 *     byte-identical so a probing client has zero signal to
 *     distinguish the two cases.
 *
 * The MCP SDK is mocked at the boundary through the shared
 * `makeFakeServer` helper that captures the handler callback. The DB
 * layer's `loadApp` is mocked to drive the four scenarios above through
 * the real `loadAppBlueprint`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import { AppAccessError, resolveAppAccess } from "@/lib/db/appAccess";
import { loadApp } from "@/lib/db/apps";
import type { AppDoc } from "@/lib/db/types";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { listUserProjects } from "@/lib/projects/membership";

import { registerGetApp } from "../tools/getApp";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* `vi.mock` hoists above imports so the mock installs before
 * `../tools/getApp` (and through it `loadAppBlueprint`) resolves
 * `@/lib/db/apps`. Only `loadApp` is replaced — every test scenario
 * is driven by the value (or rejection) `loadApp` resolves to. */
vi.mock("@/lib/db/apps", () => ({
	loadApp: vi.fn(),
}));

/* The membership gate runs inside `loadAppBlueprint` via `resolveAppAccess`.
 * Mock it (keeping the real `AppAccessError` for the instanceof mapping) so the
 * tests drive allow/deny without an auth DB. `loadApp` still supplies the doc. */
vi.mock("@/lib/db/appAccess", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/appAccess")>()),
	resolveAppAccess: vi.fn(),
}));

/* The tool resolves the app's Project name from the caller's own memberships
 * for the summary's `Project:` heading — another auth-DB read to stub. */
vi.mock("@/lib/projects/membership", () => ({
	listUserProjects: vi.fn(),
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
	const modUuid = testUuid("11111111-1111-1111-1111-111111111111");
	const formUuid = testUuid("22222222-2222-2222-2222-222222222222");
	const fieldUuid = testUuid("33333333-3333-3333-3333-333333333333");
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
				label: proseText("Patient Name"),
				/* `required` on an input field is an XPath string, not a
				 * boolean — "true()" is the canonical always-required
				 * form used throughout the blueprint. */
				required: xp("true()"),
			},
		},
		moduleOrder: [modUuid],
		formOrder: { [modUuid]: [formUuid] },
		fieldOrder: { [formUuid]: [fieldUuid] },
		...overrides,
	};
}

/**
 * Build a mocked `AppDoc` shell around a blueprint. The timestamp
 * fields are never inspected by the tool or the renderer, so any
 * plain `Date` works as a placeholder.
 */
function mockAppDoc(
	blueprint: Omit<BlueprintDoc, "fieldParent">,
	overrides?: Partial<AppDoc>,
): AppDoc {
	return {
		owner: "u1",
		project_id: "project-1",
		app_name: blueprint.appName,
		blueprint: blueprint as unknown as BlueprintDoc,
		mutation_seq: 0,
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
		run_holder_nonce: null,
		// Tool doesn't read timestamps — any `Date` works as a placeholder.
		created_at: new Date(),
		updated_at: new Date(),
		...overrides,
	};
}

const toolCtx: ToolContext = { userId: "u1", scopes: [], authKind: "oauth" };

beforeEach(() => {
	vi.mocked(loadApp).mockReset();
	vi.mocked(resolveAppAccess).mockReset();
	vi.mocked(listUserProjects).mockReset();
	/* Default: the caller passes the membership gate. The not-owner tests
	 * override it to reject; the not-found tests never reach it (loadApp → null
	 * throws first). `loadAppBlueprint` retains the scope fields for downstream
	 * server boundaries, so the mock supplies a complete AppAccess. */
	vi.mocked(resolveAppAccess).mockResolvedValue({
		app: mockAppDoc(mockBlueprint()),
		projectId: "p1",
		role: "owner",
		actorUserId: "u1",
	});
	/* Default: the caller's memberships include the app's Project, so the
	 * summary heading resolves its display name. */
	vi.mocked(listUserProjects).mockResolvedValue([
		{
			id: "p1",
			name: "ACE Field Team",
			slug: "ace-field-team",
			role: "owner",
			personal: false,
		},
	]);
});

/* --- Tests ----------------------------------------------------------- */

describe("registerGetApp — happy path", () => {
	it("returns the shared summarizeBlueprint output for an owned app", async () => {
		const blueprint = mockBlueprint();
		vi.mocked(loadApp).mockResolvedValueOnce(mockAppDoc(blueprint));

		const { server, capture } = makeFakeServer();
		registerGetApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		const text = out.content[0]?.text ?? "";
		/* The summary opens with the app's Nova Project — the tenancy
		 * heading MCP prepends (the shared renderer stays blueprint-only). */
		expect(text.startsWith("Project: ACE Field Team (p1)\n\n")).toBe(true);
		/* Check for structural markers rather than a byte-for-byte match
		 * so a future renderer whitespace / pluralization tweak doesn't
		 * break the contract we're testing. */
		expect(text).toContain("Vaccine Tracker");
		expect(text).toContain("Patients");
		expect(text).toContain("**Structure:**");
		expect(text).toContain("Register Patient");
		/* Field id should appear in the per-field bullet line. */
		expect(text).toContain("patient_name");
		/* Display order remains the line order, never a reusable address: the
		 * summary is what the model reads before it decides what to address, so
		 * it carries the uuid rather than a position a peer's reorder moves.
		 * Read the identities off the fixture — hard-coding them here would
		 * assert the fixture, not the renderer. */
		const moduleUuid = blueprint.moduleOrder[0];
		const formUuid = blueprint.formOrder[moduleUuid ?? ""]?.[0];
		expect(text).not.toMatch(/\bModule \d+\b|\bForm \d+\b/);
		expect(text).toContain(`Module "Patients" [uuid ${moduleUuid}]`);
		expect(text).toContain(`Form "Register Patient" [uuid ${formUuid}]`);
	});

	it("falls back to a placeholder name when the membership lookup misses the Project", async () => {
		/* The access gate just proved membership, so a miss can only be a
		 * mid-request membership change — the heading keeps the id (the
		 * useful handle) and degrades only the display name. */
		vi.mocked(listUserProjects).mockResolvedValue([]);
		vi.mocked(loadApp).mockResolvedValueOnce(mockAppDoc(mockBlueprint()));

		const { server, capture } = makeFakeServer();
		registerGetApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		const text = out.content[0]?.text ?? "";
		expect(text.startsWith("Project: (name unavailable) (p1)\n\n")).toBe(true);
		expect(text).toContain("Vaccine Tracker");
	});
});

describe("registerGetApp — ownership failure", () => {
	it("collapses not_owner to not_found on the wire (IDOR hardening)", async () => {
		/* IDOR hardening: when the caller doesn't own the app, the wire
		 * response must be indistinguishable from a missing-id probe so
		 * a malicious client cannot enumerate existing app ids by
		 * watching the response. `loadAppBlueprint` throws
		 * `McpAccessError("not_owner")` internally; the wire collapses
		 * to `"not_found"`. */
		vi.mocked(resolveAppAccess).mockRejectedValueOnce(
			new AppAccessError("not_member"),
		);

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
	});
});

describe("registerGetApp — not found", () => {
	it("maps a missing app row to error_type = 'not_found'", async () => {
		vi.mocked(loadApp).mockResolvedValueOnce(null);

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
});

describe("registerGetApp — wire parity (IDOR regression lock)", () => {
	it("not_owner and not_found produce byte-identical envelopes", async () => {
		/* Regression lock for the IDOR hardening: a probing client
		 * comparing two responses — one for an id they own (collapsed to
		 * not_found) and one for a genuinely missing id — must see the
		 * same text and error_type. */
		vi.mocked(resolveAppAccess).mockRejectedValueOnce(
			new AppAccessError("not_member"),
		);
		const { server: sA, capture: capA } = makeFakeServer();
		registerGetApp(sA, toolCtx);
		const ownerMismatch = await capA()({ app_id: "owned-by-other" }, {});

		vi.mocked(loadApp).mockResolvedValueOnce(null);
		const { server: sB, capture: capB } = makeFakeServer();
		registerGetApp(sB, toolCtx);
		const notFound = await capB()({ app_id: "owned-by-other" }, {});

		/* Identical serialization proves there's no wire signal a
		 * probing client could use to distinguish the two cases. */
		expect(JSON.stringify(ownerMismatch)).toBe(JSON.stringify(notFound));
	});
});
