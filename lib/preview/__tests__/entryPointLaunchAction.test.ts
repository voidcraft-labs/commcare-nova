import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { assertAdmittedPreviewDoc } from "./fixtures/admittedDoc";

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
	assertAdmittedPreviewDoc(doc);
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
	it("requests viewer authorization and threads the authorized device scope into its data reader", async () => {
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
	it("refuses a post-read authorization snapshot for a different Project", async () => {
		recheck.mockResolvedValue({ baseSeq: 4, projectId: "different" });
		expect(await launchEntryPointAction(request)).toMatchObject({
			kind: "refused",
		});
	});
	it("refuses a post-read snapshot with a newer document sequence", async () => {
		recheck.mockResolvedValue({ baseSeq: 5, projectId: "project" });
		expect(await launchEntryPointAction(request)).toMatchObject({
			kind: "refused",
		});
	});
	it("waits for its device read before requesting fresh authorization", async () => {
		const read = Promise.withResolvers<{ rows: []; indices: [] }>();
		const entered = Promise.withResolvers<void>();
		readDevice.mockImplementation(async () => {
			entered.resolve();
			return read.promise;
		});
		const result = launchEntryPointAction(request);
		try {
			await entered.promise;
			expect(recheck).not.toHaveBeenCalled();
			read.resolve({ rows: [], indices: [] });
			expect(await result).toMatchObject({ kind: "ready" });
			expect(recheck).toHaveBeenCalledTimes(1);
		} finally {
			read.resolve({ rows: [], indices: [] });
			await result;
		}
	});

	it.each([
		{ ...request, expectedSeq: -1 },
		{ ...request, selections: [{ moduleUuid: "invalid", caseIds: ["a"] }] },
		{ ...request, unauthorizedExtra: true },
	])("rejects malformed requests before dependencies run", async (input) => {
		expect(
			await launchEntryPointAction(
				input as unknown as Parameters<typeof launchEntryPointAction>[0],
			),
		).toMatchObject({
			kind: "refused",
		});
		expect(authorize).not.toHaveBeenCalled();
		expect(readDevice).not.toHaveBeenCalled();
	});

	it("contains an unexpected read failure without exposing private details", async () => {
		readDevice.mockRejectedValue(new Error("private database detail"));
		const result = await launchEntryPointAction(request);
		expect(result).toMatchObject({
			kind: "refused",
			message: "We could not open this entry point. Try again.",
		});
		expect(telemetry).toHaveBeenCalledTimes(1);
		expect(recheck).not.toHaveBeenCalled();
	});
});
