import { describe, expect, it, vi } from "vitest";
import { POST as checkProjectSpaceCompatibility } from "../../project-space-compatibility/route";
import { POST } from "../route";

vi.mock("../../project-space-compatibility/route", () => ({
	POST: vi.fn(),
}));

describe("POST /api/commcare/feature-flags rollout bridge", () => {
	it("keeps an already-loaded Builder tab operable without exposing HQ settings", async () => {
		vi.mocked(checkProjectSpaceCompatibility).mockResolvedValueOnce(
			Response.json({
				project_space_compatibility: {
					status: "blocked",
					target_domain: "clinic-space",
					required_capabilities: [
						{
							id: "case-search",
							label: "Case search",
							description: "Searches live case data.",
							reasons: ["The Patients module uses Search."],
							state: "missing",
						},
					],
					blockers: [
						{
							id: "case-search",
							label: "Case search",
							description: "Searches live case data.",
							reasons: ["The Patients module uses Search."],
							state: "missing",
						},
					],
					advisories: [],
					support_email: "support@dimagi.com",
					docs_url: "https://docs.commcare.app/project-space-compatibility",
					message: "This project space needs Case search support.",
				},
			}),
		);

		const request = {} as Parameters<typeof POST>[0];
		const response = await POST(request);
		const body = await response.json();

		expect(checkProjectSpaceCompatibility).toHaveBeenCalledWith(request);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(body.feature_flag_requirements).toMatchObject({
			verification: "verified",
			target_domain: "clinic-space",
			required_flags: [
				expect.objectContaining({
					id: "case-search",
					slug: "case-search",
					label: "Case search",
				}),
			],
			missing_flags: [expect.objectContaining({ id: "case-search" })],
		});
		const serialized = JSON.stringify(body);
		expect(serialized).not.toMatch(
			/search_claim|case_search_advanced|commcare_connect|custom_properties|NAMESPACE_|TAG_/i,
		);
	});

	it("passes a current-route refusal through unchanged", async () => {
		vi.mocked(checkProjectSpaceCompatibility).mockResolvedValueOnce(
			Response.json({ error: "Not signed in" }, { status: 401 }),
		);

		const response = await POST({} as Parameters<typeof POST>[0]);
		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({ error: "Not signed in" });
	});
});
