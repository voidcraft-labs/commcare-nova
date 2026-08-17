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
import { previewProjectSpaceFor } from "@/lib/deployment/previewSpace";
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
/* The route asks the server what Preview may name; only the server can
 * see whether the app is now live on more than one space. */
vi.mock("@/lib/deployment/previewSpace", () => ({
	previewProjectSpaceFor: vi.fn(async () => "acme"),
}));
vi.mock("@/lib/doc/fieldParent", () => ({
	hydratePersistedBlueprint: (doc: unknown) => doc,
}));

const SESSION = { user: { id: "u1" } };
const DOMAIN = "acme";

/**
 * Read the whole response.
 *
 * Every assertion goes through this rather than touching `res.status`
 * alone: `NextResponse.json` holds a body stream, and a test that never
 * consumes one leaves it open, which the async-leak detector fails the
 * suite on.
 */
async function read(res: Response): Promise<{ status: number; body: unknown }> {
	return { status: res.status, body: await res.json() };
}

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
		landed: true,
		hqAppAction: "created",
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
		const { status, body } = await read(
			await POST(req({ appName: "App", appId: "app-1" })),
		);
		expect(status).toBe(400);
		expect(body).toMatchObject({ error: expect.stringMatching(/project/i) });
		expect(publishAppToHq).not.toHaveBeenCalled();
	});

	it("rejects a project space that could smuggle a path segment", async () => {
		const { status } = await read(
			await POST(
				req({ domain: "acme/../evil", appName: "App", appId: "app-1" }),
			),
		);
		expect(status).toBe(400);
		expect(publishAppToHq).not.toHaveBeenCalled();
	});

	it("rejects a missing app name", async () => {
		const { status } = await read(
			await POST(req({ domain: DOMAIN, appId: "app-1" })),
		);
		expect(status).toBe(400);
		expect(publishAppToHq).not.toHaveBeenCalled();
	});
});

describe("POST /api/commcare/upload — target resolution", () => {
	it("refuses before publishing when CommCare HQ is not connected", async () => {
		vi.mocked(getCommCareSettings).mockResolvedValue({
			configured: false,
		} as never);

		const { status, body } = await read(
			await POST(req({ domain: DOMAIN, appName: "App", appId: "app-1" })),
		);

		expect(status).toBe(400);
		expect(body).toMatchObject({ error: expect.stringMatching(/Settings/) });
		expect(publishAppToHq).not.toHaveBeenCalled();
	});

	it("publishes to the server the stored key belongs to", async () => {
		vi.mocked(getCommCareSettings).mockResolvedValue({
			configured: true,
			username: "u",
			server: "india",
			availableDomains: [{ name: DOMAIN, displayName: "Acme" }],
		} as never);

		await read(
			await POST(req({ domain: DOMAIN, appName: "App", appId: "app-1" })),
		);

		expect(vi.mocked(publishAppToHq).mock.calls[0]?.[0]).toMatchObject({
			server: "india",
			domain: DOMAIN,
		});
	});

	it("requires edit, not view: publishing pushes the app out of the Project", async () => {
		await read(
			await POST(req({ domain: DOMAIN, appName: "App", appId: "app-1" })),
		);
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

	it("answers 200 for an in-place update, saying which happened", async () => {
		/* An update created no resource, so 201 would lie; the body's
		 * `hq_app_action` is what tells the dialog which hero to show. */
		vi.mocked(publishAppToHq).mockResolvedValue({
			landed: true,
			hqAppAction: "updated",
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

		const res = await POST(
			req({ domain: DOMAIN, appName: "App", appId: "app-1" }),
		);
		const body = (await res.json()) as {
			success: boolean;
			hq_app_action: string;
		};

		expect(res.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.hq_app_action).toBe("updated");
	});

	it("answers with what Preview may name, resolved server-side", async () => {
		// The browser cannot see whether this app is now live on a second
		// project space, which is when `commcare_project` has two real
		// answers and Nova must name neither.
		vi.mocked(previewProjectSpaceFor).mockResolvedValue(null as never);

		const res = await POST(
			req({ domain: DOMAIN, appName: "App", appId: "app-1" }),
		);
		const body = (await res.json()) as { preview_project_space: unknown };

		expect(body.preview_project_space).toBeNull();
	});

	it("reads success from the attempt, not from what the target holds", async () => {
		/* A blocked preflight against an app that is already released
		 * leaves the record released, because it still is. Judging success
		 * from that state would report a publish that never happened as a
		 * success. */
		vi.mocked(publishAppToHq).mockResolvedValue({
			landed: false,
			deployment: deploymentView("runnable"),
			checks: [
				{
					id: "hq-connection",
					title: "CommCare HQ connection",
					status: "blocked",
					detail: "CommCare HQ isn't connected yet.",
					items: [],
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
			deployment: { deployment: { state: string } };
		};

		expect(res.status).toBe(200);
		expect(body.success).toBe(false);
		// The target really is still runnable, and says so.
		expect(body.deployment.deployment.state).toBe("runnable");
	});

	it("answers 200 with the incomplete record rather than throwing it away", async () => {
		vi.mocked(publishAppToHq).mockResolvedValue({
			landed: false,
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
