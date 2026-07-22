import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireSession } from "@/lib/auth-utils";
import { resolveAppScope } from "@/lib/db/appAccess";
import { loadThread } from "@/lib/db/threads";
import { GET } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", () => ({ resolveAppScope: vi.fn() }));
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
		expect(loadThread).toHaveBeenCalledWith("app-1", "thread-1");
		expect(await response.json()).toMatchObject({
			thread: { thread_id: "thread-1", messages: [] },
		});
	});
});
