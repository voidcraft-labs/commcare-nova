// Action choreography with controlled persistence dependencies; Project tenancy
// and repeatable-read snapshots are proven by lookup Postgres tests.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	resolvePreviewIdentityMock,
	resolveAppScopeMock,
	getLookupFixtureDataMock,
} = vi.hoisted(() => ({
	resolvePreviewIdentityMock: vi.fn(),
	resolveAppScopeMock: vi.fn(),
	getLookupFixtureDataMock: vi.fn(),
}));

vi.mock("../previewAuthorization", () => ({
	resolvePreviewIdentity: resolvePreviewIdentityMock,
}));
vi.mock("@/lib/db/appAccess", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/appAccess")>()),
	resolveAppScope: resolveAppScopeMock,
}));
vi.mock("@/lib/lookup/service", () => ({
	getLookupFixtureData: getLookupFixtureDataMock,
}));

vi.mock("../caseDataBindingTelemetry", () => ({
	reportUnexpectedActionError: vi.fn(),
}));

import { AppAccessError } from "@/lib/db/appAccess";
import { LookupError } from "@/lib/lookup/errors";
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
		expect(getLookupFixtureDataMock).toHaveBeenCalledWith(
			{
				projectId: "project",
				actorId: "member",
				role: "editor",
			},
			[],
			"device",
		);
	});
	it("stops before access and data reads when unauthenticated", async () => {
		resolvePreviewIdentityMock.mockResolvedValue(null);
		expect(await loadLookupFixtureDataAction("app", [])).toEqual({
			kind: "unauthenticated",
		});
		expect(resolveAppScopeMock).not.toHaveBeenCalled();
		expect(getLookupFixtureDataMock).not.toHaveBeenCalled();
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
			expect(getLookupFixtureDataMock).not.toHaveBeenCalled();
		},
	);
	it("conceals denied app access before materializing fixture rows", async () => {
		resolveAppScopeMock.mockRejectedValue(new AppAccessError("not_found"));
		expect(await loadLookupFixtureDataAction("app", [])).toEqual({
			kind: "error",
			message: "App not found.",
		});
		expect(getLookupFixtureDataMock).not.toHaveBeenCalled();
	});
	it("preserves map rows and reports an admitted fixture limit on the wire", async () => {
		const table = "018f0000-0000-7000-8000-000000000001";
		const rows = [{ id: "018f0000-0000-7000-8000-000000000002", values: {} }];
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
		getLookupFixtureDataMock.mockRejectedValueOnce(
			new LookupError(
				"storage_limit",
				"This app references more lookup data than Preview can load at once.",
			),
		);
		expect(await loadLookupFixtureDataAction("app", [table])).toMatchObject({
			kind: "error",
			message: expect.stringContaining("more lookup data"),
		});
	});
	it("keeps internal lookup errors out of the client result", async () => {
		getLookupFixtureDataMock.mockRejectedValue(
			new Error("private database connection detail"),
		);
		expect(await loadLookupFixtureDataAction("app", [])).toEqual({
			kind: "error",
			message: "We couldn't load the lookup data. Try again.",
		});
	});
});
