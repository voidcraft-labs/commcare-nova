import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { proseText } from "@/lib/domain/prose";

const mocks = vi.hoisted(() => {
	class MockAppAccessError extends Error {
		readonly name = "AppAccessError";
		constructor(
			readonly reason: "not_found" | "not_member" | "insufficient_role",
		) {
			super(reason);
		}
	}
	return {
		AppAccessError: MockAppAccessError,
		getSession: vi.fn(),
		withAppTx: vi.fn(),
		resolveAppScopeInTransaction: vi.fn(),
		loadAppInTransaction: vi.fn(),
		prepareMutationCandidate: vi.fn(),
		evaluatePreparedMutationCandidate: vi.fn(),
		readLookupDefinitionsInTransaction: vi.fn(),
		readStorage: vi.fn(),
		logError: vi.fn(),
	};
});

vi.mock("@/lib/auth-utils", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db/appAccess", () => ({
	AppAccessError: mocks.AppAccessError,
	resolveAppScopeInTransaction: mocks.resolveAppScopeInTransaction,
}));
vi.mock("@/lib/db/apps", () => ({
	loadAppInTransaction: mocks.loadAppInTransaction,
}));
vi.mock("@/lib/db/pg", () => ({ withAppTx: mocks.withAppTx }));
vi.mock("@/lib/case-store/casePropertyRenamePreflight", () => ({
	readCasePropertyRenameStoragePreflightInTransaction: mocks.readStorage,
}));
vi.mock("@/lib/doc/commitVerdicts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/doc/commitVerdicts")>();
	return {
		...actual,
		prepareMutationCandidate: mocks.prepareMutationCandidate,
		evaluatePreparedMutationCandidate: mocks.evaluatePreparedMutationCandidate,
	};
});
vi.mock("@/lib/lookup/definitionSnapshot", () => ({
	readLookupDefinitionsInTransaction: mocks.readLookupDefinitionsInTransaction,
}));
vi.mock("@/lib/logger", () => ({ log: { error: mocks.logError } }));

import { preflightCasePropertyRenamesAction } from "../casePropertyRenamePreflight";

const APP_ID = "app-preflight";
const PROJECT_ID = "project-preflight";
const MUTATION_SEQ = 17;
const DOC: PersistableDoc = {
	appId: APP_ID,
	appName: "Preflight",
	connectType: null,
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "old_name", label: proseText("Old"), data_type: "text" },
			],
		},
	],
	modules: {},
	forms: {},
	fields: {},
	moduleOrder: [],
	formOrder: {},
	fieldOrder: {},
};
const RENAMES = [
	{ caseType: "patient", from: "old_name", to: "new_name" },
] as const;

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
	mocks.withAppTx.mockImplementation(
		async (body: (tx: object) => Promise<unknown>) => body({}),
	);
	mocks.resolveAppScopeInTransaction.mockResolvedValue({
		projectId: PROJECT_ID,
		role: "viewer",
		canEdit: false,
		baseSeq: MUTATION_SEQ,
		actorUserId: "user-1",
	});
	mocks.loadAppInTransaction.mockResolvedValue({
		project_id: PROJECT_ID,
		mutation_seq: MUTATION_SEQ,
		blueprint: DOC,
	});
	mocks.prepareMutationCandidate.mockImplementation(
		(nextDoc: unknown, mutations: readonly unknown[]) => ({
			mutations,
			nextDoc,
			results: [],
			casePropertyRenamePlan: {
				entries: (
					mutations[0] as {
						renames: readonly {
							caseType: string;
							from: string;
							to: string;
						}[];
					}
				).renames,
			},
		}),
	);
	mocks.evaluatePreparedMutationCandidate.mockImplementation(
		(prepared: object) => ({
			ok: true,
			nextDoc: DOC,
			results: [],
			mutations: [],
			prepared,
		}),
	);
	mocks.readLookupDefinitionsInTransaction.mockResolvedValue({
		projectId: PROJECT_ID,
		projectRevision: "0",
		definitions: [],
	});
	mocks.readStorage.mockResolvedValue({
		renamedRows: 3,
		renamedParkedValues: 2,
		byRename: [
			{
				...RENAMES[0],
				rowsWithSource: 3,
				parkedValuesWithSource: 2,
			},
		],
		conflicts: [],
	});
});

describe("case-property rename preflight Server Action", () => {
	it("authenticates before reading untrusted app or rename input", async () => {
		mocks.getSession.mockResolvedValue(null);

		const result = await preflightCasePropertyRenamesAction(null as never);

		expect(result).toEqual({ kind: "unauthenticated" });
		expect(mocks.withAppTx).not.toHaveBeenCalled();
	});

	it.each([
		["not_found", "not-found"],
		["not_member", "forbidden"],
		["insufficient_role", "forbidden"],
	] as const)("maps %s access denial to %s", async (reason, kind) => {
		mocks.resolveAppScopeInTransaction.mockRejectedValue(
			new mocks.AppAccessError(reason),
		);

		const result = await preflightCasePropertyRenamesAction({
			appId: APP_ID,
			renames: RENAMES,
		});

		expect(result).toEqual({ kind });
		expect(mocks.readStorage).not.toHaveBeenCalled();
	});

	it("requires current Project view access and returns the authoritative sequence", async () => {
		const result = await preflightCasePropertyRenamesAction({
			appId: APP_ID,
			renames: RENAMES,
		});

		expect(mocks.resolveAppScopeInTransaction).toHaveBeenCalledWith(
			expect.anything(),
			APP_ID,
			"user-1",
			"view",
		);
		const transaction = mocks.resolveAppScopeInTransaction.mock.calls[0]?.[0];
		expect(mocks.loadAppInTransaction.mock.calls[0]?.[0]).toBe(transaction);
		expect(mocks.readLookupDefinitionsInTransaction.mock.calls[0]?.[0]).toBe(
			transaction,
		);
		expect(mocks.readStorage.mock.calls[0]?.[0]).toBe(transaction);
		expect(result).toEqual({
			kind: "ok",
			mutationSeq: MUTATION_SEQ,
			report: {
				renamedRows: 3,
				renamedParkedValues: 2,
				byRename: [
					{
						...RENAMES[0],
						rowsWithSource: 3,
						parkedValuesWithSource: 2,
					},
				],
			},
		});
	});

	it("rejects an empty relation before planning or storage reads", async () => {
		const result = await preflightCasePropertyRenamesAction({
			appId: APP_ID,
			renames: [],
		});

		expect(result).toEqual({
			kind: "invalid",
			mutationSeq: MUTATION_SEQ,
			messages: [
				"This edit could not be saved because its mutation data was not canonical.",
			],
		});
		expect(mocks.prepareMutationCandidate).not.toHaveBeenCalled();
		expect(mocks.readStorage).not.toHaveBeenCalled();
	});

	it("returns the same full commit-verdict messages before reading storage", async () => {
		mocks.evaluatePreparedMutationCandidate.mockReturnValue({
			ok: false,
			nextDoc: DOC,
			findings: [
				{ message: "The destination is not valid for this case type." },
				{ message: "A dependent expression could not be rewritten." },
			],
		});

		const result = await preflightCasePropertyRenamesAction({
			appId: APP_ID,
			renames: RENAMES,
		});

		expect(result).toEqual({
			kind: "invalid",
			mutationSeq: MUTATION_SEQ,
			messages: [
				"The destination is not valid for this case type.",
				"A dependent expression could not be rewritten.",
			],
		});
		expect(mocks.evaluatePreparedMutationCandidate).toHaveBeenCalledWith(
			expect.anything(),
			{
				kind: "available",
				projectId: PROJECT_ID,
				projectRevision: "0",
				definitions: [],
			},
		);
		expect(mocks.readStorage).not.toHaveBeenCalled();
	});

	it("returns grouped storage conflicts without a report or write token", async () => {
		mocks.readStorage.mockResolvedValue({
			renamedRows: 1,
			renamedParkedValues: 0,
			byRename: [],
			conflicts: [
				{
					caseType: "patient",
					property: "new_name",
					carrier: "case-row",
					count: 4,
				},
				{
					caseType: "patient",
					property: "new_name",
					carrier: "parked-value",
					count: 1,
				},
			],
		});

		const result = await preflightCasePropertyRenamesAction({
			appId: APP_ID,
			renames: RENAMES,
		});

		expect(result).toEqual({
			kind: "conflict",
			mutationSeq: MUTATION_SEQ,
			conflicts: [
				{
					caseType: "patient",
					property: "new_name",
					carrier: "case-row",
					count: 4,
				},
				{
					caseType: "patient",
					property: "new_name",
					carrier: "parked-value",
					count: 1,
				},
			],
		});
		expect(result).not.toHaveProperty("token");
		expect(result).not.toHaveProperty("report");
	});
});
