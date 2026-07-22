import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireSession } from "@/lib/auth-utils";
import { resolveAppScope } from "@/lib/db/appAccess";
import { listThreadMetas } from "@/lib/db/threads";
import { GET } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", () => ({ resolveAppScope: vi.fn() }));
vi.mock("@/lib/db/threads", () => ({ listThreadMetas: vi.fn() }));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(requireSession).mockResolvedValue({
		user: { id: "user-1" },
	} as never);
	vi.mocked(resolveAppScope).mockResolvedValue({
		projectId: "project-1",
	} as never);
	vi.mocked(listThreadMetas).mockResolvedValue([]);
});

describe("GET /api/apps/[id]/threads", () => {
	it("returns a view-gated, explicitly non-cacheable list", async () => {
		const response = await GET(new Request("http://localhost"), {
			params: Promise.resolve({ id: "app-1" }),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(resolveAppScope).toHaveBeenCalledWith("app-1", "user-1", "view");
		expect(await response.json()).toEqual({ threads: [] });
	});
});
