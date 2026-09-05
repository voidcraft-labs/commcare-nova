import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeHqProjectSpaceCompatibility } from "@/lib/commcare/client";
import { getCredentialsForUpload } from "@/lib/db/settings";
import type { BlueprintDoc } from "@/lib/domain";
import {
	projectSpaceAdvisoryUse,
	projectSpaceCapabilityUse,
	projectSpaceCompatibilityForTarget,
} from "@/lib/publish/projectSpaceCompatibility";
import { loadAppBlueprint } from "../loadApp";
import { McpAccessError } from "../ownership";
import { SCOPES } from "../scopes";
import { registerCheckProjectSpaceCompatibility } from "../tools/checkProjectSpaceCompatibility";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

vi.mock("../loadApp", () => ({
	loadAppBlueprint: vi.fn(),
}));
vi.mock("@/lib/commcare/client", () => ({
	probeHqProjectSpaceCompatibility: vi.fn(),
}));
vi.mock("@/lib/db/settings", () => ({
	getCredentialsForUpload: vi.fn(),
}));

const toolCtx: ToolContext = {
	userId: "u1",
	scopes: [SCOPES.hqRead],
	authKind: "oauth",
};

function loaded(
	doc: Pick<BlueprintDoc, "connectType" | "fields" | "modules">,
	appName = "Vaccine Tracker",
) {
	return {
		doc: {
			appId: "app-1",
			appName,
			caseTypes: null,
			forms: {},
			moduleOrder: Object.values(doc.modules).map((module) => module.uuid),
			formOrder: {},
			fieldOrder: {},
			fieldParent: {},
			...doc,
		} satisfies BlueprintDoc,
		app: { app_name: appName },
		access: {
			projectId: "project-1",
			role: "viewer",
			actorUserId: "u1",
		},
	} as Awaited<ReturnType<typeof loadAppBlueprint>>;
}

function parseResult(out: unknown): Record<string, unknown> {
	const result = out as {
		content: Array<{ type: "text"; text: string }>;
	};
	return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
	vi.mocked(loadAppBlueprint).mockReset();
	vi.mocked(probeHqProjectSpaceCompatibility).mockReset();
	vi.mocked(getCredentialsForUpload).mockReset();
	vi.mocked(getCredentialsForUpload).mockResolvedValue({
		ok: true,
		creds: {
			username: "agent@example.com",
			apiKey: "secret",
			server: "production",
		},
		domain: { name: "vaccines", displayName: "Vaccines" },
	});
});

describe("registerCheckProjectSpaceCompatibility", () => {
	it("checks one explicit project space and returns only semantic app capabilities", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(
			loaded({
				connectType: "learn",
				fields: {},
				modules: {
					module1: {
						uuid: "module1",
						id: "patients",
						name: "Patients",
						caseType: "patient",
						caseSearchConfig: {},
					} as BlueprintDoc["modules"][string],
				},
			}),
		);
		const caseSearch = projectSpaceCapabilityUse("case-search", [
			"The “Patients” module searches across available cases.",
		]);
		const connect = projectSpaceCapabilityUse("commcare-connect", [
			"The app uses CommCare Connect Learn.",
		]);
		const performance = projectSpaceAdvisoryUse("large-search-performance", [
			"The “Patients” module searches across available cases.",
		]);
		const capabilities = [
			{ capability: caseSearch, state: "available" as const },
			{ capability: connect, state: "available" as const },
		];
		const advisories = [{ advisory: performance, state: "available" as const }];
		vi.mocked(probeHqProjectSpaceCompatibility).mockResolvedValueOnce({
			capabilities,
			advisories,
			availableAdvisories: ["large-search-performance"],
			report: projectSpaceCompatibilityForTarget(
				"vaccines",
				capabilities,
				advisories,
			),
		});

		const { server, capture, registeredConfig } = makeFakeServer();
		registerCheckProjectSpaceCompatibility(server, toolCtx);
		const payload = parseResult(
			await capture()({ app_id: "app-1", domain: "vaccines" }, {}),
		);
		const report = payload.project_space_compatibility as {
			status: string;
			target_domain: string;
			required_capabilities: Array<{
				id: string;
				state: string;
				reasons: string[];
			}>;
			blockers: unknown[];
			advisories: Array<{ id: string; state: string }>;
		};

		expect(payload).toMatchObject({
			app_id: "app-1",
			app_name: "Vaccine Tracker",
		});
		expect(report).toMatchObject({
			status: "ready",
			target_domain: "vaccines",
			blockers: [],
			support_email: "support@dimagi.com",
			docs_url: "https://docs.commcare.app/project-space-compatibility",
		});
		expect(
			report.required_capabilities.map(({ id, state }) => ({ id, state })),
		).toEqual([
			{ id: "case-search", state: "available" },
			{ id: "commcare-connect", state: "available" },
		]);
		expect(report.required_capabilities[0]?.reasons).toEqual([
			"The “Patients” module searches across available cases.",
		]);
		expect(report.advisories).toEqual([
			expect.objectContaining({
				id: "large-search-performance",
				state: "available",
			}),
		]);
		expect(getCredentialsForUpload).toHaveBeenCalledWith("u1", "vaccines");
		expect(probeHqProjectSpaceCompatibility).toHaveBeenCalledWith(
			expect.objectContaining({ apiKey: "secret" }),
			"vaccines",
			expect.objectContaining({
				capabilities: expect.arrayContaining([
					expect.objectContaining({
						capability: expect.objectContaining({ id: "case-search" }),
					}),
					expect.objectContaining({
						capability: expect.objectContaining({ id: "commcare-connect" }),
					}),
				]),
			}),
		);
		const config = registeredConfig() as {
			description?: string;
			inputSchema: { shape: Record<string, unknown> };
		};
		expect(config.description).toContain("does not compile, upload, or change");
		expect(Object.keys(config.inputSchema.shape)).toEqual(
			expect.arrayContaining(["app_id", "domain"]),
		);
		const serialized = JSON.stringify(payload);
		expect(serialized).not.toMatch(/slug|namespace|profile|toggle|setting/i);
		expect(serialized).not.toMatch(
			/search_claim|case_search_advanced|commcare_connect|mm_case_properties|view_form_attachments|custom_properties|NAMESPACE_|TAG_/i,
		);
	});

	it("returns missing and unverified capabilities as friendly blockers", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(
			loaded({ connectType: "learn", fields: {}, modules: {} }),
		);
		const connect = projectSpaceCapabilityUse("commcare-connect", [
			"The app uses CommCare Connect Learn.",
		]);
		const capabilities = [
			{ capability: connect, state: "unverified" as const },
		];
		vi.mocked(probeHqProjectSpaceCompatibility).mockResolvedValueOnce({
			capabilities,
			advisories: [],
			availableAdvisories: [],
			report: projectSpaceCompatibilityForTarget("vaccines", capabilities, []),
		});

		const { server, capture } = makeFakeServer();
		registerCheckProjectSpaceCompatibility(server, toolCtx);
		const payload = parseResult(
			await capture()({ app_id: "app-1", domain: "vaccines" }, {}),
		);
		const report = payload.project_space_compatibility as {
			status: string;
			blockers: Array<{ id: string; state: string }>;
		};
		expect(report.status).toBe("blocked");
		expect(report.blockers).toEqual([
			expect.objectContaining({
				id: "commcare-connect",
				state: "unverified",
			}),
		]);
	});

	it("requires HQ Read before loading the app", async () => {
		const { server, capture } = makeFakeServer();
		registerCheckProjectSpaceCompatibility(server, {
			...toolCtx,
			scopes: [],
		});

		const out = (await capture()(
			{ app_id: "app-1", domain: "vaccines" },
			{},
		)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		expect(JSON.parse(out.content[0]?.text ?? "{}")).toMatchObject({
			error_type: "scope_missing",
			required_scope: "nova.hq.read",
			app_id: "app-1",
		});
		expect(loadAppBlueprint).not.toHaveBeenCalled();
		expect(getCredentialsForUpload).not.toHaveBeenCalled();
	});

	it("preserves the shared ownership-hardened error envelope", async () => {
		vi.mocked(loadAppBlueprint).mockRejectedValueOnce(
			new McpAccessError("not_owner"),
		);
		const { server, capture } = makeFakeServer();
		registerCheckProjectSpaceCompatibility(server, toolCtx);

		const out = (await capture()(
			{ app_id: "foreign-app", domain: "vaccines" },
			{},
		)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		expect(JSON.parse(out.content[0]?.text ?? "{}")).toMatchObject({
			error_type: "not_found",
			app_id: "foreign-app",
		});
	});
});
