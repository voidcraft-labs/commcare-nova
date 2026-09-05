import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	listAppBuilds,
	probeHqProjectSpaceCompatibility,
	readAppVersions,
	readBuildXml,
} from "@/lib/commcare/client";
import { endpointSuiteSignature } from "@/lib/commcare/entryPointSignature";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { entryPointInventory } from "@/lib/domain";
import { entryPointArguments, getEntryPointLink } from "../entryPointLinks";
import type { PublishedEntryPoint } from "../entryPointTypes";
import { activeRemoteApp } from "../resources";
import {
	readDeployment,
	readEntryPointEvidence,
	recordEntryPointObservation,
} from "../store";

vi.mock("../store", () => ({
	readEntryPointEvidence: vi.fn(),
	readDeployment: vi.fn(),
	recordEntryPointObservation: vi.fn(),
}));
vi.mock("@/lib/commcare/client", () => ({
	readAppVersions: vi.fn(),
	listAppBuilds: vi.fn(),
	readBuildXml: vi.fn(),
	probeHqProjectSpaceCompatibility: vi.fn(),
}));
vi.mock("@/lib/db/settings", () => ({ getCredentialsForUpload: vi.fn() }));
vi.mock("@/lib/domain", () => ({ entryPointInventory: vi.fn() }));
vi.mock("@/lib/commcare/entryPointSignature", () => ({
	endpointSuiteSignature: vi.fn(),
}));
vi.mock("@/lib/commcare/projectSpaceCompatibility", () => ({
	projectSpaceCompatibilityProbePlan: () => ({}),
}));
vi.mock("../resources", () => ({ activeRemoteApp: vi.fn() }));
const entry: PublishedEntryPoint = {
	target: { kind: "module", moduleUuid: "module" as never },
	uuid: "entry",
	id: "visit",
	signature: "expected",
	requiredSelections: [
		{
			moduleUuid: "module",
			caseType: "person",
			argumentId: "case_id",
			cardinality: "multiple",
			maximum: 3,
		},
	],
};
describe("endpoint collection transport", () => {
	it("preserves case order and encodes the whole comma separated value", () => {
		expect(
			entryPointArguments(entry, [
				{ moduleUuid: "module", caseIds: ["b /?", "a"] },
			]).toString(),
		).toBe("case_id=b+%2F%3F%2Ca");
	});
	it.each(
		[[], [""], ["a", "a"], ["a,b"], ["a", "b", "c", "d"]].map((caseIds) => ({
			caseIds,
		})),
	)("rejects ambiguous or invalid IDs %j", ({ caseIds }) => {
		expect(() =>
			entryPointArguments(entry, [{ moduleUuid: "module", caseIds }]),
		).toThrow();
	});
	it("rejects extra and duplicate module selections", () => {
		expect(() =>
			entryPointArguments(entry, [
				{ moduleUuid: "module", caseIds: ["a"] },
				{ moduleUuid: "module", caseIds: ["b"] },
			]),
		).toThrow();
	});
	it("accepts an endpoint with no selections", () => {
		expect(
			entryPointArguments({ ...entry, requiredSelections: [] }, []).toString(),
		).toBe("");
	});
});

describe("fresh released-build checks", () => {
	const input = {
		scope: {
			appId: "app",
			projectId: "project",
			role: "owner",
			actorUserId: "user",
		},
		target: { server: "india" as const, domain: "demo" },
		doc: {} as Parameters<typeof getEntryPointLink>[0]["doc"],
		sourceSequence: 3,
		entryPointUuid: "entry",
		selections: [{ moduleUuid: "module", caseIds: ["b", "a"] }],
	};
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(readDeployment).mockResolvedValue({ active: [] } as never);
		vi.mocked(activeRemoteApp).mockReturnValue({
			remoteId: "working",
		} as never);
		vi.mocked(readEntryPointEvidence).mockResolvedValue({
			generation: "generation",
			manifest: {
				generation: "generation",
				remoteAppId: "working",
				sourceSequence: 3,
				entries: [entry],
				dependencies: [],
			},
			observation: null,
		});
		vi.mocked(entryPointInventory).mockReturnValue([
			{ target: entry.target, entryPoint: { uuid: "entry", id: "visit" } },
		] as never);
		vi.mocked(getCredentialsForUpload).mockResolvedValue({
			ok: true,
			creds: { server: "india" },
		} as never);
		vi.mocked(probeHqProjectSpaceCompatibility).mockResolvedValue({
			report: {
				required_capabilities: [{ id: "deep-links", state: "available" }],
			},
		} as never);
		vi.mocked(readAppVersions).mockResolvedValue({
			currentVersion: 4,
			latestBuildVersion: 4,
			latestReleasedVersion: 3,
		});
		vi.mocked(listAppBuilds).mockResolvedValue([
			{
				id: "exact-build",
				version: 3,
				isReleased: true,
				builtOn: null,
				buildComment: null,
			},
		]);
		vi.mocked(readBuildXml).mockImplementation(
			async (_creds, _domain, _build, resource) => ({
				xml:
					resource === "profile.ccpr"
						? '<profile><suite><resource id="suite"><location authority="remote">https://india.commcarehq.org/a/demo/apps/download/exact-build/suite.xml</location></resource></suite></profile>'
						: "<suite/>",
			}),
		);
		vi.mocked(endpointSuiteSignature).mockReturnValue("expected");
		vi.mocked(recordEntryPointObservation).mockResolvedValue(true);
	});
	it("uses the selected server and working app URL after reading only exact released resources", async () => {
		const result = await getEntryPointLink(input);
		expect(result.url).toBe(
			"https://india.commcarehq.org/a/demo/app/v1/working/visit/?case_id=b%2Ca",
		);
		expect(readBuildXml).toHaveBeenCalledWith(
			expect.anything(),
			"demo",
			"exact-build",
			"suite.xml",
		);
		expect(readBuildXml).toHaveBeenCalledWith(
			expect.anything(),
			"demo",
			"exact-build",
			"profile.ccpr",
		);
	});
	it("withholds a link when the released endpoint has drifted", async () => {
		vi.mocked(endpointSuiteSignature).mockReturnValue("different");
		await expect(getEntryPointLink(input)).rejects.toThrow(/doesn't match/);
		expect(recordEntryPointObservation).not.toHaveBeenCalled();
	});
	it("withholds a link if a concurrent content write invalidated verification", async () => {
		vi.mocked(recordEntryPointObservation).mockResolvedValue(false);
		await expect(getEntryPointLink(input)).rejects.toThrow(/changed while/);
	});
	it("does not replace old historical observations on a transient read failure", async () => {
		vi.mocked(readBuildXml).mockResolvedValue({ success: false, status: 503 });
		await expect(getEntryPointLink(input)).rejects.toThrow(/couldn't read/);
		expect(recordEntryPointObservation).not.toHaveBeenCalled();
	});
	it("does not accept a login page as a profile", async () => {
		vi.mocked(readBuildXml).mockResolvedValue({
			xml: "<html><body>Sign in</body></html>",
		});
		await expect(getEntryPointLink(input)).rejects.toThrow(/install profile/);
	});
	it("refuses a partial publish without asking HQ", async () => {
		vi.mocked(readEntryPointEvidence).mockResolvedValue({
			generation: "new",
			manifest: null,
			observation: null,
		});
		await expect(getEntryPointLink(input)).rejects.toThrow(/complete publish/);
		expect(readAppVersions).not.toHaveBeenCalled();
	});
	it("refuses a release withdrawn during verification", async () => {
		vi.mocked(readAppVersions)
			.mockResolvedValueOnce({
				currentVersion: 4,
				latestBuildVersion: 4,
				latestReleasedVersion: 3,
			})
			.mockResolvedValueOnce({
				currentVersion: 4,
				latestBuildVersion: 4,
				latestReleasedVersion: null,
			});
		await expect(getEntryPointLink(input)).rejects.toThrow(
			/released build changed/,
		);
		expect(recordEntryPointObservation).not.toHaveBeenCalled();
	});
	it("refuses a changed authoring snapshot before using stale selection or bypass metadata", async () => {
		await expect(
			getEntryPointLink({ ...input, sourceSequence: 4 }),
		).rejects.toThrow(/changed since it was published/);
		expect(readAppVersions).not.toHaveBeenCalled();
	});
});
