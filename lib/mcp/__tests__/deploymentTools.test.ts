/**
 * `get_deployment` and `refresh_deployment` unit tests.
 *
 * What these lock is the PUBLIC contract three different clients branch on
 * — the wire shape, the scope each tool demands, and the error tag every
 * refusal carries. `content/docs/mcp/tools.mdx` documents all three, so a
 * silent change to any of them breaks somebody's integration without
 * breaking a build.
 *
 * The scope split is the load-bearing one. Reading is `nova.hq.read`;
 * refreshing takes `nova.hq.write` AND `edit` on the app, because it
 * persists what it observed and a read-scoped token must not be able to
 * knock a `runnable` deployment to `incomplete` for every member of a
 * Project. Adoption takes both because it decides what a later publish may
 * replace.
 *
 * The service boundary is mocked: these prove the tool layer, not the
 * lifecycle, which `publishLifecycle.test.ts` and the store's integration
 * suite own.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { DeploymentError } from "@/lib/deployment/errors";
import {
	artifactLocations,
	currentResourceIdentities,
	refreshDeployment,
	setupArtifactFor,
} from "@/lib/deployment/service";
import { readDeploymentsForApp } from "@/lib/deployment/store";
import type {
	DeploymentRecord,
	DeploymentWithResources,
} from "@/lib/deployment/types";
import { NO_DEPLOYMENT_PHASE_OUTCOMES } from "@/lib/deployment/types";
import { loadAppBlueprint } from "../loadApp";
import { SCOPES } from "../scopes";
import {
	registerGetDeployment,
	registerRefreshDeployment,
} from "../tools/deploymentTools";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

vi.mock("@/lib/deployment/service", () => ({
	artifactLocations: vi.fn(async () => []),
	currentResourceIdentities: vi.fn(async () => new Map()),
	refreshDeployment: vi.fn(),
	setupArtifactFor: vi.fn(async () => ({ domain: "acme", sections: [] })),
}));
vi.mock("@/lib/deployment/store", () => ({
	readDeploymentsForApp: vi.fn(),
}));
vi.mock("../loadApp", () => ({ loadAppBlueprint: vi.fn() }));

const ACCESS = { projectId: "p1", role: "owner" };

function record(over: Partial<DeploymentRecord> = {}): DeploymentRecord {
	return {
		id: "d1",
		appId: "a1",
		projectId: "p1",
		server: "production",
		domain: "acme",
		state: "uploaded",
		resumePhase: null,
		phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
		createdBy: "u1",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		lastObservedAt: null,
		...over,
	};
}

function withResources(
	over: Partial<DeploymentRecord> = {},
): DeploymentWithResources {
	return { deployment: record(over), active: [], superseded: [] };
}

function ctx(scopes: string[]): ToolContext {
	return { userId: "u1", scopes, authKind: "oauth" };
}

function parse(out: unknown): Record<string, unknown> {
	const envelope = out as { content: Array<{ type: "text"; text: string }> };
	return JSON.parse(envelope.content[0]?.text ?? "{}") as Record<
		string,
		unknown
	>;
}

function isError(out: unknown): boolean {
	return (out as { isError?: boolean }).isError === true;
}

beforeEach(() => {
	vi.mocked(loadAppBlueprint).mockReset();
	vi.mocked(readDeploymentsForApp).mockReset();
	vi.mocked(refreshDeployment).mockReset();
	vi.mocked(setupArtifactFor).mockClear();
	vi.mocked(artifactLocations).mockClear();
	vi.mocked(currentResourceIdentities).mockClear();
	vi.mocked(loadAppBlueprint).mockResolvedValue({
		doc: {},
		access: ACCESS,
	} as never);
});

describe("get_deployment", () => {
	it("reports every project space with its state, retry point, and setup artifact", async () => {
		vi.mocked(readDeploymentsForApp).mockResolvedValueOnce([
			withResources({ state: "runnable" }),
			withResources({
				id: "d2",
				domain: "beta",
				state: "incomplete",
				resumePhase: "release",
			}),
		]);

		const { server, capture } = makeFakeServer();
		registerGetDeployment(server, ctx([SCOPES.hqRead]));
		const parsed = parse(await capture()({ app_id: "a1" }));

		expect(parsed.app_id).toBe("a1");
		const deployments = parsed.deployments as Array<Record<string, unknown>>;
		expect(deployments).toHaveLength(2);
		expect(deployments[0]).toMatchObject({
			domain: "acme",
			state: "runnable",
		});
		expect(deployments[0]?.retry_from).toBeNull();
		expect(deployments[1]).toMatchObject({
			domain: "beta",
			state: "incomplete",
			retry_from: "release",
		});
		expect(deployments[0]).toHaveProperty("setup_artifact");
	});

	it("reads with the VIEW capability, so a viewer can see where the app stands", async () => {
		vi.mocked(readDeploymentsForApp).mockResolvedValueOnce([]);

		const { server, capture } = makeFakeServer();
		registerGetDeployment(server, ctx([SCOPES.hqRead]));
		await capture()({ app_id: "a1" });

		expect(loadAppBlueprint).toHaveBeenCalledWith("a1", "u1", "view");
	});

	it("skips the artifact and its place read when nothing has been published", async () => {
		vi.mocked(readDeploymentsForApp).mockResolvedValueOnce([]);

		const { server, capture } = makeFakeServer();
		registerGetDeployment(server, ctx([SCOPES.hqRead]));
		const parsed = parse(await capture()({ app_id: "a1" }));

		expect(parsed.deployments).toEqual([]);
		expect(setupArtifactFor).not.toHaveBeenCalled();
		expect(artifactLocations).not.toHaveBeenCalled();
		expect(currentResourceIdentities).not.toHaveBeenCalled();
	});

	it("reads the app's places ONCE for every project space it reports", async () => {
		/* The places belong to the app, not to any one target, so three
		 * deployments must not cost three reads of the same rows. */
		vi.mocked(readDeploymentsForApp).mockResolvedValueOnce([
			withResources(),
			withResources({ id: "d2", domain: "beta" }),
			withResources({ id: "d3", domain: "gamma" }),
		]);

		const { server, capture } = makeFakeServer();
		registerGetDeployment(server, ctx([SCOPES.hqRead]));
		await capture()({ app_id: "a1" });

		expect(artifactLocations).toHaveBeenCalledTimes(1);
		/* Same reasoning for the lookup identities: they are the app's, not
		 * any one project space's. */
		expect(currentResourceIdentities).toHaveBeenCalledTimes(1);
		expect(setupArtifactFor).toHaveBeenCalledTimes(3);
	});

	it("refuses without the HQ read scope", async () => {
		const { server, capture } = makeFakeServer();
		registerGetDeployment(server, ctx([SCOPES.read]));
		const out = await capture()({ app_id: "a1" });

		expect(isError(out)).toBe(true);
		expect(readDeploymentsForApp).not.toHaveBeenCalled();
	});
});

describe("refresh_deployment", () => {
	it("needs the HQ WRITE scope, because it persists what it observed", async () => {
		const { server, capture } = makeFakeServer();
		registerRefreshDeployment(server, ctx([SCOPES.hqRead]));
		const out = await capture()({
			app_id: "a1",
			server: "production",
			domain: "acme",
		});

		expect(isError(out)).toBe(true);
		expect(refreshDeployment).not.toHaveBeenCalled();
	});

	it("authorizes the app as an edit and returns the updated record", async () => {
		vi.mocked(refreshDeployment).mockResolvedValueOnce({
			deployment: withResources({ state: "released" }),
			artifact: { domain: "acme", sections: [] },
		} as never);

		const { server, capture } = makeFakeServer();
		registerRefreshDeployment(server, ctx([SCOPES.hqWrite]));
		const parsed = parse(
			await capture()({ app_id: "a1", server: "production", domain: "acme" }),
		);

		expect(loadAppBlueprint).toHaveBeenCalledWith("a1", "u1", "edit");
		expect(refreshDeployment).toHaveBeenCalledWith(
			expect.objectContaining({ appId: "a1", projectId: "p1" }),
			{ server: "production", domain: "acme" },
			expect.anything(),
		);
		expect(parsed).toMatchObject({ app_id: "a1", state: "released" });
	});

	it("registers the browser boundary's own wire shapes as its inputs", async () => {
		/* The trim and cap live in the REGISTERED schema, which the real MCP
		 * server runs before the handler: a stray space would otherwise miss
		 * the record and read as "never published there", and a whitespace-only
		 * domain would sail through where the Server Action refuses it. The
		 * fake harness calls the handler raw, so the contract is proved on the
		 * registered config itself. */
		const { server, registeredConfig } = makeFakeServer();
		registerRefreshDeployment(server, ctx([SCOPES.hqWrite]));
		const shape = (
			registeredConfig() as {
				inputSchema: z.ZodObject<{
					app_id: z.ZodType<string>;
					domain: z.ZodType<string>;
				}>;
			}
		).inputSchema.shape;

		expect(shape.app_id.parse(" a1 ")).toBe("a1");
		expect(shape.domain.parse(" acme ")).toBe("acme");
		expect(() => shape.domain.parse("   ")).toThrow();
		expect(() => shape.domain.parse("x".repeat(256))).toThrow();
	});

	it("names the project space when the app was never published there", async () => {
		vi.mocked(refreshDeployment).mockResolvedValueOnce(null);

		const { server, capture } = makeFakeServer();
		registerRefreshDeployment(server, ctx([SCOPES.hqWrite]));
		const out = await capture()({
			app_id: "a1",
			server: "production",
			domain: "acme",
		});

		expect(isError(out)).toBe(true);
		const text = (out as { content: Array<{ text: string }> }).content[0]?.text;
		expect(text).toContain("acme");
		expect(text).toContain("get_deployment");
	});

	it("carries a could-not-check through as its own sentence, not a generic failure", async () => {
		vi.mocked(refreshDeployment).mockRejectedValueOnce(
			new DeploymentError(
				"invalid",
				"Nova couldn't reach CommCare HQ to check on this app.",
			),
		);

		const { server, capture } = makeFakeServer();
		registerRefreshDeployment(server, ctx([SCOPES.hqWrite]));
		const out = await capture()({
			app_id: "a1",
			server: "production",
			domain: "acme",
		});

		expect(isError(out)).toBe(true);
		expect(
			(out as { content: Array<{ text: string }> }).content[0]?.text,
		).toContain("couldn't reach CommCare HQ");
	});
});
