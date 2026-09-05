import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEntryPointLink } from "@/lib/deployment/entryPointLinks";
import { DeploymentError } from "@/lib/deployment/errors";
import { loadAppBlueprint } from "../loadApp";
import { SCOPES } from "../scopes";
import { registerGetEntryPointLink } from "../tools/getEntryPointLink";
import { makeFakeServer } from "./fakeServer";

vi.mock("@/lib/deployment/entryPointLinks", () => ({
	getEntryPointLink: vi.fn(),
}));
vi.mock("../loadApp", () => ({ loadAppBlueprint: vi.fn() }));
const input = {
	app_id: "a1",
	server: "india",
	domain: "clinic",
	entry_point_uuid: "ep1",
	selections: [{ module_uuid: "m1", case_ids: ["hq-case-1", "hq-case-2"] }],
};
function harness(scopes: string[]) {
	const fake = makeFakeServer();
	registerGetEntryPointLink(fake.server, {
		userId: "u1",
		scopes,
		authKind: "oauth",
	});
	return fake;
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(loadAppBlueprint).mockResolvedValue({
		doc: {},
		app: { mutation_seq: 7 },
		access: { projectId: "p1", role: "owner" },
	} as never);
});
describe("get_entry_point_link", () => {
	it("requires HQ write scope before reading the app or observing HQ", async () => {
		const result = await harness([SCOPES.hqRead]).capture()(input);
		expect(result).toMatchObject({ isError: true });
		expect(loadAppBlueprint).not.toHaveBeenCalled();
		expect(getEntryPointLink).not.toHaveBeenCalled();
	});
	it("requires edit access and forwards the exact destination and external case IDs", async () => {
		vi.mocked(getEntryPointLink).mockResolvedValue({
			url: "https://india.commcarehq.org/a/clinic/app/v1/app1/visit/",
			checkedAt: "2026-09-04T00:00:00Z",
			releasedBuildId: "build1",
			releasedVersion: 4,
		});
		const result = await harness([SCOPES.hqWrite]).capture()(input);
		expect(loadAppBlueprint).toHaveBeenCalledWith("a1", "u1", "edit");
		expect(getEntryPointLink).toHaveBeenCalledWith({
			scope: { appId: "a1", projectId: "p1", role: "owner", actorUserId: "u1" },
			target: { server: "india", domain: "clinic" },
			doc: {},
			sourceSequence: 7,
			entryPointUuid: "ep1",
			selections: [{ moduleUuid: "m1", caseIds: ["hq-case-1", "hq-case-2"] }],
		});
		expect(
			JSON.parse(
				(result as { content: { text: string }[] }).content[0]?.text ?? "{}",
			),
		).toMatchObject({
			released_build_id: "build1",
			released_version: 4,
			checked_at: "2026-09-04T00:00:00Z",
		});
	});
	it("returns the verifier refusal without inventing a link", async () => {
		vi.mocked(getEntryPointLink).mockRejectedValue(
			new DeploymentError(
				"invalid",
				"Publish this app again before creating a link.",
			),
		);
		const result = await harness([SCOPES.hqWrite]).capture()(input);
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).toContain("Publish this app again");
		expect(JSON.stringify(result)).not.toContain('"url"');
	});
});
