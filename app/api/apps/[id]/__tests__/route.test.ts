/**
 * `GET /api/apps/{id}` — authoritative builder-snapshot wire contract.
 *
 * The database transaction is covered by the app-state integration suite; this
 * route test pins the projection that rolling browser revisions consume: the
 * new Project/role/edit/cursor fields and the legacy scalar/cursor aliases.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { requireSession } from "@/lib/auth-utils";
import {
	AppAccessError,
	resolveAppAccess,
	resolveAuthorizedAppSnapshot,
} from "@/lib/db/appAccess";
import { applyBlueprintChange } from "@/lib/db/applyBlueprintChange";
import { MutationBatchIdCollisionError } from "@/lib/db/commitGuard";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { GET, PUT } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", () => ({
	AppAccessError: class AppAccessError extends Error {
		readonly name = "AppAccessError";
		constructor(readonly reason: string) {
			super(reason);
		}
	},
	resolveAppAccess: vi.fn(),
	resolveAuthorizedAppSnapshot: vi.fn(),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(),
}));

const SESSION = { user: { id: "user-1" } };
const BLUEPRINT = toPersistableDoc(
	buildDoc({ appName: "Nutrition visits", modules: [] }),
);

function request(): Request {
	return new Request("http://localhost/api/apps/app-1");
}

function params() {
	return { params: Promise.resolve({ id: "app-1" }) };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(requireSession).mockResolvedValue(SESSION as never);
	vi.mocked(resolveAuthorizedAppSnapshot).mockResolvedValue({
		projectId: "project-1",
		role: "viewer",
		canEdit: false,
		baseSeq: 42,
		actorUserId: "user-1",
		app: {
			owner: "owner-1",
			project_id: "project-1",
			app_name: "Nutrition visits",
			blueprint: BLUEPRINT,
			mutation_seq: 42,
			connect_type: null,
			module_count: 0,
			form_count: 0,
			status: "complete",
			error_type: null,
			deleted_at: null,
			recoverable_until: null,
			run_id: null,
			run_holder_nonce: null,
			created_at: new Date("2026-07-22T00:00:00Z"),
			updated_at: new Date("2026-07-22T00:00:00Z"),
		},
	});
	vi.mocked(resolveAppAccess).mockResolvedValue({
		projectId: "project-1",
		role: "editor",
		canEdit: true,
		actorUserId: "user-1",
		app: {
			owner: "owner-1",
			project_id: "project-1",
			app_name: "Nutrition visits",
			blueprint: BLUEPRINT,
			mutation_seq: 42,
			connect_type: null,
			module_count: 0,
			form_count: 0,
			status: "complete",
			error_type: null,
			deleted_at: null,
			recoverable_until: null,
			run_id: null,
			run_holder_nonce: null,
			created_at: new Date("2026-07-22T00:00:00Z"),
			updated_at: new Date("2026-07-22T00:00:00Z"),
		},
	} as never);
	vi.mocked(applyBlueprintChange).mockResolvedValue({ seq: 43 });
});

describe("GET /api/apps/[id]", () => {
	it("returns one authorization/document/cursor tuple with rolling aliases", async () => {
		const response = await GET(request(), params());
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(resolveAuthorizedAppSnapshot).toHaveBeenCalledWith(
			"app-1",
			"user-1",
			"view",
		);
		expect(resolveAppAccess).not.toHaveBeenCalled();
		expect(body).toEqual({
			projectId: "project-1",
			role: "viewer",
			canEdit: false,
			blueprint: BLUEPRINT,
			baseSeq: 42,
			app_name: "Nutrition visits",
			status: "complete",
			error_type: null,
			mutation_seq: 42,
		});
	});

	it("keeps authorization denial IDOR-opaque", async () => {
		const denied = new Error("not_member");
		denied.name = "AppAccessError";
		vi.mocked(resolveAuthorizedAppSnapshot).mockRejectedValueOnce(denied);

		const response = await GET(request(), params());
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "App not found" });
	});
});

describe("PUT /api/apps/[id]", () => {
	it("returns a typed 403 for a known member who lost edit capability", async () => {
		vi.mocked(resolveAppAccess).mockRejectedValueOnce(
			new AppAccessError("insufficient_role"),
		);
		const response = await PUT(
			new Request("http://localhost/api/apps/app-1", {
				method: "PUT",
			}),
			params(),
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "insufficient_role",
			type: "reauth_denied",
		});
	});

	it.each([
		{
			label: "missing formerly-defaulted patch",
			mutations: [
				{
					kind: "updateModule",
					uuid: "11111111-1111-4111-8111-111111111111",
				},
			],
			details: {
				mutationIndex: 0,
				pointer: "/0/patch",
				reason: "schema-parse",
			},
		},
		{
			label: "nested unknown key",
			mutations: [
				{
					kind: "updateField",
					uuid: "33333333-3333-4333-8333-333333333333",
					targetKind: "text",
					patch: { unknown: true },
				},
			],
			details: {
				mutationIndex: 0,
				pointer: "/0/patch",
				reason: "schema-strip",
			},
		},
	])(
		"returns the exact terminal canonicality body for a $label",
		async ({ mutations, details }) => {
			const response = await PUT(
				new Request("http://localhost/api/apps/app-1", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						// Deliberately invalid too: canonicality must win before
						// batch-id validation or any saga side effect.
						batchId: "not-a-uuid",
						mutations,
					}),
				}),
				params(),
			);

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error:
					"This edit could not be saved because its mutation data was not canonical.",
				type: "mutation_wire_canonicality_invalid",
				retryable: false,
				details,
			});
			expect(applyBlueprintChange).not.toHaveBeenCalled();
		},
	);

	it("returns the exact terminal batch-id collision body", async () => {
		vi.mocked(applyBlueprintChange).mockRejectedValueOnce(
			new MutationBatchIdCollisionError(),
		);
		const response = await PUT(
			new Request("http://localhost/api/apps/app-1", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					mutations: [{ kind: "setAppName", name: "Renamed" }],
				}),
			}),
			params(),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "This save reused a batch id for different content.",
			type: "mutation_batch_id_collision",
			retryable: false,
		});
	});
});
