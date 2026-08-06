/**
 * What Nova reports after asking CommCare HQ what happened to an app.
 *
 * The load-bearing checks here are the ones that stop Nova overstating:
 * a build older than the app is NOT built, an unreleased newest build is
 * NOT released, and the probe never touches the working app's id — which
 * would make `download_odk_profile` call `autogenerate_build` and turn a
 * read into a write.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	listAppBuilds,
	probeBuildProfile,
	readAppVersions,
} from "@/lib/commcare/client";
import { observeDeployment } from "../observe";

vi.mock("@/lib/commcare/client", () => ({
	readAppVersions: vi.fn(),
	listAppBuilds: vi.fn(),
	probeBuildProfile: vi.fn(),
}));

const INPUT = {
	creds: { username: "u", apiKey: "k", server: "production" as const },
	domain: "acme",
	hqAppId: "hq-app",
	now: "2026-08-06T00:00:00.000Z",
};

function outcomeFor(
	outcomes: readonly (readonly [string, { status: string }])[],
	phase: string,
) {
	return outcomes.find(([name]) => name === phase)?.[1];
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(probeBuildProfile).mockResolvedValue({ ok: true } as never);
});

describe("reaching CommCare HQ", () => {
	it("names a deleted app as missing, not as a connection problem", async () => {
		vi.mocked(readAppVersions).mockResolvedValue({
			success: false,
			status: 404,
		} as never);

		const result = await observeDeployment(INPUT);

		const build = outcomeFor(result.outcomes, "build");
		expect(build?.status).toBe("failed");
		expect(result.outcomes).toHaveLength(1);
	});

	it("treats any other failure as unreachable rather than missing", async () => {
		vi.mocked(readAppVersions).mockResolvedValue({
			success: false,
			status: 503,
		} as never);

		const result = await observeDeployment(INPUT);
		const build = outcomeFor(result.outcomes, "build");
		expect(build).toMatchObject({ status: "failed" });
	});
});

describe("build", () => {
	it("is pending when CommCare HQ has built nothing", async () => {
		vi.mocked(readAppVersions).mockResolvedValue({
			currentVersion: 1,
			latestBuildVersion: null,
			latestReleasedVersion: null,
		} as never);

		const result = await observeDeployment(INPUT);

		expect(outcomeFor(result.outcomes, "build")?.status).toBe("pending");
		expect(result.remoteRevision).toBe(1);
		expect(listAppBuilds).not.toHaveBeenCalled();
	});

	it("is pending when the newest build is older than the app itself", async () => {
		vi.mocked(readAppVersions).mockResolvedValue({
			currentVersion: 4,
			latestBuildVersion: 2,
			latestReleasedVersion: 2,
		} as never);

		const result = await observeDeployment(INPUT);

		const build = outcomeFor(result.outcomes, "build");
		expect(build?.status).toBe("pending");
		expect((build as unknown as { reason: string }).reason).toMatch(
			/version 2 of 4/,
		);
		// A stale build must not be reported as released either.
		expect(outcomeFor(result.outcomes, "release")).toBeUndefined();
	});
});

describe("release", () => {
	it("is pending when the newest build is not released", async () => {
		vi.mocked(readAppVersions).mockResolvedValue({
			currentVersion: 3,
			latestBuildVersion: 3,
			latestReleasedVersion: null,
		} as never);

		const result = await observeDeployment(INPUT);

		expect(outcomeFor(result.outcomes, "build")?.status).toBe("succeeded");
		expect(outcomeFor(result.outcomes, "release")?.status).toBe("pending");
		expect(probeBuildProfile).not.toHaveBeenCalled();
	});

	it("is pending when an older build is released but the newest is not", async () => {
		vi.mocked(readAppVersions).mockResolvedValue({
			currentVersion: 5,
			latestBuildVersion: 5,
			latestReleasedVersion: 3,
		} as never);

		const result = await observeDeployment(INPUT);

		const release = outcomeFor(result.outcomes, "release");
		expect(release?.status).toBe("pending");
		expect((release as unknown as { reason: string }).reason).toMatch(
			/released version 3/,
		);
	});
});

describe("probe", () => {
	beforeEach(() => {
		vi.mocked(readAppVersions).mockResolvedValue({
			currentVersion: 2,
			latestBuildVersion: 2,
			latestReleasedVersion: 2,
		} as never);
	});

	it("fetches the RELEASED BUILD's profile, never the working app's", async () => {
		vi.mocked(listAppBuilds).mockResolvedValue([
			{ id: "build-old", version: 1, isReleased: false },
			{ id: "build-live", version: 2, isReleased: true },
		] as never);

		const result = await observeDeployment(INPUT);

		expect(probeBuildProfile).toHaveBeenCalledWith(
			INPUT.creds,
			"acme",
			"build-live",
		);
		// The working app's id would make CommCare HQ start a build.
		expect(probeBuildProfile).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			"hq-app",
		);
		expect(outcomeFor(result.outcomes, "probe")?.status).toBe("succeeded");
		expect(result.releasedBuildId).toBe("build-live");
	});

	it("fails, rather than passing, when the released build serves nothing", async () => {
		vi.mocked(listAppBuilds).mockResolvedValue([
			{ id: "build-live", version: 2, isReleased: true },
		] as never);
		vi.mocked(probeBuildProfile).mockResolvedValue({
			success: false,
			status: 404,
		} as never);

		const result = await observeDeployment(INPUT);

		expect(outcomeFor(result.outcomes, "probe")?.status).toBe("failed");
	});

	it("says it could not check when the build list is unreadable", async () => {
		vi.mocked(listAppBuilds).mockResolvedValue({
			success: false,
			status: 403,
		} as never);

		const result = await observeDeployment(INPUT);

		const probe = outcomeFor(result.outcomes, "probe");
		expect(probe?.status).toBe("failed");
		expect(probeBuildProfile).not.toHaveBeenCalled();
	});

	it("waits rather than guessing when the released build is not listed yet", async () => {
		vi.mocked(listAppBuilds).mockResolvedValue([
			{ id: "build-old", version: 1, isReleased: false },
		] as never);

		const result = await observeDeployment(INPUT);

		expect(outcomeFor(result.outcomes, "probe")?.status).toBe("pending");
		expect(probeBuildProfile).not.toHaveBeenCalled();
	});
});
