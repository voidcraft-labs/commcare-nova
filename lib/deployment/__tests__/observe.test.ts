/**
 * What Nova reports after asking CommCare HQ what happened to an app.
 *
 * The load-bearing checks here are the ones that stop Nova overstating:
 * a build older than the app is NOT built, an unreleased newest build is
 * NOT released, and the probe never touches the working app's id — which
 * would make CommCare HQ start a whole new build.
 *
 * The probe's own failure split matters too: a redirecting project space
 * or an unwell CommCare HQ must read as "could not check", never as
 * "this build is broken".
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

function checked(result: Awaited<ReturnType<typeof observeDeployment>>) {
	if (result.kind !== "checked") {
		throw new Error(`expected a checked result, got: ${result.message}`);
	}
	return result;
}

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
	it("names a deleted app as the UPLOAD undone, so nothing claims it is still there", async () => {
		/* Filing this under `build` left the resume state at `uploaded`,
		 * because `build`'s entry state is `uploaded` — so every surface
		 * went on reporting an app that no longer exists as sitting on the
		 * project space, with a link to a page that 404s. */
		vi.mocked(readAppVersions).mockResolvedValue({
			success: false,
			status: 404,
		} as never);

		const result = checked(await observeDeployment(INPUT));

		const upload = outcomeFor(result.outcomes, "upload");
		expect(upload?.status).toBe("failed");
		expect(outcomeFor(result.outcomes, "build")).toBeUndefined();
		expect(result.outcomes).toHaveLength(1);
	});

	it("writes nothing when CommCare HQ could not be asked", async () => {
		// A blip must not walk a runnable deployment down and tell every
		// member of the Project their app is refused.
		vi.mocked(readAppVersions).mockResolvedValue({
			success: false,
			status: 503,
		} as never);

		const result = await observeDeployment(INPUT);
		expect(result.kind).toBe("unavailable");
	});

	it("confirms the upload rung on every answered pass", async () => {
		/* Answering the versions read at all proves the app is there — which
		 * is also what heals a deployment CommCare HQ once reported missing,
		 * after its app is restored through HQ's own undo. */
		vi.mocked(readAppVersions).mockResolvedValue({
			currentVersion: 1,
			latestBuildVersion: null,
			latestReleasedVersion: null,
		} as never);

		const result = checked(await observeDeployment(INPUT));
		expect(outcomeFor(result.outcomes, "upload")?.status).toBe("succeeded");
	});
});

describe("build", () => {
	it("is pending when CommCare HQ has built nothing", async () => {
		vi.mocked(readAppVersions).mockResolvedValue({
			currentVersion: 1,
			latestBuildVersion: null,
			latestReleasedVersion: null,
		} as never);

		const result = checked(await observeDeployment(INPUT));

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

		const result = checked(await observeDeployment(INPUT));

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

		const result = checked(await observeDeployment(INPUT));

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

		const result = checked(await observeDeployment(INPUT));

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

		const result = checked(await observeDeployment(INPUT));

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
			ok: false,
			reason: "not-installable",
		} as never);

		const result = checked(await observeDeployment(INPUT));

		const probe = outcomeFor(result.outcomes, "probe");
		expect(probe?.status).toBe("failed");
		expect(
			(probe as unknown as { failure: { code: string } }).failure.code,
		).toBe("build_not_installable");
	});

	it("keeps the confirmed rungs on a redirect, rather than calling the build broken", async () => {
		/* A project space carrying a `redirect_url` answers 302 to every
		 * download. Calling that a broken build would accuse a healthy
		 * deployment — and discarding the whole pass over it stranded such a
		 * project space at `uploaded` forever, because its probe request
		 * would never succeed however many times someone checked. The
		 * version and release CommCare HQ confirmed seconds earlier stand,
		 * and the probe says why it is unconfirmed. */
		vi.mocked(listAppBuilds).mockResolvedValue([
			{ id: "build-live", version: 2, isReleased: true },
		] as never);
		vi.mocked(probeBuildProfile).mockResolvedValue({
			ok: false,
			reason: "unavailable",
		} as never);

		const result = checked(await observeDeployment(INPUT));

		expect(outcomeFor(result.outcomes, "build")?.status).toBe("succeeded");
		expect(outcomeFor(result.outcomes, "release")?.status).toBe("succeeded");
		const probe = outcomeFor(result.outcomes, "probe");
		expect(probe).toMatchObject({
			status: "pending",
			reason: expect.stringMatching(/didn't answer/i),
		});
		expect(result.releasedBuildId).toBe("build-live");
	});

	it("keeps the build and release it already confirmed when only the build list is unreadable", async () => {
		/* This read needs the Access APIs permission. Discarding the whole
		 * pass because of it threw away answers CommCare HQ had ALREADY
		 * given on the same call, so an account without that permission
		 * could never move past `uploaded` no matter how many times it
		 * checked. Only the probe is unconfirmed. */
		vi.mocked(listAppBuilds).mockResolvedValue({
			success: false,
			status: 403,
		} as never);

		const result = checked(await observeDeployment(INPUT));

		expect(outcomeFor(result.outcomes, "build")?.status).toBe("succeeded");
		expect(outcomeFor(result.outcomes, "release")?.status).toBe("succeeded");
		const probe = outcomeFor(result.outcomes, "probe");
		expect(probe).toMatchObject({
			status: "pending",
			reason: expect.stringMatching(/Access APIs permission/i),
		});
		expect(probeBuildProfile).not.toHaveBeenCalled();
	});

	it("blames a build-list blip on CommCare HQ, not on the account's permissions", async () => {
		/* A 5xx from the build-list read is CommCare HQ being unwell, not a
		 * missing permission. Telling somebody to go ask their administrator
		 * for a permission they already hold sends them on an errand that
		 * cannot help. */
		vi.mocked(listAppBuilds).mockResolvedValue({
			success: false,
			status: 500,
		} as never);

		const result = checked(await observeDeployment(INPUT));

		const probe = outcomeFor(result.outcomes, "probe");
		expect(probe).toMatchObject({
			status: "pending",
			reason: expect.stringMatching(/didn't answer/i),
		});
		expect((probe as unknown as { reason: string }).reason).not.toMatch(
			/permission/i,
		);
	});

	it("waits rather than guessing when the released build is not listed yet", async () => {
		vi.mocked(listAppBuilds).mockResolvedValue([
			{ id: "build-old", version: 1, isReleased: false },
		] as never);

		const result = checked(await observeDeployment(INPUT));

		expect(outcomeFor(result.outcomes, "probe")?.status).toBe("pending");
		expect(probeBuildProfile).not.toHaveBeenCalled();
	});
});
