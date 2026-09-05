import { describe, expect, it } from "vitest";
import {
	downloadDeploymentTarget,
	downloadRuntimeTarget,
} from "../runtimeTarget";

describe("download runtime target", () => {
	it("requires a choice without one deployed space", () => {
		expect(downloadRuntimeTarget({ kind: "none" })).toBeUndefined();
		expect(
			downloadRuntimeTarget({
				kind: "ambiguous",
				targets: [
					{ server: "india", domain: "clinic" },
					{ server: "eu", domain: "clinic" },
				],
			}),
		).toBeUndefined();
	});
	it("reuses the exact known space", () => {
		expect(
			downloadRuntimeTarget({
				kind: "known",
				target: { server: "india", domain: "clinic" },
			}),
		).toEqual({ server: "india", domain: "clinic" });
	});
	it("keeps a changed server portable instead of retaining the other server's domain", () => {
		expect(
			downloadRuntimeTarget(
				{ kind: "known", target: { server: "india", domain: "clinic" } },
				"eu",
			),
		).toEqual({ server: "eu" });
	});
});

it("selects the matching server among deployed spaces and aligns attachments", () => {
	const deployments = {
		kind: "ambiguous" as const,
		targets: [
			{ server: "india" as const, domain: "clinic" },
			{ server: "eu" as const, domain: "europe" },
		],
	};
	expect(downloadRuntimeTarget(deployments, "eu")).toEqual({
		server: "eu",
		domain: "europe",
	});
	expect(downloadDeploymentTarget(deployments, "eu")).toEqual({
		kind: "known",
		target: { server: "eu", domain: "europe" },
	});
	expect(downloadDeploymentTarget(deployments, "production")).toEqual({
		kind: "none",
	});
});
