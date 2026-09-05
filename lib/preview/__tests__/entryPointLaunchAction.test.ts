import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";

const { authorize, readDevice, recheck, telemetry } = vi.hoisted(() => ({
	authorize: vi.fn(),
	readDevice: vi.fn(),
	recheck: vi.fn(),
	telemetry: vi.fn(),
}));
vi.mock("../engine/caseDataBindingHelpers", () => ({
	resolveAuthorizedPreviewContext: authorize,
	readCaseDatabaseSnapshot: readDevice,
}));
vi.mock("@/lib/db/appAccess", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/appAccess")>()),
	resolveAuthorizedAppSnapshot: recheck,
}));
vi.mock("../engine/caseDataBindingTelemetry", () => ({
	reportUnexpectedActionError: telemetry,
}));
vi.mock("@/lib/lookup/service", () => ({ getLookupFixtureData: vi.fn() }));

import { launchEntryPointAction } from "../entryPointLaunchAction";

const E = testUuid("endpoint"),
	PERSONA = testUuid("persona");
const request = {
	appId: "app",
	entryPointUuid: E,
	personaUuid: PERSONA,
	expectedSeq: 4,
	selections: [],
};
beforeEach(() => {
	vi.resetAllMocks();
	const doc = buildDoc({
		appName: "Survey",
		modules: [
			{
				uuid: "module",
				name: "Survey",
				forms: [
					{
						uuid: "form",
						name: "Survey",
						type: "survey",
						fields: [f({ kind: "text", id: "answer" })],
					},
				],
			},
		],
	});
	doc.forms[testUuid("form")].entryPoint = { uuid: E, id: "survey" };
	authorize.mockResolvedValue({
		kind: "ready",
		identity: {
			actorUserId: "member",
			ownerId: "persona",
			session: {
				context: { userid: "persona" },
				user: {},
				userPropertySlugs: {},
			},
		},
		store: {},
		scope: { projectId: "project", actorId: "member", role: "viewer" },
		blueprint: toPersistableDoc(doc),
		baseSeq: 4,
		restoreScope: { kind: "test-scope" },
	});
	readDevice.mockResolvedValue({ rows: [], indices: [] });
	recheck.mockResolvedValue({ baseSeq: 4, projectId: "project" });
});
describe("entry point launch server boundary", () => {
	it("derives committed topology and mandatory device scope under viewer authorization", async () => {
		expect(await launchEntryPointAction(request)).toMatchObject({
			kind: "ready",
		});
		expect(authorize).toHaveBeenCalledWith({
			appId: "app",
			personaUuid: PERSONA,
			required: "view",
			loadBlueprint: true,
		});
		expect(readDevice).toHaveBeenCalledWith(
			{},
			{ appId: "app", restoreScope: { kind: "test-scope" } },
		);
		expect(recheck).toHaveBeenCalledWith("app", "member", "view");
	});
	it("rejects a stale sequence before reading case data", async () => {
		expect(
			await launchEntryPointAction({ ...request, expectedSeq: 3 }),
		).toMatchObject({ kind: "refused" });
		expect(readDevice).not.toHaveBeenCalled();
	});
	it.each(["unauthenticated", "persona-unavailable"])(
		"refuses %s without falling back to another worker",
		async (kind) => {
			authorize.mockResolvedValue({ kind, message: "Worker unavailable." });
			expect(await launchEntryPointAction(request)).toMatchObject({
				kind: "refused",
			});
			expect(readDevice).not.toHaveBeenCalled();
		},
	);
	it("rejects an app move during device loading", async () => {
		recheck.mockResolvedValue({ baseSeq: 4, projectId: "different" });
		expect(await launchEntryPointAction(request)).toMatchObject({
			kind: "refused",
		});
	});
	it("rejects a concurrent document edit during device loading", async () => {
		recheck.mockResolvedValue({ baseSeq: 5, projectId: "project" });
		expect(await launchEntryPointAction(request)).toMatchObject({
			kind: "refused",
		});
	});
});
