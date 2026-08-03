// @vitest-environment happy-dom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	barrier: vi.fn(),
	read: vi.fn(),
	create: vi.fn(),
	describeArchive: vi.fn(),
	subscribe: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/collab/context", () => ({
	useReconcilerContext: () => ({
		reconciler: { waitForHumanSaveBarrier: mocks.barrier },
		subscribeAppOrganization: mocks.subscribe,
	}),
}));

vi.mock("../actions", () => ({
	readOrganizationAction: mocks.read,
	createLocationAction: mocks.create,
	updateLocationAction: vi.fn(),
	moveLocationAction: vi.fn(),
	describeArchiveImpactAction: mocks.describeArchive,
	setLocationArchivedAction: vi.fn(),
}));

import { useOrganization } from "../useOrganization";

describe("useOrganization write barrier", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.read.mockResolvedValue({
			success: true,
			data: { revision: "0", locations: [] },
		});
	});

	it("does not write a place when the Blueprint save barrier fails", async () => {
		mocks.barrier.mockResolvedValue({ kind: "conflict" });
		const hook = renderHook(() => useOrganization("app"));
		await waitFor(() => expect(hook.result.current.loading).toBe(false));

		let outcome:
			| Awaited<ReturnType<typeof hook.result.current.create>>
			| undefined;
		await act(async () => {
			outcome = await hook.result.current.create({});
		});
		expect(outcome).toMatchObject({ ok: false });
		expect(outcome?.message).toMatch(/app changed/i);
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("turns a transport exception into a settled write result", async () => {
		mocks.barrier.mockResolvedValue({ kind: "saved" });
		mocks.create.mockRejectedValue(new Error("offline"));
		const hook = renderHook(() => useOrganization("app"));
		await waitFor(() => expect(hook.result.current.loading).toBe(false));

		let outcome:
			| Awaited<ReturnType<typeof hook.result.current.create>>
			| undefined;
		await act(async () => {
			outcome = await hook.result.current.create({});
		});
		expect(outcome).toMatchObject({ ok: false });
		if (outcome === undefined || outcome.ok)
			throw new Error("organization write unexpectedly passed");
		expect(outcome.message).toMatch(/could not be reached/i);
	});

	it("settles an archive-preflight transport exception", async () => {
		mocks.describeArchive.mockRejectedValue(new Error("offline"));
		const hook = renderHook(() => useOrganization("app"));
		await waitFor(() => expect(hook.result.current.loading).toBe(false));

		let outcome:
			| Awaited<ReturnType<typeof hook.result.current.describeArchive>>
			| undefined;
		await act(async () => {
			outcome = await hook.result.current.describeArchive("location");
		});
		expect(outcome).toMatchObject({ ok: false });
		if (outcome === undefined || outcome.ok) {
			throw new Error("archive preflight unexpectedly passed");
		}
		expect(outcome.message).toMatch(/could not be reached/i);
	});
});
