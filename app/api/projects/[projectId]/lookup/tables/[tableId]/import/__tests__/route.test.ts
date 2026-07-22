import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LOOKUP_MAX_CSV_BYTES } from "@/lib/lookup/constants";
import { LookupError } from "@/lib/lookup/errors";
import { POST } from "../route";

const mocks = vi.hoisted(() => {
	class MockAppAccessError extends Error {
		readonly name = "AppAccessError";
	}
	return {
		AppAccessError: MockAppAccessError,
		requireSession: vi.fn(),
		resolveProjectAccess: vi.fn(),
		getLookupTable: vi.fn(),
		replaceLookupRows: vi.fn(),
		logError: vi.fn(),
		logWarn: vi.fn(),
	};
});

vi.mock("@/lib/auth-utils", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db/appAccess", () => ({
	AppAccessError: mocks.AppAccessError,
	resolveProjectAccess: mocks.resolveProjectAccess,
}));
vi.mock("@/lib/lookup/service", () => ({
	getLookupTable: mocks.getLookupTable,
	replaceLookupRows: mocks.replaceLookupRows,
}));
vi.mock("@/lib/logger", () => ({
	log: { error: mocks.logError, warn: mocks.logWarn },
}));

const TABLE_ID = "019b0000-0000-7000-8000-000000000001";
const NAME_COLUMN_ID = "019b0000-0000-7000-8000-000000000002";
const COUNT_COLUMN_ID = "019b0000-0000-7000-8000-000000000003";
const TABLE = {
	projectId: "project-1",
	projectRevision: "7",
	id: TABLE_ID,
	name: "Facilities",
	tag: "facilities",
	columns: [
		{
			id: NAME_COLUMN_ID,
			wireName: "name",
			label: "Name",
			dataType: "text",
		},
		{
			id: COUNT_COLUMN_ID,
			wireName: "count",
			label: "Count",
			dataType: "int",
		},
	],
	columnCount: 2,
	rows: [],
	rowCount: 0,
	dataBytes: 0,
	definitionRevision: "7",
	rowsRevision: "7",
	tableRevision: "7",
	createdBy: "user-1",
	updatedBy: "user-1",
	createdAt: "2026-07-21T00:00:00.000Z",
	updatedAt: "2026-07-21T00:00:00.000Z",
};

function request(options: {
	body?: Uint8Array;
	contentType?: string;
	contentLength?: string;
	revision?: string;
}) {
	const body =
		options.body ?? new TextEncoder().encode("name,count\nClinic,2\n");
	const headers = new Headers();
	if (options.contentType !== undefined) {
		headers.set("content-type", options.contentType);
	}
	if (options.contentLength !== undefined) {
		headers.set("content-length", options.contentLength);
	}
	const arrayBuffer = vi.fn(async () =>
		body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
	);
	const revision = options.revision ?? "7";
	return {
		req: {
			headers,
			nextUrl: new URL(
				`http://localhost/api/projects/project-1/lookup/tables/${TABLE_ID}/import?expectedTableRevision=${revision}`,
			),
			arrayBuffer,
		},
		arrayBuffer,
	};
}

function context(
	projectId = "project-1",
	tableId = TABLE_ID,
): Parameters<typeof POST>[1] {
	return { params: Promise.resolve({ projectId, tableId }) };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.requireSession.mockResolvedValue({ user: { id: "user-1" } });
	mocks.resolveProjectAccess.mockResolvedValue({
		projectId: "project-1",
		role: "editor",
		actorUserId: "user-1",
	});
	mocks.getLookupTable.mockResolvedValue(TABLE);
	mocks.replaceLookupRows.mockResolvedValue({
		projectRevision: "8",
		definitionRevision: "7",
		rowsRevision: "8",
		tableRevision: "8",
	});
});

describe("POST lookup CSV import", () => {
	it("rejects a declared oversize before auth or buffering", async () => {
		const { req, arrayBuffer } = request({
			contentType: "text/csv; charset=utf-8",
			contentLength: String(LOOKUP_MAX_CSV_BYTES + 1),
		});

		const response = await POST(req as never, context());

		expect(response.status).toBe(413);
		expect((await response.json()).code).toBe("invalid_csv");
		expect(mocks.requireSession).not.toHaveBeenCalled();
		expect(arrayBuffer).not.toHaveBeenCalled();
	});

	it("authorizes the exact Project before reading the body", async () => {
		mocks.resolveProjectAccess.mockRejectedValue(
			new mocks.AppAccessError("not_member"),
		);
		const { req, arrayBuffer } = request({ contentType: "text/csv" });

		const response = await POST(req as never, context("project-foreign"));

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ success: false });
		expect(mocks.resolveProjectAccess).toHaveBeenCalledWith(
			"user-1",
			"project-foreign",
			"edit",
		);
		expect(mocks.getLookupTable).not.toHaveBeenCalled();
		expect(arrayBuffer).not.toHaveBeenCalled();
	});

	it("returns the stable unauthenticated shape without parsing", async () => {
		const authError = new Error("Authentication required") as Error & {
			status: number;
		};
		authError.name = "ApiError";
		authError.status = 401;
		mocks.requireSession.mockRejectedValue(authError);
		const { req, arrayBuffer } = request({ contentType: "text/csv" });

		const response = await POST(req as never, context());

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			success: false,
			code: "unauthenticated",
		});
		expect(mocks.resolveProjectAccess).not.toHaveBeenCalled();
		expect(arrayBuffer).not.toHaveBeenCalled();
	});

	it("rejects malformed path and revision input before authorization or buffering", async () => {
		const { req, arrayBuffer } = request({
			contentType: "text/csv",
			revision: "01",
		});

		const response = await POST(
			req as never,
			context("project-1", "not-a-uuid"),
		);

		expect(response.status).toBe(400);
		const payload = await response.json();
		expect(payload).toMatchObject({
			success: false,
			code: "invalid_input",
		});
		expect(payload.totalDetailCount).toBeGreaterThanOrEqual(2);
		expect(mocks.requireSession).toHaveBeenCalled();
		expect(mocks.resolveProjectAccess).not.toHaveBeenCalled();
		expect(mocks.getLookupTable).not.toHaveBeenCalled();
		expect(arrayBuffer).not.toHaveBeenCalled();
	});

	it("requires raw UTF-8 text/csv and does not buffer a wrong media type", async () => {
		const { req, arrayBuffer } = request({ contentType: "application/json" });

		const response = await POST(req as never, context());

		expect(response.status).toBe(400);
		expect((await response.json()).code).toBe("invalid_input");
		expect(arrayBuffer).not.toHaveBeenCalled();
	});

	it("rejects a stale table revision before buffering", async () => {
		const { req, arrayBuffer } = request({
			contentType: "text/csv; charset=UTF-8",
			revision: "6",
		});

		const response = await POST(req as never, context());

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: "conflict",
			currentRevisions: { tableRevision: "7" },
		});
		expect(arrayBuffer).not.toHaveBeenCalled();
	});

	it("checks the actual byte count after buffering", async () => {
		const { req } = request({
			contentType: "text/csv",
			body: new Uint8Array(LOOKUP_MAX_CSV_BYTES + 1),
		});

		const response = await POST(req as never, context());

		expect(response.status).toBe(413);
		expect(mocks.replaceLookupRows).not.toHaveBeenCalled();
		await response.json();
	});

	it("treats an aborted body read as a client close without error logging", async () => {
		const { req, arrayBuffer } = request({ contentType: "text/csv" });
		arrayBuffer.mockRejectedValue(
			Object.assign(new Error("aborted"), {
				code: "ECONNRESET",
			}),
		);

		const response = await POST(req as never, context());

		expect(response.status).toBe(499);
		expect(await response.json()).toMatchObject({
			success: false,
			code: "internal_error",
		});
		expect(mocks.logWarn).toHaveBeenCalledWith(
			"[lookup/import] client aborted request",
			{ err: "aborted" },
		);
		expect(mocks.logError).not.toHaveBeenCalled();
	});

	it("treats a downstream Zod failure as an internal fault", async () => {
		const downstream = z.string().safeParse(42);
		if (downstream.success) throw new Error("expected a synthetic Zod failure");
		mocks.getLookupTable.mockRejectedValue(downstream.error);
		const { req } = request({ contentType: "text/csv" });

		const response = await POST(req as never, context());

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			success: false,
			code: "internal_error",
		});
		expect(mocks.logError).toHaveBeenCalledWith(
			"[lookup/import] unhandled",
			downstream.error,
		);
	});

	it("returns structured invalid_csv details for malformed UTF-8 and CSV", async () => {
		for (const body of [
			new Uint8Array([0xc3, 0x28]),
			new TextEncoder().encode('name,count\n"unterminated,2'),
		]) {
			const { req } = request({ contentType: "text/csv", body });
			const response = await POST(req as never, context());
			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({
				success: false,
				code: "invalid_csv",
			});
		}
		expect(mocks.replaceLookupRows).not.toHaveBeenCalled();
	});

	it("coerces headers to immutable UUID values and calls server-only replacement", async () => {
		const { req } = request({ contentType: "text/csv; charset=utf-8" });

		const response = await POST(req as never, context());

		expect(response.status).toBe(200);
		expect(mocks.replaceLookupRows).toHaveBeenCalledWith(
			{
				projectId: "project-1",
				actorId: "user-1",
				role: "editor",
			},
			{
				tableId: TABLE_ID,
				expectedTableRevision: "7",
				rows: [
					{
						[NAME_COLUMN_ID]: "Clinic",
						[COUNT_COLUMN_ID]: 2,
					},
				],
			},
		);
		expect(await response.json()).toMatchObject({
			success: true,
			value: { tableRevision: "8" },
		});
	});

	it("maps a service storage rejection without leaking an internal error", async () => {
		mocks.replaceLookupRows.mockRejectedValue(
			new LookupError("storage_limit", "This table is too large."),
		);
		const { req } = request({ contentType: "text/csv" });

		const response = await POST(req as never, context());

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			success: false,
			code: "storage_limit",
			message: "This table is too large.",
		});
	});
});
