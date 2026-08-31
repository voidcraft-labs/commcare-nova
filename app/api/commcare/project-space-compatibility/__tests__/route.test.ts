import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { requireSession } from "@/lib/auth-utils";
import { probeHqProjectSpaceCompatibility } from "@/lib/commcare/client";
import { projectSpaceCompatibilityProbePlan } from "@/lib/commcare/projectSpaceCompatibility";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { projectSpaceCompatibilityForTarget } from "@/lib/publish/projectSpaceCompatibility";
import { POST } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", () => ({ resolveAppAccess: vi.fn() }));
vi.mock("@/lib/db/settings", () => ({ getCredentialsForUpload: vi.fn() }));
vi.mock("@/lib/commcare/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/commcare/client")>()),
	probeHqProjectSpaceCompatibility: vi.fn(),
}));

function request(body: unknown) {
	return {
		headers: new Headers(),
		json: async () => body,
		arrayBuffer: async () =>
			new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
	} as unknown as Parameters<typeof POST>[0];
}

function caseSearchDoc() {
	const { fieldParent: _fieldParent, ...persisted } = buildDoc({
		appId: "app-1",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseSearchConfig: {},
			},
		],
	});
	return persisted;
}

beforeEach(() => {
	vi.mocked(requireSession).mockReset();
	vi.mocked(resolveAppAccess).mockReset();
	vi.mocked(getCredentialsForUpload).mockReset();
	vi.mocked(probeHqProjectSpaceCompatibility).mockReset();
	vi.mocked(requireSession).mockResolvedValue({ user: { id: "u1" } } as never);
	vi.mocked(resolveAppAccess).mockResolvedValue({
		app: { blueprint: caseSearchDoc() },
		projectId: "project-1",
		role: "owner",
		actorUserId: "u1",
	} as never);
});

describe("POST /api/commcare/project-space-compatibility", () => {
	it("describes what the app needs without claiming a project space was checked", async () => {
		const response = await POST(request({ appId: "app-1" }));
		const body = (await response.json()) as {
			project_space_compatibility: {
				status: string;
				target_domain?: string;
				required_capabilities: Array<{ id: string; state: string }>;
			};
		};

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(body.project_space_compatibility).toMatchObject({
			status: "not_checked",
			required_capabilities: [
				expect.objectContaining({ id: "case-search", state: "not_checked" }),
			],
		});
		expect(body.project_space_compatibility.target_domain).toBeUndefined();
		expect(JSON.stringify(body)).not.toMatch(/slug|namespace/);
		expect(resolveAppAccess).toHaveBeenCalledWith("app-1", "u1", "view");
		expect(getCredentialsForUpload).not.toHaveBeenCalled();
		expect(probeHqProjectSpaceCompatibility).not.toHaveBeenCalled();
	});

	it("blocks a selected project space when required app support is missing", async () => {
		vi.mocked(getCredentialsForUpload).mockResolvedValueOnce({
			ok: true,
			creds: { username: "agent", apiKey: "secret" },
			domain: { name: "clinic-space", displayName: "Clinic Space" },
		} as never);
		const plan = projectSpaceCompatibilityProbePlan(caseSearchDoc() as never);
		const capability = plan.capabilities[0]?.capability;
		const advisory = plan.advisories[0]?.advisory;
		if (!capability || !advisory) {
			throw new Error("Case Search compatibility plan is incomplete");
		}
		vi.mocked(probeHqProjectSpaceCompatibility).mockResolvedValueOnce({
			capabilities: [{ capability, state: "missing" }],
			advisories: [{ advisory, state: "available" }],
			availableAdvisories: ["large-search-performance"],
			report: projectSpaceCompatibilityForTarget(
				"clinic-space",
				[{ capability, state: "missing" }],
				[{ advisory, state: "available" }],
			),
		});

		const response = await POST(
			request({ appId: "app-1", domain: "clinic-space" }),
		);
		const body = (await response.json()) as {
			project_space_compatibility: {
				status: string;
				target_domain?: string;
				blockers: Array<{ id: string; state: string }>;
			};
		};

		expect(body.project_space_compatibility).toMatchObject({
			status: "blocked",
			target_domain: "clinic-space",
			blockers: [
				expect.objectContaining({ id: "case-search", state: "missing" }),
			],
		});
		expect(JSON.stringify(body)).not.toMatch(/slug|namespace/);
		expect(getCredentialsForUpload).toHaveBeenCalledWith("u1", "clinic-space");
		expect(probeHqProjectSpaceCompatibility).toHaveBeenCalledWith(
			expect.objectContaining({ username: "agent" }),
			"clinic-space",
			expect.objectContaining({ capabilities: expect.any(Array) }),
		);
	});
});
