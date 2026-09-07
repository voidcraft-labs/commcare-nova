// Action choreography with controlled persistence dependencies; Project tenancy
// and repeatable-read snapshots are proven by lookup Postgres tests.
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

vi.mock("../caseDataBindingTelemetry", () => ({
	reportUnexpectedActionError: vi.fn(),
}));

import { AppAccessError } from "@/lib/db/appAccess";
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
	it("stops before access and data reads when unauthenticated", async () => {
		resolvePreviewIdentityMock.mockResolvedValue(null);
		expect(await loadLookupFixtureDataAction("app", [])).toEqual({
			kind: "unauthenticated",
		});
		expect(resolveAppScopeMock).not.toHaveBeenCalled();
		expect(getLookupManifestMock).not.toHaveBeenCalled();
	});
	it.each([
		["", []],
		["app", ["not-a-table"]],
		["app", Array(501).fill("018f0000-0000-7000-8000-000000000001")],
	])(
		"rejects malformed requests before membership reads",
		async (appId, tableIds) => {
			expect(
				await loadLookupFixtureDataAction(
					appId as string,
					tableIds as string[],
				),
			).toMatchObject({
				kind: "error",
				message: expect.stringContaining("malformed"),
			});
			expect(resolveAppScopeMock).not.toHaveBeenCalled();
			expect(getLookupManifestMock).not.toHaveBeenCalled();
		},
	);
	it("conceals denied app access before materializing fixture rows", async () => {
		resolveAppScopeMock.mockRejectedValue(new AppAccessError("not_found"));
		expect(await loadLookupFixtureDataAction("app", [])).toEqual({
			kind: "error",
			message: "App not found.",
		});
		expect(getLookupManifestMock).not.toHaveBeenCalled();
		expect(getLookupFixtureDataMock).not.toHaveBeenCalled();
	});
	it("allows the exact byte ceiling, ignores unrequested tables and preserves map rows on the wire", async () => {
		const table = "018f0000-0000-7000-8000-000000000001";
		const rows = [{ id: "018f0000-0000-7000-8000-000000000002", values: {} }];
		getLookupManifestMock.mockResolvedValue({
			projectRevision: "1",
			tables: [
				{ id: table, dataBytes: 32 * 1024 * 1024 },
				{ id: "other", dataBytes: 999999999 },
			],
		});
		getLookupFixtureDataMock.mockResolvedValue({
			projectRevision: "2",
			definitions: [],
			rowsByTable: new Map([[table, rows]]),
		});
		expect(await loadLookupFixtureDataAction("app", [table, table])).toEqual({
			kind: "data",
			data: {
				projectRevision: "2",
				definitions: [],
				rowsByTable: { [table]: rows },
			},
		});
		getLookupManifestMock.mockResolvedValue({
			projectRevision: "1",
			tables: [{ id: table, dataBytes: 32 * 1024 * 1024 + 1 }],
		});
		getLookupFixtureDataMock.mockClear();
		expect(await loadLookupFixtureDataAction("app", [table])).toMatchObject({
			kind: "error",
			message: expect.stringContaining("more lookup data"),
		});
		expect(getLookupFixtureDataMock).not.toHaveBeenCalled();
	});
	it("keeps internal lookup errors out of the client result", async () => {
		getLookupManifestMock.mockRejectedValue(
			new Error("private database connection detail"),
		);
		expect(await loadLookupFixtureDataAction("app", [])).toEqual({
			kind: "error",
			message: "We couldn't load the lookup data. Try again.",
		});
	});
});
