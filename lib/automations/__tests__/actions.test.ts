import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { automationSchema, type BlueprintDoc } from "@/lib/domain";
import { OrganizationError } from "@/lib/organization/errors";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	resolveAppScope: vi.fn(),
	readSnapshot: vi.fn(),
	withProjectContext: vi.fn(),
	count: vi.fn(),
	logError: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db/appAccess", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/appAccess")>()),
	resolveAppScope: mocks.resolveAppScope,
}));
vi.mock("@/lib/organization/service", () => ({
	readOrganizationAuthoringSnapshot: mocks.readSnapshot,
}));
vi.mock("@/lib/case-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/case-store")>()),
	withProjectContext: mocks.withProjectContext,
}));
vi.mock("@/lib/logger", () => ({ log: { error: mocks.logError } }));

import { previewAutomationAction } from "../actions";

const AUTOMATION_UUID = testUuid("preview-automation");

function fixture() {
	const doc = buildDoc({
		appId: "app-automation",
		appName: "Automation preview",
		caseTypes: [
			{
				name: "claim",
				properties: [
					{
						name: "state",
						label: "State",
						data_type: "text",
					},
				],
			},
		],
	}) as BlueprintDoc;
	const automation = automationSchema.parse({
		uuid: AUTOMATION_UUID,
		kind: "case-update",
		name: "Close abandoned claims",
		caseType: "claim",
		criteriaOperator: "all",
		criteria: [
			{
				uuid: testUuid("preview-criterion"),
				kind: "match-property",
				scope: "case",
				property: "state",
				matchType: "equal",
				value: "abandoned",
			},
		],
		setupOnlyCriteria: [
			{
				uuid: testUuid("preview-setup-only"),
				kind: "ucr-filter",
				text: "unclaimed cases",
			},
		],
		serverModifiedBoundaryDays: 30,
		updates: [],
		closeCase: true,
	});
	doc.automations = { [AUTOMATION_UUID]: automation };
	doc.automationOrder = [AUTOMATION_UUID];
	return { doc, automation };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSession.mockResolvedValue({ user: { id: "member" } });
	mocks.resolveAppScope.mockResolvedValue({
		projectId: "project",
		role: "editor",
	});
	mocks.withProjectContext.mockResolvedValue({ count: mocks.count });
	mocks.count.mockResolvedValue(7);
});

describe("previewAutomationAction", () => {
	it("counts through the tenant-bound store and returns explicit non-execution and omissions", async () => {
		const { doc, automation } = fixture();
		mocks.readSnapshot.mockResolvedValue({
			blueprint: doc,
			blueprintSeq: 42,
			organization: { revision: "9", locations: [] },
		});

		const result = await previewAutomationAction({
			appId: doc.appId,
			automationUuid: automation.uuid,
			expectedAutomation: automation,
		});

		expect(result).toMatchObject({
			success: true,
			data: {
				blueprintSeq: 42,
				organizationRevision: "9",
				matching: { status: "counted", currentMatchCount: 7 },
				executesLocally: false,
				omittedCriteria: [
					"UCR filter: unclaimed cases",
					"HQ server-modified age of at least 30 days",
				],
			},
		});
		expect(mocks.withProjectContext).toHaveBeenCalledWith(
			"project",
			"member",
			"member",
		);
		expect(mocks.count).toHaveBeenCalledWith(
			expect.objectContaining({
				appId: doc.appId,
				caseType: "claim",
				predicate: expect.any(Object),
				automationCriteria: expect.objectContaining({ operator: "all" }),
			}),
		);
	});

	it("keeps the current setup guide available when optional counting fails", async () => {
		const { doc, automation } = fixture();
		mocks.readSnapshot.mockResolvedValue({
			blueprint: doc,
			blueprintSeq: 42,
			organization: { revision: "9", locations: [] },
		});
		mocks.count.mockRejectedValue(new Error("case store unavailable"));

		const result = await previewAutomationAction({
			appId: doc.appId,
			automationUuid: automation.uuid,
			expectedAutomation: automation,
		});

		expect(result).toMatchObject({
			success: true,
			data: {
				blueprintSeq: 42,
				organizationRevision: "9",
				matching: {
					status: "unavailable",
					message: expect.stringContaining(
						"setup guide below is still current",
					),
				},
				setupGuide: {
					title: "Close abandoned claims: Automatic Case Update Rule",
					steps: expect.any(Array),
				},
			},
		});
		expect(mocks.logError).toHaveBeenCalledWith(
			"[automations] preview count failed",
			expect.any(Error),
			expect.objectContaining({ appId: doc.appId }),
		);
	});

	it("refuses a stale expected automation before opening the case store", async () => {
		const { doc, automation } = fixture();
		mocks.readSnapshot.mockResolvedValue({
			blueprint: doc,
			blueprintSeq: 43,
			organization: { revision: "10", locations: [] },
		});

		await expect(
			previewAutomationAction({
				appId: doc.appId,
				automationUuid: automation.uuid,
				expectedAutomation: { ...automation, name: "Stale name" },
			}),
		).resolves.toMatchObject({ success: false, code: "conflict" });
		expect(mocks.withProjectContext).not.toHaveBeenCalled();
		expect(mocks.count).not.toHaveBeenCalled();
	});

	it("collapses access loss between authorization and the organization snapshot to not found", async () => {
		const { doc, automation } = fixture();
		mocks.readSnapshot.mockRejectedValue(
			new OrganizationError(
				"not_found",
				"The app moved Projects after the first access check.",
			),
		);

		await expect(
			previewAutomationAction({
				appId: doc.appId,
				automationUuid: automation.uuid,
				expectedAutomation: automation,
			}),
		).resolves.toEqual({
			success: false,
			code: "not_found",
			message: "That app isn't available, or you no longer have access.",
		});
		expect(mocks.withProjectContext).not.toHaveBeenCalled();
		expect(mocks.count).not.toHaveBeenCalled();
		expect(mocks.logError).not.toHaveBeenCalled();
	});

	it("fails closed before app access when there is no session", async () => {
		const { doc, automation } = fixture();
		mocks.getSession.mockResolvedValue(null);

		await expect(
			previewAutomationAction({
				appId: doc.appId,
				automationUuid: automation.uuid,
				expectedAutomation: automation,
			}),
		).resolves.toMatchObject({ success: false, code: "unauthenticated" });
		expect(mocks.resolveAppScope).not.toHaveBeenCalled();
	});
});
