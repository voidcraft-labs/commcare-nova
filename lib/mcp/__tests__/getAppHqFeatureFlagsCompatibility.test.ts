import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectSpaceCapabilityUse } from "@/lib/publish/projectSpaceCompatibility";
import { loadAppBlueprint } from "../loadApp";
import { checkProjectSpaceCompatibility } from "../tools/checkProjectSpaceCompatibility";
import { registerGetAppHqFeatureFlagsCompatibility } from "../tools/getAppHqFeatureFlagsCompatibility";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

vi.mock("../loadApp", () => ({ loadAppBlueprint: vi.fn() }));
vi.mock("../tools/checkProjectSpaceCompatibility", () => ({
	checkProjectSpaceCompatibility: vi.fn(),
}));

const toolCtx: ToolContext = {
	userId: "u1",
	scopes: [],
	authKind: "oauth",
};

function parseResult(out: unknown): Record<string, unknown> {
	const result = out as { content: Array<{ type: "text"; text: string }> };
	return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
	vi.mocked(loadAppBlueprint).mockReset();
	vi.mocked(checkProjectSpaceCompatibility).mockReset();
});

describe("released-client compatibility tool", () => {
	it("keeps no-domain autonomous handoffs working with semantic requirements", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce({
			app: { app_name: "Patients" },
			doc: {
				connectType: null,
				fields: {},
				modules: {
					patients: {
						uuid: "patients",
						id: "patients",
						name: "Patients",
						caseType: "patient",
						caseSearchConfig: {},
					},
				},
			},
		} as never);
		const { server, capture } = makeFakeServer();
		registerGetAppHqFeatureFlagsCompatibility(server, toolCtx);

		const payload = parseResult(await capture()({ app_id: "app-1" }, {}));
		expect(payload).toMatchObject({
			app_id: "app-1",
			app_name: "Patients",
			domain_checked: false,
			project_space_compatibility: { status: "not_checked" },
			feature_flag_requirements: {
				verification: "not_checked",
				required_flags: [
					expect.objectContaining({
						id: "case-search",
						slug: "case-search",
						label: "Case search",
					}),
				],
			},
		});
		const serialized = JSON.stringify(payload);
		expect(serialized).not.toMatch(
			/search_claim|case_search_advanced|commcare_connect|custom_properties|NAMESPACE_|TAG_/i,
		);
		expect(checkProjectSpaceCompatibility).not.toHaveBeenCalled();
	});

	it("uses the current authoritative check for an explicit destination", async () => {
		const capability = {
			...projectSpaceCapabilityUse("case-search", [
				"The Patients module uses Search.",
			]),
			state: "unverified" as const,
		};
		vi.mocked(checkProjectSpaceCompatibility).mockResolvedValueOnce({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						app_id: "app-1",
						app_name: "Patients",
						project_space_compatibility: {
							status: "blocked",
							target_domain: "clinic-space",
							required_capabilities: [capability],
							blockers: [capability],
							advisories: [],
							support_email: "support@dimagi.com",
							docs_url: "https://docs.commcare.app/project-space-compatibility",
							message: "Nova couldn't confirm Case search.",
						},
					}),
				},
			],
		});
		const { server, capture } = makeFakeServer();
		registerGetAppHqFeatureFlagsCompatibility(server, toolCtx);

		const payload = parseResult(
			await capture()({ app_id: "app-1", domain: "clinic-space" }, {}),
		);
		expect(checkProjectSpaceCompatibility).toHaveBeenCalledWith(
			{ app_id: "app-1", domain: "clinic-space" },
			toolCtx,
		);
		expect(payload).toMatchObject({
			domain_checked: true,
			project_space_compatibility: { status: "blocked" },
			feature_flag_requirements: {
				verification: "unavailable",
				unverified_flags: [expect.objectContaining({ id: "case-search" })],
			},
		});
	});
});
