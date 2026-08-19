/**
 * `provisionWorkersAction` — the browser half of provisioning.
 *
 * One promise is under test and it is the only one that cannot be
 * recovered from: **a generated password reaches the caller's answer.**
 * By the time this action has an outcome, the accounts exist on CommCare
 * HQ and their passwords are held in exactly one place — the object being
 * assembled. Everything the action does afterwards is reporting: a setup
 * artifact, a left-behind report, both of which read Postgres and both of
 * which can fail on a bad minute. If one of those failures reached the
 * catch, the answer would be replaced by a refusal and real accounts
 * would be left on somebody's project space with nobody able to sign in.
 *
 * The refusal path is recoverable — one click of Check rebuilds the view.
 * That asymmetry is the whole design, and it is what these pin.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-utils", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", () => ({
	resolveAppScope: vi.fn(),
	AppAccessError: class AppAccessError extends Error {},
}));
vi.mock("@/lib/organization/service", () => ({
	readOrganizationAuthoringSnapshot: vi.fn(),
}));
vi.mock("../workers", () => ({ provisionWorkers: vi.fn() }));
vi.mock("../service", () => ({
	publishAppToHq: vi.fn(),
	refreshDeployment: vi.fn(),
	setupArtifactFor: vi.fn(),
	currentResourceIdentities: vi.fn(),
}));
vi.mock("../store", () => ({ readDeploymentsForApp: vi.fn() }));
vi.mock("../previewSpace", () => ({ previewProjectSpaceFor: vi.fn() }));
vi.mock("../resources", () => ({ leftBehindResources: vi.fn(() => []) }));

const { getSession } = await import("@/lib/auth-utils");
const { resolveAppScope } = await import("@/lib/db/appAccess");
const { readOrganizationAuthoringSnapshot } = await import(
	"@/lib/organization/service"
);
const { provisionWorkers } = await import("../workers");
const { setupArtifactFor, currentResourceIdentities } = await import(
	"../service"
);
const { provisionWorkersAction } = await import("../actions");

const APP = "018f0000-0000-7000-8000-000000000010";
const AMINA = "018f0000-0000-7000-8000-000000000001";

/** One account, made in this call, whose password exists only here. */
const PROVISIONED = {
	personaUuid: AMINA,
	personaName: "Amina",
	username: "amina@acme.commcarehq.org",
	userId: "hq-amina",
	created: true,
	adopted: false,
	password: "Rk7-vqTm4Wd2xYbP",
} as const;

function input(over: Record<string, unknown> = {}) {
	return {
		appId: APP,
		server: "production",
		domain: "acme",
		workers: [{ personaUuid: AMINA, username: "amina" }],
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getSession).mockResolvedValue({ user: { id: "u1" } } as never);
	vi.mocked(resolveAppScope).mockResolvedValue({
		projectId: "proj-1",
		role: "owner",
	} as never);
	vi.mocked(readOrganizationAuthoringSnapshot).mockResolvedValue({
		blueprint: {},
		organization: { locations: [] },
	} as never);
	vi.mocked(provisionWorkers).mockResolvedValue({
		refusal: null,
		workers: [PROVISIONED],
		deployment: { deployment: {}, active: [], superseded: [] },
	} as never);
	vi.mocked(setupArtifactFor).mockResolvedValue({ sections: [] } as never);
	vi.mocked(currentResourceIdentities).mockResolvedValue(new Map() as never);
});

describe("provisionWorkersAction", () => {
	it("carries the password out with the view beside it", async () => {
		const result = await provisionWorkersAction(input());

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.workers).toEqual([PROVISIONED]);
		expect(result.data.view).not.toBeNull();
	});

	it("still carries the password when the setup artifact cannot be built", async () => {
		vi.mocked(setupArtifactFor).mockRejectedValue(
			new Error("connection terminated unexpectedly"),
		);

		const result = await provisionWorkersAction(input());

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.workers).toEqual([PROVISIONED]);
		/* Degraded, not lost: the panel shows no refreshed record and one
		 * click of Check restores it. */
		expect(result.data.view).toBeNull();
	});

	it("still carries the password when the left-behind read fails", async () => {
		vi.mocked(currentResourceIdentities).mockRejectedValue(
			new Error("connection terminated unexpectedly"),
		);

		const result = await provisionWorkersAction(input());

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.workers).toEqual([PROVISIONED]);
		expect(result.data.view).toBeNull();
	});

	it("carries what landed before a refusal, with the refusal", async () => {
		vi.mocked(provisionWorkers).mockResolvedValue({
			refusal: {
				code: "hq_rejected_worker",
				message: "CommCare HQ wouldn't make the account for “Joseph”.",
				details: [],
				conflicts: [],
			},
			workers: [PROVISIONED],
			deployment: null,
		} as never);

		const result = await provisionWorkersAction(input());

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.refusal?.code).toBe("hq_rejected_worker");
		expect(result.data.workers).toEqual([PROVISIONED]);
	});
});
