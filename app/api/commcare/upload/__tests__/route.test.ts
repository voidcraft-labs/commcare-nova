/**
 * `POST /api/commcare/upload` — the route's own contract.
 *
 * The route is a transport and authorization shell over the one publish
 * lifecycle, so what it owns is: reject a malformed request, refuse a
 * viewer, resolve which CommCare deployment the stored key belongs to,
 * and answer in the shape the dialog reads. What a publish MEANS is
 * proved against `publishAppToHq` in
 * `lib/deployment/__tests__/publishLifecycle.test.ts`, which is why this
 * file mocks it rather than re-testing the boundary gate through three
 * layers.
 *
 * The one behavior worth pinning here and nowhere else: a refused publish
 * answers 200 carrying the `incomplete` record, not a 4xx. A 4xx would
 * throw away the record that says which phase to retry from.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireSession } from "@/lib/auth-utils";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { getCommCareSettings } from "@/lib/db/settings";
import { publishAppToHq } from "@/lib/deployment/service";
import { NO_DEPLOYMENT_PHASE_OUTCOMES } from "@/lib/deployment/types";
import { POST } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", () => ({
	resolveAppAccess: vi.fn(),
	AppAccessError: class AppAccessError extends Error {},
}));
vi.mock("@/lib/db/settings", () => ({ getCommCareSettings: vi.fn() }));
vi.mock("@/lib/deployment/service", () => ({ publishAppToHq: vi.fn() }));
vi.mock("@/lib/doc/fieldParent", () => ({
	hydratePersistedBlueprint: (doc: unknown) => doc,
}));

const SESSION = { user: { id: "u1" } };
const DOMAIN = "acme";

/** `readJsonBody` caps the body before parsing, so it reads real bytes. */
function req(body: unknown) {
	const bytes = new TextEncoder().encode(JSON.stringify(body));
	return {
		headers: new Headers({ "content-length": String(bytes.byteLength) }),
		arrayBuffer: async () => bytes.buffer,
	} as never;
}

function deploymentView(state: string, resumePhase: string | null = null) {
	return {
		deployment: {
			id: "dep-1",
			appId: "app-1",
			projectId: "proj-1",
			server: "production",
			domain: DOMAIN,
			state,
			resumePhase,
			phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
			createdBy: "u1",
			createdAt: "2026-08-06T00:00:00.000Z",
			updatedAt: "2026-08-06T00:00:00.000Z",
			lastObservedAt: null,
		},
		active: [],
		superseded: [],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(requireSession).mockResolvedValue(SESSION as never);
	vi.mocked(resolveAppAccess).mockResolvedValue({
		app: { blueprint: {}, mutation_seq: 7 },
		projectId: "proj-1",
		role: "owner",
		actorUserId: "u1",
	} as never);
	vi.mocked(getCommCareSettings).mockResolvedValue({
		configured: true,
		username: "u",
		server: "production",
		availableDomains: [{ name: DOMAIN, displayName: "Acme" }],
	} as never);
	vi.mocked(publishAppToHq).mockResolvedValue({
		deployment: deploymentView("uploaded"),
		checks: [],
		artifact: {
			server: "production",
			domain: DOMAIN,
			hqAppId: null,
			sections: [],
		},
		warnings: [],
		featureFlags: null,
		hqAppUrl: `https://www.commcarehq.org/a/${DOMAIN}/apps/view/hq-abc/`,
	} as never);
});

describe("POST /api/commcare/upload — request shape", () => {
	it("rejects a missing project space", async () => {
		const res = await POST(req({ appName: "App", appId: "app-1" }));
		expect(res.status).toBe(400);
		expect(publishAppToHq).not.toHaveBeenCalled();
	});

	it("rejects a project space that could smuggle a path segment", async () => {
		const res = await POST(
			req({ domain: "acme/../evil", appName: "App", appId: "app-1" }),
		);
		expect(res.status).toBe(400);
		expect(publishAppToHq).not.toHaveBeenCalled();
	});

	it("rejects a missing app name", async () => {
		const res = await POST(req({ domain: DOMAIN, appId: "app-1" }));
		expect(res.status).toBe(400);
		expect(publishAppToHq).not.toHaveBeenCalled();
	});
});

describe("POST /api/commcare/upload — target resolution", () => {
	it("refuses before publishing when CommCare HQ is not connected", async () => {
		vi.mocked(getCommCareSettings).mockResolvedValue({
			configured: false,
		} as never);

		const res = await POST(
			req({ domain: DOMAIN, appName: "App", appId: "app-1" }),
		);

		expect(res.status).toBe(400);
		expect(publishAppToHq).not.toHaveBeenCalled();
	});

	it("publishes to the server the stored key belongs to", async () => {
		vi.mocked(getCommCareSettings).mockResolvedValue({
			configured: true,
			username: "u",
			server: "india",
			availableDomains: [{ name: DOMAIN, displayName: "Acme" }],
		} as never);

		await POST(req({ domain: DOMAIN, appName: "App", appId: "app-1" }));

		expect(vi.mocked(publishAppToHq).mock.calls[0]?.[0]).toMatchObject({
			server: "india",
			domain: DOMAIN,
		});
	});

	it("requires edit, not view: publishing pushes the app out of the Project", async () => {
		await POST(req({ domain: DOMAIN, appName: "App", appId: "app-1" }));
		expect(resolveAppAccess).toHaveBeenCalledWith("app-1", "u1", "edit");
	});
});

describe("POST /api/commcare/upload — answering with the record", () => {
	it("answers 201 with the deployment and its setup artifact", async () => {
		const res = await POST(
			req({ domain: DOMAIN, appName: "App", appId: "app-1" }),
		);
		const body = (await res.json()) as {
			success: boolean;
			deployment: { deployment: { state: string } };
			setup_artifact: { domain: string };
			url: string;
		};

		expect(res.status).toBe(201);
		expect(body.success).toBe(true);
		expect(body.deployment.deployment.state).toBe("uploaded");
		expect(body.setup_artifact.domain).toBe(DOMAIN);
		expect(body.url).toContain("/a/acme/apps/view/");
	});

	it("answers 200 with the incomplete record rather than throwing it away", async () => {
		vi.mocked(publishAppToHq).mockResolvedValue({
			deployment: deploymentView("incomplete", "preflight"),
			checks: [
				{
					id: "app-readiness",
					title: "App readiness",
					status: "blocked",
					detail: "This app isn't ready to publish yet.",
					items: ["Give the module a case list column."],
				},
			],
			artifact: {
				server: "production",
				domain: DOMAIN,
				hqAppId: null,
				sections: [],
			},
			warnings: [],
			featureFlags: null,
			hqAppUrl: null,
		} as never);

		const res = await POST(
			req({ domain: DOMAIN, appName: "App", appId: "app-1" }),
		);
		const body = (await res.json()) as {
			success: boolean;
			deployment: { deployment: { state: string; resumePhase: string } };
			preflight: { status: string; detail: string }[];
		};

		expect(res.status).toBe(200);
		expect(body.success).toBe(false);
		expect(body.deployment.deployment.state).toBe("incomplete");
		expect(body.deployment.deployment.resumePhase).toBe("preflight");
		expect(body.preflight[0]?.status).toBe("blocked");
	});
});
