import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as actions from "../actions";
import { LookupError } from "../errors";

const mocks = vi.hoisted(() => {
	class MockAppAccessError extends Error {
		readonly name = "AppAccessError";
	}
	return {
		AppAccessError: MockAppAccessError,
		getSession: vi.fn(),
		resolveProjectAccess: vi.fn(),
		logError: vi.fn(),
		getLookupManifest: vi.fn(),
		getLookupTable: vi.fn(),
		createLookupTable: vi.fn(),
		updateLookupTableName: vi.fn(),
		updateLookupTableTag: vi.fn(),
		addLookupColumn: vi.fn(),
		updateLookupColumnLabel: vi.fn(),
		updateLookupColumnWireName: vi.fn(),
		moveLookupColumn: vi.fn(),
		createLookupRow: vi.fn(),
		updateLookupRow: vi.fn(),
		deleteLookupRow: vi.fn(),
		moveLookupRow: vi.fn(),
	};
});

vi.mock("@/lib/auth-utils", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db/appAccess", () => ({
	AppAccessError: mocks.AppAccessError,
	resolveProjectAccess: mocks.resolveProjectAccess,
}));
vi.mock("@/lib/logger", () => ({ log: { error: mocks.logError } }));
vi.mock("../service", () => ({
	getLookupManifest: mocks.getLookupManifest,
	getLookupTable: mocks.getLookupTable,
	createLookupTable: mocks.createLookupTable,
	updateLookupTableName: mocks.updateLookupTableName,
	updateLookupTableTag: mocks.updateLookupTableTag,
	addLookupColumn: mocks.addLookupColumn,
	updateLookupColumnLabel: mocks.updateLookupColumnLabel,
	updateLookupColumnWireName: mocks.updateLookupColumnWireName,
	moveLookupColumn: mocks.moveLookupColumn,
	createLookupRow: mocks.createLookupRow,
	updateLookupRow: mocks.updateLookupRow,
	deleteLookupRow: mocks.deleteLookupRow,
	moveLookupRow: mocks.moveLookupRow,
}));

const TABLE_ID = "019b0000-0000-7000-8000-000000000001";
const COLUMN_ID = "019b0000-0000-7000-8000-000000000002";
const ROW_ID = "019b0000-0000-7000-8000-000000000003";
const RECEIPT = {
	projectRevision: "2",
	definitionRevision: "1",
	rowsRevision: "2",
	tableRevision: "2",
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
	mocks.resolveProjectAccess.mockResolvedValue({
		projectId: "project-1",
		role: "editor",
		actorUserId: "user-1",
	});
	for (const mock of [
		mocks.updateLookupTableName,
		mocks.updateLookupTableTag,
		mocks.updateLookupColumnLabel,
		mocks.updateLookupColumnWireName,
		mocks.moveLookupColumn,
		mocks.updateLookupRow,
		mocks.deleteLookupRow,
		mocks.moveLookupRow,
	]) {
		mock.mockResolvedValue(RECEIPT);
	}
	mocks.addLookupColumn.mockResolvedValue({
		...RECEIPT,
		columnId: COLUMN_ID,
	});
	mocks.createLookupRow.mockResolvedValue({ ...RECEIPT, rowId: ROW_ID });
});

describe("lookup Server Actions", () => {
	it("authenticates before parsing or authorizing untrusted input", async () => {
		mocks.getSession.mockResolvedValue(null);

		const result = await actions.createLookupTableAction(null, null);

		expect(result).toMatchObject({
			success: false,
			code: "unauthenticated",
		});
		expect(mocks.resolveProjectAccess).not.toHaveBeenCalled();
		expect(mocks.createLookupTable).not.toHaveBeenCalled();
	});

	it("rejects a malformed explicit Project id before authorization", async () => {
		const result = await actions.getLookupManifestAction("   ");

		expect(result).toMatchObject({ success: false, code: "invalid_input" });
		expect(mocks.resolveProjectAccess).not.toHaveBeenCalled();
	});

	it("authorizes reads with view and passes a freshly constructed scope", async () => {
		const manifest = {
			projectId: "project-1",
			projectRevision: "0",
			tables: [],
		};
		mocks.getLookupManifest.mockResolvedValue(manifest);

		const result = await actions.getLookupManifestAction(" project-1 ");

		expect(mocks.resolveProjectAccess).toHaveBeenCalledWith(
			"user-1",
			"project-1",
			"view",
		);
		expect(mocks.getLookupManifest).toHaveBeenCalledWith({
			projectId: "project-1",
			actorId: "user-1",
			role: "editor",
		});
		expect(result).toEqual({ success: true, value: manifest });
	});

	it("requires edit for additive schema and row creation, returning minted ids", async () => {
		const column = await actions.addLookupColumnAction("project-1", {
			tableId: TABLE_ID,
			expectedTableRevision: "1",
			column: { wireName: "code", label: "Code", dataType: "text" },
		});
		const row = await actions.createLookupRowAction("project-1", {
			tableId: TABLE_ID,
			expectedTableRevision: "2",
			toIndex: 0,
			values: { [COLUMN_ID]: "A" },
		});

		expect(mocks.resolveProjectAccess).toHaveBeenNthCalledWith(
			1,
			"user-1",
			"project-1",
			"edit",
		);
		expect(mocks.resolveProjectAccess).toHaveBeenNthCalledWith(
			2,
			"user-1",
			"project-1",
			"edit",
		);
		expect(column).toMatchObject({
			success: true,
			value: { columnId: COLUMN_ID },
		});
		expect(row).toMatchObject({
			success: true,
			value: { rowId: ROW_ID },
		});
	});

	it("requires delete capability only for established wire-identity changes", async () => {
		await actions.updateLookupTableTagAction("project-1", {
			tableId: TABLE_ID,
			expectedTableRevision: "1",
			tag: "facilities_v2",
		});
		await actions.updateLookupColumnWireNameAction("project-1", {
			tableId: TABLE_ID,
			columnId: COLUMN_ID,
			expectedTableRevision: "1",
			wireName: "facility_code",
		});
		await actions.updateLookupColumnLabelAction("project-1", {
			tableId: TABLE_ID,
			columnId: COLUMN_ID,
			expectedTableRevision: "1",
			label: "Facility code",
		});

		expect(
			mocks.resolveProjectAccess.mock.calls.map((call) => call[2]),
		).toEqual(["delete", "delete", "edit"]);
	});

	it("runtime-parses revisions and UUIDs instead of trusting TypeScript", async () => {
		const malformed = await actions.updateLookupRowAction("project-1", {
			tableId: "not-a-uuid",
			rowId: ROW_ID,
			expectedTableRevision: "01",
			values: {},
		});

		expect(malformed).toMatchObject({
			success: false,
			code: "invalid_input",
		});
		expect(mocks.resolveProjectAccess).not.toHaveBeenCalled();
		expect(mocks.updateLookupRow).not.toHaveBeenCalled();
	});

	it("treats a downstream Zod failure as an internal fault", async () => {
		const downstream = z.string().safeParse(42);
		if (downstream.success) throw new Error("expected a synthetic Zod failure");
		mocks.getLookupManifest.mockRejectedValue(downstream.error);

		const result = await actions.getLookupManifestAction("project-1");

		expect(result).toMatchObject({
			success: false,
			code: "internal_error",
		});
		expect(mocks.logError).toHaveBeenCalledWith(
			"[lookup/action] unhandled",
			downstream.error,
		);
	});

	it("collapses membership and role denials to opaque not-found", async () => {
		mocks.resolveProjectAccess.mockRejectedValue(
			new mocks.AppAccessError("insufficient_role"),
		);

		const result = await actions.getLookupTableAction("project-1", TABLE_ID);

		expect(result).toEqual({
			success: false,
			code: "not_found",
			message: "Lookup table not found.",
		});
		expect(mocks.getLookupTable).not.toHaveBeenCalled();
	});

	it("preserves typed conflict revisions without writing a different shape", async () => {
		mocks.updateLookupTableName.mockRejectedValue(
			new LookupError("conflict", "The table changed.", {
				currentRevisions: {
					definitionRevision: "4" as never,
					rowsRevision: "5" as never,
					tableRevision: "5" as never,
				},
			}),
		);

		const result = await actions.updateLookupTableNameAction("project-1", {
			tableId: TABLE_ID,
			expectedTableRevision: "3",
			name: "Facilities",
		});

		expect(result).toMatchObject({
			success: false,
			code: "conflict",
			currentRevisions: { tableRevision: "5" },
		});
	});

	it("contains and logs unexpected faults", async () => {
		const fault = new Error("db offline");
		mocks.getLookupManifest.mockRejectedValue(fault);

		const result = await actions.getLookupManifestAction("project-1");

		expect(result).toMatchObject({
			success: false,
			code: "internal_error",
		});
		expect(mocks.logError).toHaveBeenCalledWith(
			"[lookup/action] unhandled",
			fault,
		);
	});

	it("does not expose raw row replacement as a Server Action", () => {
		expect(actions).not.toHaveProperty("replaceLookupRowsAction");
	});
});
