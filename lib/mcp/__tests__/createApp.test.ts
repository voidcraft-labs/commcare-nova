/**
 * `registerCreateApp` unit tests.
 *
 * Verifies the four load-bearing behaviors of the MCP-only create tool:
 *   - Name input is passed to the one canonical genesis owner.
 *   - The full committed receipt — sequence, blueprint, and starter UUIDs —
 *     is returned so MCP clients continue from exact identity.
 *   - A fresh server-minted run_id is persisted to the new app doc so
 *     the sliding-window derivation in subsequent MCP calls has an
 *     anchor to reuse (see `lib/mcp/runId.ts`).
 *   - `createExplicitBlankApp` throws: surfaces as an MCP `isError: true` envelope
 *     classified through the shared taxonomy.
 *
 * The MCP SDK is mocked at the boundary through the shared
 * `makeFakeServer` helper that captures the handler callback.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type CreateAppReceipt,
	createExplicitBlankApp,
} from "@/lib/db/appGenesis";
import { proseText } from "@/lib/domain/prose";
import { registerCreateApp } from "../tools/createApp";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* Hoisted mock — installs before `../tools/createApp` resolves
 * `@/lib/db/apps`. Only `createExplicitBlankApp` is replaced. */
vi.mock("@/lib/db/appGenesis", () => ({
	createExplicitBlankApp: vi.fn(),
}));

/* The tool resolves the caller's personal Project before creating; stub it so
 * the unit test never touches the auth DB. */
vi.mock("@/lib/auth/provisionProject", () => ({
	ensurePersonalProject: vi.fn(async () => "proj-test"),
}));

/* --- Helpers --------------------------------------------------------- */

/**
 * Loose UUID-v4 regex. Asserting on shape (rather than pinning an
 * exact value) keeps the test decoupled from `crypto.randomUUID()`'s
 * output while still catching regressions that would return a fixed
 * string or something structurally wrong.
 */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const toolCtx: ToolContext = { userId: "u1", scopes: [], authKind: "oauth" };
const MODULE_UUID = testUuid("module00-0000-4000-8000-000000000001");
const FORM_UUID = testUuid("form0000-0000-4000-8000-000000000002");
const FIELD_UUID = testUuid("field000-0000-4000-8000-000000000003");

function genesisReceipt(appId: string): CreateAppReceipt {
	return {
		appId,
		baseSeq: 1,
		snapshotDigest: "a".repeat(64),
		blueprint: {
			appId,
			appName: "Untitled",
			connectType: null,
			caseTypes: null,
			modules: {
				[MODULE_UUID]: {
					uuid: MODULE_UUID,
					id: "survey",
					name: "Survey",
				},
			},
			forms: {
				[FORM_UUID]: {
					uuid: FORM_UUID,
					id: "survey",
					name: "Survey",
					type: "survey",
				},
			},
			fields: {
				[FIELD_UUID]: {
					uuid: FIELD_UUID,
					id: "question_1",
					kind: "text",
					label: proseText("Question 1"),
				},
			},
			moduleOrder: [MODULE_UUID],
			formOrder: { [MODULE_UUID]: [FORM_UUID] },
			fieldOrder: { [FORM_UUID]: [FIELD_UUID] },
		},
		starter: {
			moduleUuid: MODULE_UUID,
			formUuid: FORM_UUID,
			fieldUuid: FIELD_UUID,
		},
	};
}

beforeEach(() => {
	vi.mocked(createExplicitBlankApp).mockReset();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerCreateApp — happy path with name", () => {
	it("forwards the name and 'complete' status, returns the minted app_id", async () => {
		const receipt = genesisReceipt("app-123");
		vi.mocked(createExplicitBlankApp).mockResolvedValueOnce(receipt);

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		const out = (await capture()({ app_name: "My App" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		expect(createExplicitBlankApp).toHaveBeenCalledTimes(1);
		const [owner, projectId, runId, opts] =
			vi.mocked(createExplicitBlankApp).mock.calls[0] ?? [];
		expect(owner).toBe("u1");
		/* The tool resolves the caller's personal Project (mocked). */
		expect(projectId).toBe("proj-test");
		/* Server-minted run id seeds the new app doc. Shape-check only;
		 * we don't pin a specific value. */
		expect(typeof runId).toBe("string");
		expect(runId).toMatch(UUID_RE);
		expect(opts).toEqual({ name: "My App", status: "complete" });

		/* Every structured signal rides in content JSON: the `stage`
		 * marker the model branches on plus the minted `app_id`. */
		expect(JSON.parse(out.content[0]?.text ?? "{}")).toEqual({
			stage: "app_created",
			app_id: "app-123",
			base_seq: 1,
			blueprint: receipt.blueprint,
			starter: {
				module_uuid: MODULE_UUID,
				form_uuid: FORM_UUID,
				field_uuid: FIELD_UUID,
			},
		});
	});
});

describe("registerCreateApp — happy path without name", () => {
	it("leaves fallback naming to canonical genesis", async () => {
		vi.mocked(createExplicitBlankApp).mockResolvedValueOnce(
			genesisReceipt("app-abc"),
		);

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		await capture()({}, {});

		const [, , , opts] = vi.mocked(createExplicitBlankApp).mock.calls[0] ?? [];
		expect(opts).toEqual({ name: undefined, status: "complete" });
	});
});

describe("registerCreateApp — whitespace-only name", () => {
	it("passes whitespace to canonical genesis instead of owning a second fallback", async () => {
		vi.mocked(createExplicitBlankApp).mockResolvedValueOnce(
			genesisReceipt("app-xyz"),
		);

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		await capture()({ app_name: "   " }, {});

		const [, , , opts] = vi.mocked(createExplicitBlankApp).mock.calls[0] ?? [];
		expect(opts).toEqual({ name: "   ", status: "complete" });
	});
});

describe("registerCreateApp — run seed", () => {
	it("persists a unique UUID-v4 run id per call to the DB helper", async () => {
		/* Each create mints a fresh id — two back-to-back creates must
		 * produce different seeds, since each is the anchor for its own
		 * subsequent run. */
		vi.mocked(createExplicitBlankApp).mockResolvedValueOnce(
			genesisReceipt("app-1"),
		);
		vi.mocked(createExplicitBlankApp).mockResolvedValueOnce(
			genesisReceipt("app-2"),
		);

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);
		await capture()({}, {});
		await capture()({}, {});

		const [, , runIdA] = vi.mocked(createExplicitBlankApp).mock.calls[0] ?? [];
		const [, , runIdB] = vi.mocked(createExplicitBlankApp).mock.calls[1] ?? [];
		expect(runIdA).toMatch(UUID_RE);
		expect(runIdB).toMatch(UUID_RE);
		expect(runIdA).not.toBe(runIdB);
	});
});

/* --- Type-level tests ------------------------------------------------ */

/**
 * Compile-time regression lock for `CreateAppOptions.status`. The
 * narrowed type rejects `"error"` and `"deleted"` — these calls must
 * NOT compile. `@ts-expect-error` fails the test suite build if the
 * assertion suddenly starts typechecking (e.g. a future widening of
 * the union), catching the regression at compile time rather than
 * waiting for a runtime surprise.
 *
 * Calls are wrapped in a `neverRun` guard so the references don't
 * execute — the `@ts-expect-error` directives ARE the assertions, not
 * any runtime behavior.
 */
function typeCheckCreateAppOptions(): void {
	const neverRun = false;
	if (neverRun) {
		// @ts-expect-error — "error" is not a valid creation status
		void createExplicitBlankApp("u1", "proj", "rid", { status: "error" });
		// @ts-expect-error — "deleted" is not a valid creation status
		void createExplicitBlankApp("u1", "proj", "rid", { status: "deleted" });
		// @ts-expect-error — callers cannot author the name outside genesis
		void createExplicitBlankApp("u", "p", "r", { appName: "parallel" });
		// @ts-expect-error — canonical genesis is mandatory, never caller-seeded
		void createExplicitBlankApp("u", "p", "r", { seedMutations: () => [] });
	}
}
/* Reference the guard so lint doesn't flag it as unused — the
 * directives inside are what the compiler enforces. */
void typeCheckCreateAppOptions;

describe("registerCreateApp — createExplicitBlankApp throws", () => {
	it("surfaces as an MCP error envelope with populated error_type", async () => {
		vi.mocked(createExplicitBlankApp).mockRejectedValueOnce(
			new Error("db write failed"),
		);

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		const out = (await capture()({ app_name: "x" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type?: string;
			message?: string;
		};
		expect(typeof payload.error_type).toBe("string");
		expect(payload.error_type?.length ?? 0).toBeGreaterThan(0);
	});
});
