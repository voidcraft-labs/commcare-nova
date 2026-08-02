import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";

import { loadAppBlueprint } from "../loadApp";
import { McpAccessError } from "../ownership";
import { registerGetAppFeatureFlags } from "../tools/getAppFeatureFlags";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

vi.mock("../loadApp", () => ({
	loadAppBlueprint: vi.fn(),
}));

const toolCtx: ToolContext = { userId: "u1", scopes: [], authKind: "oauth" };

function loaded(
	doc: Pick<BlueprintDoc, "connectType" | "modules">,
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
});

describe("registerGetAppFeatureFlags", () => {
	it("returns only the app's requirements with reasons and self-contained help", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(
			loaded({
				connectType: "learn",
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
		registerGetAppFeatureFlags(server, toolCtx);
		const payload = parseResult(await capture()({ app_id: "app-1" }, {}));
		const flags = payload.required_flags as Array<{
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
			support_email: "support@dimagi.com",
			docs_url: "https://docs.commcare.app/feature-flags",
		});
		expect(payload.message).toContain(
			"requirements, not flags known to be off",
		);
		expect(loadAppBlueprint).toHaveBeenCalledWith("app-1", "u1");
		expect(registeredConfig()).toMatchObject({
			description: expect.stringContaining(
				"does not claim any flag is enabled or missing",
			),
		});
	});

	it("returns a quiet, explicit result when the app needs no flags", async () => {
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(
			loaded({ connectType: null, modules: {} }),
		);
		const { server, capture } = makeFakeServer();
		registerGetAppFeatureFlags(server, toolCtx);

		const payload = parseResult(await capture()({ app_id: "app-1" }, {}));

		expect(payload.required_flags).toEqual([]);
		expect(payload.domain_checked).toBe(false);
		expect(payload.message).toBe(
			"This app does not currently use a Nova feature that needs a CommCare HQ feature flag.",
		);
	});

	it("preserves the shared ownership-hardened error envelope", async () => {
		vi.mocked(loadAppBlueprint).mockRejectedValueOnce(
			new McpAccessError("not_owner"),
		);
		const { server, capture } = makeFakeServer();
		registerGetAppFeatureFlags(server, toolCtx);

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
