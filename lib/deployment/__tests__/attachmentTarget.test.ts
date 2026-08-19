/**
 * Which CommCare HQ address an attachment link may honestly name.
 *
 * Two answers here are load-bearing and neither is obvious from the
 * function's shape:
 *
 *   - Distinctness is over the server AND the project space. The sibling
 *     `previewTarget.ts` de-dupes on the space alone, which is right for a
 *     `commcare_project` slug and wrong for an origin: CommCare's US,
 *     India, and EU installations share no account database, so two of them
 *     can hold unrelated project spaces of the same name.
 *   - A failed probe does not withdraw the target. The upload it comes
 *     after is what an attachment link depends on, and letting a transient
 *     "Nova could not check" drop the target would silently stop a form
 *     writing case data for a reason that has nothing to do with the app.
 */

import { describe, expect, it } from "vitest";
import {
	attachmentUrlTarget,
	attachmentUrlTargetFor,
	resolveAttachmentDeploymentTarget,
} from "../attachmentTarget";
import type { DeploymentRecord } from "../types";

type TargetRecord = Pick<
	DeploymentRecord,
	"state" | "resumePhase" | "server" | "domain"
>;

function deployment(
	state: string,
	domain: string,
	server: DeploymentRecord["server"] = "production",
	resumePhase: string | null = null,
): TargetRecord {
	return { state, domain, server, resumePhase } as unknown as TargetRecord;
}

describe("resolveAttachmentDeploymentTarget", () => {
	it("names the one project space that holds the app", () => {
		expect(
			resolveAttachmentDeploymentTarget([deployment("uploaded", "acme")]),
		).toEqual({
			kind: "known",
			target: { server: "production", domain: "acme" },
		});
	});

	it("says nothing while the app is on no project space", () => {
		expect(
			resolveAttachmentDeploymentTarget([deployment("preflight", "acme")]),
		).toEqual({ kind: "none" });
	});

	it("says nothing when a publish was refused before the app got there", () => {
		expect(
			resolveAttachmentDeploymentTarget([
				deployment("incomplete", "acme", "production", "upload"),
			]),
		).toEqual({ kind: "none" });
	});

	it("keeps the target when a LATER phase could not be checked", () => {
		expect(
			resolveAttachmentDeploymentTarget([
				deployment("incomplete", "acme", "production", "probe"),
			]),
		).toEqual({
			kind: "known",
			target: { server: "production", domain: "acme" },
		});
	});

	it("collapses repeated publishes to the same place", () => {
		// One app republished to one project space is one answer, however many
		// deployment rows the lifecycle wrote along the way.
		expect(
			resolveAttachmentDeploymentTarget([
				deployment("uploaded", "acme"),
				deployment("released", "acme"),
				deployment("runnable", "acme"),
			]),
		).toEqual({
			kind: "known",
			target: { server: "production", domain: "acme" },
		});
	});

	it("refuses to choose between two project spaces", () => {
		const resolved = resolveAttachmentDeploymentTarget([
			deployment("runnable", "acme"),
			deployment("uploaded", "beta"),
		]);
		expect(resolved.kind).toBe("ambiguous");
		if (resolved.kind !== "ambiguous") return;
		expect(resolved.targets).toEqual([
			{ server: "production", domain: "acme" },
			{ server: "production", domain: "beta" },
		]);
	});

	it("treats the same project-space name on two servers as two answers", () => {
		// The failure this catches is invisible in the resolved slug: picking
		// either origin builds links that open for one set of workers and
		// resolve nowhere for the other.
		const resolved = resolveAttachmentDeploymentTarget([
			deployment("uploaded", "acme", "production"),
			deployment("uploaded", "acme", "india"),
		]);
		expect(resolved.kind).toBe("ambiguous");
		if (resolved.kind !== "ambiguous") return;
		expect(resolved.targets).toEqual([
			{ server: "production", domain: "acme" },
			{ server: "india", domain: "acme" },
		]);
	});
});

describe("attachmentUrlTarget", () => {
	it("resolves each server id to its own origin", () => {
		expect(
			attachmentUrlTarget({ server: "production", domain: "acme" }),
		).toEqual({ origin: "https://www.commcarehq.org", domain: "acme" });
		expect(attachmentUrlTarget({ server: "india", domain: "acme" })).toEqual({
			origin: "https://india.commcarehq.org",
			domain: "acme",
		});
		expect(attachmentUrlTarget({ server: "eu", domain: "acme" })).toEqual({
			origin: "https://eu.commcarehq.org",
			domain: "acme",
		});
	});
});

describe("attachmentUrlTargetFor", () => {
	it("supplies the two halves only when Nova knows both", () => {
		expect(
			attachmentUrlTargetFor({
				kind: "known",
				target: { server: "eu", domain: "acme" },
			}),
		).toEqual({ origin: "https://eu.commcarehq.org", domain: "acme" });
	});

	it("withholds them rather than guessing", () => {
		// `null` means the property is not written at all — not written empty,
		// and never against a placeholder origin. A link that looks deliberate
		// and resolves nowhere is worse than no link.
		expect(attachmentUrlTargetFor({ kind: "none" })).toBeNull();
		expect(
			attachmentUrlTargetFor({
				kind: "ambiguous",
				targets: [
					{ server: "production", domain: "acme" },
					{ server: "india", domain: "acme" },
				],
			}),
		).toBeNull();
	});
});
