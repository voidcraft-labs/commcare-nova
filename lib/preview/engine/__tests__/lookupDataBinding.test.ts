import { beforeEach, expect, it, vi } from "vitest";
import { lookupAppFixture } from "@/lib/commcare/__tests__/lookupAppFixtures";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LookupError } from "@/lib/lookup/errors";

const { session, snapshot, projection } = vi.hoisted(() => ({
	session: vi.fn(),
	snapshot: vi.fn(),
	projection: vi.fn(),
}));
vi.mock("@/lib/auth-utils", () => ({ getSession: session }));
vi.mock("@/lib/db/appAccess", async (original) => ({
	...(await original<typeof import("@/lib/db/appAccess")>()),
	resolveAuthorizedAppSnapshot: snapshot,
}));
vi.mock("@/lib/deployment/workerLookupProjection", () => ({
	readWorkerLookupProjection: projection,
}));
vi.mock("../caseDataBindingTelemetry", () => ({
	reportUnexpectedActionError: vi.fn(),
}));

import { AppAccessError } from "@/lib/db/appAccess";
import { loadLookupFixtureDataAction } from "../lookupDataBinding";

const { doc, table, rows } = lookupAppFixture(false, true);
beforeEach(() => {
	vi.resetAllMocks();
	session.mockResolvedValue({
		user: { id: "person" },
		session: { id: "browser-session" },
	});
	snapshot.mockResolvedValue({
		projectId: "project",
		app: { blueprint: toPersistableDoc(doc) },
	});
	projection.mockResolvedValue({
		projectRevision: "7",
		definitions: [table],
		rowsByTable: new Map([[table.id, rows]]),
	});
});

it("uses the signed-in actor and exact browser grant for a requested worker, then returns that worker’s data", async () => {
	const personaUuid = "018f0000-0000-7000-8000-000000000007";
	const result = await loadLookupFixtureDataAction(
		"app",
		[table.id],
		personaUuid,
	);
	expect(snapshot).toHaveBeenCalledWith("app", "person", "view");
	expect(projection).toHaveBeenCalledWith(
		{
			scope: { appId: "app", projectId: "project", actorUserId: "person" },
			grant: { kind: "session", sessionId: "browser-session" },
			personaUuid,
		},
		[table.id],
	);
	expect(result).toEqual({
		kind: "data",
		data: {
			projectRevision: "7",
			definitions: [table],
			rowsByTable: { [table.id]: rows },
		},
	});
});
it("rejects a table the app does not read before requesting a worker fixture", async () => {
	expect(
		await loadLookupFixtureDataAction("app", [
			"018f0000-0000-7000-8000-000000000007",
		]),
	).toMatchObject({ kind: "error" });
	expect(projection).not.toHaveBeenCalled();
});
it("stops at authentication, request validation and Project authorization", async () => {
	session.mockResolvedValueOnce(null);
	expect(await loadLookupFixtureDataAction("app", [])).toEqual({
		kind: "unauthenticated",
	});
	expect(await loadLookupFixtureDataAction("app", ["not-an-id"])).toMatchObject(
		{ kind: "error" },
	);
	expect(snapshot).not.toHaveBeenCalled();
	snapshot.mockRejectedValueOnce(new AppAccessError("not_found"));
	expect(await loadLookupFixtureDataAction("app", [table.id])).toEqual({
		kind: "error",
		message: "App not found.",
	});
	expect(projection).not.toHaveBeenCalled();
});
it("reports actual scoped storage or worker refusal and keeps infrastructure details private", async () => {
	projection.mockRejectedValueOnce(
		new LookupError(
			"storage_limit",
			"The complete worker data exceeds device capacity.",
		),
	);
	expect(await loadLookupFixtureDataAction("app", [table.id])).toEqual({
		kind: "error",
		message: "The complete worker data exceeds device capacity.",
	});
	projection.mockRejectedValueOnce(new Error("private connection details"));
	expect(await loadLookupFixtureDataAction("app", [table.id])).toEqual({
		kind: "error",
		message: "We couldn't load the lookup data. Try again.",
	});
});
