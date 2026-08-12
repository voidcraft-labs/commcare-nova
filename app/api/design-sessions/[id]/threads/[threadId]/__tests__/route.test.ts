import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireSession } from "@/lib/auth-utils";
import { resolveGenerationTargetScope } from "@/lib/db/generationTargetScope";
import { loadThread } from "@/lib/db/threads";
import { GET } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/generationTargetScope", () => ({
	resolveGenerationTargetScope: vi.fn(),
}));
vi.mock("@/lib/db/threads", () => ({ loadThread: vi.fn() }));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(requireSession).mockResolvedValue({
		user: { id: "user-1" },
	} as never);
	vi.mocked(resolveGenerationTargetScope).mockResolvedValue({
		appId: null,
	} as never);
	vi.mocked(loadThread).mockResolvedValue({
		thread_id: "thread-1",
		messages: [],
		holder_nonce: "00000000-0000-4000-8000-000000000001",
	} as never);
});

describe("GET /api/design-sessions/[id]/threads/[threadId]", () => {
	it("returns an owner-gated, explicitly non-cacheable transcript", async () => {
		const response = await GET(new Request("http://localhost"), {
			params: Promise.resolve({ id: "design-1", threadId: "thread-1" }),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(resolveGenerationTargetScope).toHaveBeenCalledWith(
			{ kind: "design-session", designSessionId: "design-1" },
			"user-1",
			"view",
		);
		expect(loadThread).toHaveBeenCalledWith(
			{ kind: "design-session", designSessionId: "design-1" },
			"thread-1",
			"user-1",
		);
		expect(await response.json()).toMatchObject({
			thread: { thread_id: "thread-1", messages: [] },
			materializedAppId: null,
		});
	});

	it("projects a materialized app so the app-less client can leave its shell", async () => {
		vi.mocked(resolveGenerationTargetScope).mockResolvedValue({
			appId: "app-1",
		} as never);
		const response = await GET(new Request("http://localhost"), {
			params: Promise.resolve({ id: "design-1", threadId: "thread-1" }),
		});
		expect(await response.json()).toMatchObject({ materializedAppId: "app-1" });
	});

	it("re-reads materialization after loading the transcript", async () => {
		vi.mocked(resolveGenerationTargetScope)
			.mockResolvedValueOnce({ appId: null } as never)
			.mockResolvedValueOnce({ appId: "app-after-thread-read" } as never);
		const response = await GET(new Request("http://localhost"), {
			params: Promise.resolve({ id: "design-1", threadId: "thread-1" }),
		});
		expect(resolveGenerationTargetScope).toHaveBeenCalledTimes(2);
		expect(await response.json()).toMatchObject({
			materializedAppId: "app-after-thread-read",
		});
	});
});
