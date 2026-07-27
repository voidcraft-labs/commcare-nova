import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	resolvePreviewIdentityMock,
	resolveAppScopeMock,
	getLookupManifestMock,
	getLookupFixtureDataMock,
} = vi.hoisted(() => ({
	resolvePreviewIdentityMock: vi.fn(),
	resolveAppScopeMock: vi.fn(),
	getLookupManifestMock: vi.fn(),
	getLookupFixtureDataMock: vi.fn(),
}));

vi.mock("../caseDataBindingHelpers", () => ({
	resolvePreviewIdentity: resolvePreviewIdentityMock,
}));
vi.mock("@/lib/db/appAccess", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/appAccess")>()),
	resolveAppScope: resolveAppScopeMock,
}));
vi.mock("@/lib/lookup/service", () => ({
	getLookupManifest: getLookupManifestMock,
	getLookupFixtureData: getLookupFixtureDataMock,
}));

import { loadLookupFixtureDataAction } from "../lookupDataBinding";

describe("lookup preview authorization identity", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		resolvePreviewIdentityMock.mockResolvedValue({
			actorUserId: "member",
			ownerId: "persona-asha",
			personaUuid: "persona-asha",
			session: { context: {}, user: {} },
			usercase: {},
		});
		resolveAppScopeMock.mockResolvedValue({
			projectId: "project",
			role: "editor",
			actorUserId: "member",
		});
		getLookupManifestMock.mockResolvedValue({
			projectRevision: "1",
			tables: [],
		});
		getLookupFixtureDataMock.mockResolvedValue({
			projectRevision: "1",
			definitions: [],
			rowsByTable: new Map(),
		});
	});

	it("uses the signed-in actor for both membership and lookup scope, never the persona owner", async () => {
		const result = await loadLookupFixtureDataAction("app", []);

		expect(result).toEqual({
			kind: "data",
			data: {
				projectRevision: "1",
				definitions: [],
				rowsByTable: {},
			},
		});
		expect(resolveAppScopeMock).toHaveBeenCalledWith("app", "member", "view");
		expect(getLookupManifestMock).toHaveBeenCalledWith({
			projectId: "project",
			actorId: "member",
			role: "editor",
		});
		expect(getLookupFixtureDataMock).toHaveBeenCalledWith(
			{
				projectId: "project",
				actorId: "member",
				role: "editor",
			},
			[],
		);
	});
});
