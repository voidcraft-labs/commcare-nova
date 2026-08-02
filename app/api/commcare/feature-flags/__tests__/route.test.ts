import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { requireSession } from "@/lib/auth-utils";
import { probeHqFeatureFlags } from "@/lib/commcare/client";
import { HQ_FEATURE_FLAG_REQUIREMENTS } from "@/lib/commcare/featureFlags";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { POST } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", () => ({ resolveAppAccess: vi.fn() }));
vi.mock("@/lib/db/settings", () => ({ getCredentialsForUpload: vi.fn() }));
vi.mock("@/lib/commcare/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/commcare/client")>()),
	probeHqFeatureFlags: vi.fn(),
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
	vi.mocked(probeHqFeatureFlags).mockReset();
	vi.mocked(requireSession).mockResolvedValue({ user: { id: "u1" } } as never);
	vi.mocked(resolveAppAccess).mockResolvedValue({
		app: { blueprint: caseSearchDoc() },
		projectId: "project-1",
		role: "owner",
		actorUserId: "u1",
	} as never);
});

describe("POST /api/commcare/feature-flags", () => {
	it("returns app requirements without claiming a domain was checked", async () => {
		const response = await POST(request({ appId: "app-1" }));
		const body = (await response.json()) as {
			feature_flag_requirements: {
				target_domain?: string;
				required_flags: Array<{ slug: string }>;
				message: string;
			};
		};

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(body.feature_flag_requirements.target_domain).toBeUndefined();
		expect(
			body.feature_flag_requirements.required_flags.map((flag) => flag.slug),
		).toEqual(["search_claim"]);
		expect(body.feature_flag_requirements.message).toContain(
			"requirements, not confirmed missing",
		);
		expect(resolveAppAccess).toHaveBeenCalledWith("app-1", "u1", "view");
		expect(getCredentialsForUpload).not.toHaveBeenCalled();
		expect(probeHqFeatureFlags).not.toHaveBeenCalled();
	});

	it("checks a selected HQ project space without claiming an upload happened", async () => {
		vi.mocked(getCredentialsForUpload).mockResolvedValueOnce({
			ok: true,
			creds: { username: "agent", apiKey: "secret" },
			domain: { name: "clinic-space", displayName: "Clinic Space" },
		} as never);
		const requirement = HQ_FEATURE_FLAG_REQUIREMENTS[0];
		if (!requirement) throw new Error("feature-flag catalog is empty");
		vi.mocked(probeHqFeatureFlags).mockResolvedValueOnce([
			{ requirement, state: "missing" },
		]);

		const response = await POST(
			request({ appId: "app-1", domain: "clinic-space" }),
		);
		const body = (await response.json()) as {
			feature_flag_requirements: {
				target_domain?: string;
				missing_flags: Array<{ slug: string }>;
				message: string;
			};
		};

		expect(body.feature_flag_requirements.target_domain).toBe("clinic-space");
		expect(
			body.feature_flag_requirements.missing_flags.map((flag) => flag.slug),
		).toEqual(["search_claim"]);
		expect(body.feature_flag_requirements.message).toContain("isn't enabled");
		expect(body.feature_flag_requirements.message).not.toContain("published");
		expect(getCredentialsForUpload).toHaveBeenCalledWith("u1", "clinic-space");
		expect(probeHqFeatureFlags).toHaveBeenCalledWith(
			expect.objectContaining({ username: "agent" }),
			"clinic-space",
			[requirement],
		);
	});
});
