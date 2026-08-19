import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeHqFeatureFlags } from "@/lib/commcare/client";
import { HQ_FEATURE_FLAG_REQUIREMENTS } from "@/lib/commcare/featureFlags";
import { getCredentialsForUpload } from "@/lib/db/settings";
import type { BlueprintDoc } from "@/lib/domain";

import { loadAppBlueprint } from "../loadApp";
import { McpAccessError } from "../ownership";
import { registerGetAppHqFeatureFlags } from "../tools/getAppHqFeatureFlags";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

vi.mock("../loadApp", () => ({
	loadAppBlueprint: vi.fn(),
}));
vi.mock("@/lib/commcare/client", () => ({
	probeHqFeatureFlags: vi.fn(),
}));
vi.mock("@/lib/db/settings", () => ({
	getCredentialsForUpload: vi.fn(),
}));

const toolCtx: ToolContext = { userId: "u1", scopes: [], authKind: "oauth" };

function loaded(
	doc: Pick<BlueprintDoc, "connectType" | "fields" | "modules">,
	appName = "Vaccine Tracker",
) {
	return {
		doc,
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
	vi.mocked(probeHqFeatureFlags).mockReset();
	vi.mocked(getCredentialsForUpload).mockReset();
});

describe("registerGetAppHqFeatureFlags", () => {
	it("returns only the app's requirements with reasons and self-contained help", async () => {
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

		const { server, capture, registeredConfig } = makeFakeServer();
		registerGetAppHqFeatureFlags(server, toolCtx);
		const payload = parseResult(await capture()({ app_id: "app-1" }, {}));
		const report = payload.feature_flag_requirements as Record<string, unknown>;
		const flags = report.required_flags as Array<{
			slug: string;
			description: string;
			docs_url: string;
			reasons: string[];
		}>;

		expect(flags.map((flag) => flag.slug)).toEqual([
			"search_claim",
			"commcare_connect",
		]);
		expect(flags[0]?.reasons).toEqual([
			"The “Patients” module has a Case Search action or Search inputs.",
		]);
		expect(flags.every((flag) => flag.description.length > 0)).toBe(true);
		expect(
			flags.every((flag) =>
				flag.docs_url.startsWith("https://docs.commcare.app/feature-flags#"),
			),
		).toBe(true);
		expect(payload).toMatchObject({
			app_id: "app-1",
			app_name: "Vaccine Tracker",
			domain_checked: false,
		});
		expect(report).toMatchObject({
			verification: "not_checked",
			missing_flags: [],
			support_email: "support@dimagi.com",
			docs_url: "https://docs.commcare.app/feature-flags",
		});
		expect(report.message).toContain("requirements, not confirmed missing");
		expect(loadAppBlueprint).toHaveBeenCalledWith("app-1", "u1");
		expect(registeredConfig()).toMatchObject({
			description: expect.stringContaining("With no `domain`"),
		});
	});

	it("returns a quiet, explicit result when the app needs no flags", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(
			loaded({ connectType: null, fields: {}, modules: {} }),
		);
		const { server, capture } = makeFakeServer();
		registerGetAppHqFeatureFlags(server, toolCtx);

		const payload = parseResult(await capture()({ app_id: "app-1" }, {}));
		const report = payload.feature_flag_requirements as Record<string, unknown>;

		expect(report.required_flags).toEqual([]);
		expect(report.verification).toBe("not_required");
		expect(payload.domain_checked).toBe(false);
		expect(report.message).toBe(
			"This app doesn't use any features that need a CommCare HQ feature flag.",
		);
	});

	it("reports the flag an attachment question's destination needs", async () => {
		// The projection reads `fields`, not just `modules`, and this is the
		// surface an MCP client actually sees — an app whose only flag comes
		// from a field would report nothing if the two ever came apart.
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(
			loaded({
				connectType: null,
				modules: {},
				fields: {
					field1: {
						uuid: "field1",
						id: "thepicture",
						kind: "image",
						label: { parts: [{ kind: "text", text: "Photo" }] },
						caseWrite: {
							caseType: "patient",
							property: "photo",
							mode: "attachment",
						},
					} as unknown as BlueprintDoc["fields"][string],
				},
			}),
		);
		const { server, capture } = makeFakeServer();
		registerGetAppHqFeatureFlags(server, toolCtx);

		const payload = parseResult(await capture()({ app_id: "app-1" }, {}));
		const report = payload.feature_flag_requirements as Record<string, unknown>;
		const flags = report.required_flags as Array<{
			slug: string;
			reasons: string[];
		}>;

		expect(flags.map((flag) => flag.slug)).toEqual(["mm_case_properties"]);
		expect(flags[0]?.reasons).toEqual([
			"The \u201cPhoto\u201d question saves its file onto the case.",
		]);
	});

	it("checks one explicit connected domain and preserves reasons on missing and unverified flags", async () => {
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
		vi.mocked(getCredentialsForUpload).mockResolvedValueOnce({
			ok: true,
			creds: {
				username: "agent@example.com",
				apiKey: "secret",
				server: "production",
			},
			domain: { name: "vaccines", displayName: "Vaccines" },
		});
		vi.mocked(probeHqFeatureFlags).mockResolvedValueOnce([
			{
				requirement: HQ_FEATURE_FLAG_REQUIREMENTS[0],
				state: "missing",
			},
			{
				requirement: HQ_FEATURE_FLAG_REQUIREMENTS[2],
				state: "unavailable",
			},
		]);

		const { server, capture } = makeFakeServer();
		registerGetAppHqFeatureFlags(server, {
			...toolCtx,
			scopes: ["nova.hq.read"],
		});
		const payload = parseResult(
			await capture()({ app_id: "app-1", domain: "vaccines" }, {}),
		);
		const report = payload.feature_flag_requirements as {
			verification: string;
			target_domain: string;
			missing_flags: Array<{ slug: string; reasons: string[] }>;
			unverified_flags: Array<{ slug: string; reasons: string[] }>;
		};

		expect(payload.domain_checked).toBe(true);
		expect(report.verification).toBe("partial");
		expect(report.target_domain).toBe("vaccines");
		expect(report.missing_flags).toEqual([
			expect.objectContaining({
				slug: "search_claim",
				reasons: [
					"The “Patients” module has a Case Search action or Search inputs.",
				],
			}),
		]);
		expect(report.unverified_flags).toEqual([
			expect.objectContaining({
				slug: "commcare_connect",
				reasons: ["The app is configured for CommCare Connect Learn."],
			}),
		]);
		expect(getCredentialsForUpload).toHaveBeenCalledWith("u1", "vaccines");
		expect(probeHqFeatureFlags).toHaveBeenCalledWith(
			expect.objectContaining({ apiKey: "secret" }),
			"vaccines",
			[HQ_FEATURE_FLAG_REQUIREMENTS[0], HQ_FEATURE_FLAG_REQUIREMENTS[2]],
		);
	});

	it("requires HQ Read before loading the app when a domain is supplied", async () => {
		const { server, capture } = makeFakeServer();
		registerGetAppHqFeatureFlags(server, toolCtx);

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
		registerGetAppHqFeatureFlags(server, toolCtx);

		const out = (await capture()({ app_id: "foreign-app" }, {})) as {
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
