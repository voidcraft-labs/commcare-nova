import { describe, expect, it } from "vitest";
import type { CommCareServer } from "@/lib/commcare/servers";
import { resolvePreviewFactsTarget } from "../previewTarget";
import type { DeploymentPhase, DeploymentRecord } from "../types";

type FactsRecord = Pick<
	DeploymentRecord,
	"state" | "resumePhase" | "server" | "domain"
>;

const deployment = (
	state: DeploymentRecord["state"],
	domain = "acme",
	server: CommCareServer = "production",
	resumePhase: DeploymentPhase | null = null,
): FactsRecord => ({ state, domain, server, resumePhase });

describe("resolvePreviewFactsTarget", () => {
	it("names the one deployment that displays as uploaded", () => {
		expect(resolvePreviewFactsTarget([deployment("runnable")])).toEqual({
			server: "production",
			domain: "acme",
		});
		/* A probe that failed after the upload did not undo it. */
		expect(
			resolvePreviewFactsTarget([
				deployment("incomplete", "acme", "eu", "probe"),
			]),
		).toEqual({ server: "eu", domain: "acme" });
		/* Deployments that never reached the project space count for nothing. */
		expect(
			resolvePreviewFactsTarget([
				deployment("uploaded"),
				deployment("preflight", "beta"),
				deployment("incomplete", "gamma", "production", "upload"),
			]),
		).toEqual({ server: "production", domain: "acme" });
	});

	it("names none where no deployment reached a project space", () => {
		expect(resolvePreviewFactsTarget([])).toBeNull();
		expect(
			resolvePreviewFactsTarget([
				deployment("preflight"),
				deployment("incomplete", "beta", "production", "resources"),
			]),
		).toBeNull();
	});

	it("names none where two domains hold the app", () => {
		expect(
			resolvePreviewFactsTarget([
				deployment("runnable", "acme"),
				deployment("uploaded", "beta"),
			]),
		).toBeNull();
	});

	it("names none where one domain on two servers holds the app", () => {
		expect(
			resolvePreviewFactsTarget([
				deployment("runnable", "acme", "production"),
				deployment("released", "acme", "india"),
			]),
		).toBeNull();
	});
});
