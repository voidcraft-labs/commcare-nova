import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireSession } from "@/lib/auth-utils";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { loadThread } from "@/lib/db/threads";
import { GET } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/appAccess")>()),
	resolveAppScope: vi.fn(),
}));
vi.mock("@/lib/db/threads", () => ({ loadThread: vi.fn() }));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(requireSession).mockResolvedValue({
		user: { id: "user-1" },
	} as never);
	vi.mocked(resolveAppScope).mockResolvedValue({
		projectId: "project-1",
	} as never);
	vi.mocked(loadThread).mockResolvedValue({
		thread_id: "thread-1",
		messages: [],
		holder_nonce: "00000000-0000-4000-8000-000000000001",
	} as never);
});

describe("GET /api/apps/[id]/threads/[threadId]", () => {
	it("returns a view-gated, explicitly non-cacheable transcript", async () => {
		const response = await GET(new Request("http://localhost"), {
			params: Promise.resolve({ id: "app-1", threadId: "thread-1" }),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(resolveAppScope).toHaveBeenCalledWith("app-1", "user-1", "view");
		expect(loadThread).toHaveBeenCalledWith(
			{ kind: "app", appId: "app-1" },
			"thread-1",
			"user-1",
		);
		expect(await response.json()).toMatchObject({
			thread: {
				thread_id: "thread-1",
				messages: [],
				holder_nonce: "00000000-0000-4000-8000-000000000001",
			},
		});
	});
});

it("keeps an access denial non-cacheable and does not read any transcript", async () => {
	vi.mocked(resolveAppScope).mockRejectedValueOnce(
		new AppAccessError("not_member"),
	);
	const response = await GET(new Request("http://localhost"), {
		params: Promise.resolve({ id: "app-1", threadId: "thread-1" }),
	});
	expect(response.status).toBe(404);
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	expect(await response.json()).toEqual({ error: "App not found" });
	expect(loadThread).not.toHaveBeenCalled();
});

it("returns an opaque non-cacheable missing-thread response", async () => {
	vi.mocked(loadThread).mockResolvedValueOnce(null);
	const response = await GET(new Request("http://localhost"), {
		params: Promise.resolve({ id: "app-1", threadId: "thread-1" }),
	});
	expect(response.status).toBe(404);
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	expect(await response.json()).toEqual({ error: "Thread not found" });
});
