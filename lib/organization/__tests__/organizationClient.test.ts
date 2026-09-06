import { describe, expect, it, vi } from "vitest";
import type { HumanSaveBarrierOutcome } from "@/lib/collab/reconciler";
import { asUuid } from "@/lib/domain";
import type { OrganizationResult } from "../actions";
import {
	createOrganizationClient,
	type OrganizationActions,
} from "../organizationClient";
import type {
	ArchiveImpact,
	OrganizationSnapshot,
	StoredLocation,
} from "../types";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const place: StoredLocation = {
	id: asUuid("01977777-7777-7777-8777-777777777771"),
	levelUuid: "01977777-7777-7777-8777-777777777772",
	parentId: null,
	siteCode: "coast",
	name: "Coast",
	externalId: null,
	latitude: null,
	longitude: null,
	values: {},
	archivedAt: null,
	orderKey: "a0",
};
const impact: ArchiveImpact = {
	revision: "7",
	confirmationToken: "server-preflight-token",
	affectedLocationCount: 3,
	unassignedPersonaCount: 2,
	unassignedPersonaPreview: ["Nurse", "Supervisor"],
	ownedCases: 9,
	blockingOwnerRuleFormCount: 0,
	blockingOwnerRuleFormPreview: [],
	blockingAutomationCount: 0,
	blockingAutomationPreview: [],
};
const ok = <T>(data: T): OrganizationResult<T> => ({ success: true, data });
const refuse = (
	code: "conflict" | "not-committed" | "invalid",
	message: string,
): OrganizationResult<never> => ({ success: false, code, message });
const read = (
	revision: string,
	locations: readonly StoredLocation[] = [place],
) => ok({ revision, locations });
const unreachable = async (): Promise<never> => {
	throw new Error("Unexpected action");
};
function harness() {
	const actions = {
		read: vi.fn<OrganizationActions["read"]>().mockResolvedValue(read("7")),
		create: vi.fn<OrganizationActions["create"]>(unreachable),
		update: vi.fn<OrganizationActions["update"]>(unreachable),
		move: vi.fn<OrganizationActions["move"]>(unreachable),
		describeArchive: vi.fn<OrganizationActions["describeArchive"]>(unreachable),
		setArchived: vi.fn<OrganizationActions["setArchived"]>(unreachable),
	};
	const barrier = vi
		.fn<() => Promise<HumanSaveBarrierOutcome>>()
		.mockResolvedValue({ kind: "saved" });
	const client = createOrganizationClient("app-one", actions, () => barrier);
	return { actions, barrier, client };
}
const offline =
	"The organization could not be reached. Check your connection and try again.";
const cancelled =
	"Saving stopped before this place could be changed. Reload, then try again.";

describe("organization client at its transport boundary", () => {
	it("distinguishes an unread organization from an empty one and retains a complete snapshot on refresh failure", async () => {
		const { client, actions } = harness();
		expect(client.getSnapshot()).toEqual({
			locations: [],
			revision: "0",
			loading: true,
			refreshing: false,
			error: undefined,
			warning: undefined,
		});
		actions.read.mockRejectedValueOnce(new Error("offline"));
		await client.refresh();
		expect(client.getSnapshot()).toEqual({
			locations: [],
			revision: "0",
			loading: false,
			refreshing: false,
			error: offline,
			warning: undefined,
		});
		await client.refresh();
		expect(client.getSnapshot()).toEqual({
			locations: [place],
			revision: "7",
			loading: false,
			refreshing: false,
			error: undefined,
			warning: undefined,
		});
		const pending = deferred<OrganizationResult<OrganizationSnapshot>>();
		actions.read.mockReturnValueOnce(pending.promise);
		const refresh = client.refresh();
		expect(client.getSnapshot()).toEqual({
			locations: [place],
			revision: "7",
			loading: false,
			refreshing: true,
			error: undefined,
			warning: undefined,
		});
		pending.resolve({
			success: false,
			code: "unavailable",
			message: "Places are temporarily unavailable.",
		});
		await refresh;
		expect(client.getSnapshot()).toEqual({
			locations: [place],
			revision: "7",
			loading: false,
			refreshing: false,
			error: undefined,
			warning: "Places are temporarily unavailable.",
		});
		actions.read.mockResolvedValueOnce(read("8", []));
		await client.refresh();
		expect(client.getSnapshot()).toEqual({
			locations: [],
			revision: "8",
			loading: false,
			refreshing: false,
			error: undefined,
			warning: undefined,
		});
	});

	it.each(["success", "failure"] as const)(
		"discards a superseded read's late %s",
		async (ending) => {
			const { client, actions } = harness();
			const slow = deferred<OrganizationResult<OrganizationSnapshot>>();
			actions.read.mockReturnValueOnce(slow.promise);
			const first = client.refresh();
			await client.refresh();
			const accepted = client.getSnapshot();
			if (ending === "success") slow.resolve(read("6", []));
			else slow.reject(new Error("old connection failed"));
			await first;
			expect(client.getSnapshot()).toBe(accepted);
		},
	);

	it("serializes every writer and chains exact int64 revisions before background reads finish", async () => {
		const { client, actions, barrier } = harness();
		actions.read.mockResolvedValueOnce(read("9007199254740992"));
		await client.refresh();
		const snapshots = Array.from({ length: 4 }, () =>
			deferred<OrganizationResult<OrganizationSnapshot>>(),
		);
		for (const snapshot of snapshots)
			actions.read.mockReturnValueOnce(snapshot.promise);
		const created =
			deferred<Awaited<ReturnType<OrganizationActions["create"]>>>();
		const started = deferred<void>();
		actions.create.mockImplementationOnce(() => {
			started.resolve();
			return created.promise;
		});
		const renamed = { ...place, name: "Coast Region" };
		actions.update.mockResolvedValueOnce(
			ok({ revision: "9007199254740994", location: renamed }),
		);
		actions.move.mockResolvedValueOnce(
			ok({ revision: "9007199254740995", location: renamed }),
		);
		actions.setArchived.mockResolvedValueOnce(
			ok({
				revision: "9007199254740996",
				archivedCount: 3,
				unassignedPersonaCount: 2,
			}),
		);
		const input = { name: "Coast", levelUuid: place.levelUuid };
		const patch = { name: "Coast Region" };
		const target = { parentId: null, afterSiblingId: null };
		const first = client.writer.create(input);
		const second = client.writer.update(place.id, patch);
		const third = client.writer.move(place.id, target);
		const confirmation = { ...impact, revision: "9007199254740995" };
		const fourth = client.writer.setArchived(place.id, true, confirmation);
		await started.promise;
		expect(barrier).toHaveBeenCalledTimes(1);
		expect(actions.update).not.toHaveBeenCalled();
		expect(actions.move).not.toHaveBeenCalled();
		expect(actions.setArchived).not.toHaveBeenCalled();
		created.resolve(ok({ revision: "9007199254740993", location: place }));
		expect(await Promise.all([first, second, third, fourth])).toEqual([
			{ ok: true, id: place.id },
			{ ok: true, location: renamed },
			{ ok: true, location: renamed },
			{ ok: true, unassignedPersonaCount: 2 },
		]);
		expect(actions.create.mock.calls).toEqual([
			["app-one", input, "9007199254740992"],
		]);
		expect(actions.update.mock.calls).toEqual([
			["app-one", place.id, patch, "9007199254740993"],
		]);
		expect(actions.move.mock.calls).toEqual([
			["app-one", place.id, target, "9007199254740994"],
		]);
		expect(actions.setArchived.mock.calls).toEqual([
			["app-one", place.id, true, "9007199254740995", confirmation],
		]);
		expect(barrier).toHaveBeenCalledTimes(4);
		expect(client.getSnapshot()).toMatchObject({
			revision: "9007199254740996",
			locations: [place],
			refreshing: true,
		});
		// Even a response from this client's earlier writes must not roll back its token.
		snapshots[3]?.resolve(read("9007199254740996", [renamed]));
		for (const stale of snapshots.slice(0, 3))
			stale.resolve(read("9007199254740993"));
		await Promise.all(snapshots.map((snapshot) => snapshot.promise));
		expect(client.getSnapshot()).toEqual({
			revision: "9007199254740996",
			locations: [renamed],
			loading: false,
			refreshing: false,
			error: undefined,
			warning: undefined,
		});
	});

	it.each([
		[
			{ kind: "conflict" },
			"The app changed before its places could be saved. Review the latest app, then try again.",
		],
		[
			{ kind: "accessChanged" },
			"Your access or the app's project changed before this place could be saved. Reload, then try again.",
		],
		[
			{ kind: "permanent", message: "That level was removed." },
			"That level was removed.",
		],
		[
			{ kind: "tooLarge" },
			"Your pending app changes are too large to save. Reload before changing places.",
		],
		[
			{ kind: "error", message: "The app could not be saved." },
			"The app could not be saved.",
		],
		[{ kind: "cancelled" }, cancelled],
	] satisfies readonly (readonly [HumanSaveBarrierOutcome, string])[])(
		"settles a %j Blueprint barrier without issuing a row write",
		async (outcome, message) => {
			const { client, actions, barrier } = harness();
			barrier.mockResolvedValueOnce(outcome);
			expect(await client.writer.update(place.id, { name: "New" })).toEqual({
				ok: false,
				message,
			});
			expect(actions.update).not.toHaveBeenCalled();
			expect(actions.read).not.toHaveBeenCalled();
		},
	);

	it("rechecks the Blueprint barrier and retries not-committed only once", async () => {
		const { client, actions, barrier } = harness();
		await client.refresh();
		actions.update.mockResolvedValue(
			refuse("not-committed", "The level is not committed."),
		);
		expect(await client.writer.update(place.id, { name: "New" })).toEqual({
			ok: false,
			message: "The level is not committed.",
		});
		expect(barrier).toHaveBeenCalledTimes(2);
		expect(actions.update.mock.calls).toEqual([
			["app-one", place.id, { name: "New" }, "7"],
			["app-one", place.id, { name: "New" }, "7"],
		]);
		expect(actions.read).toHaveBeenCalledTimes(1);
	});

	it("stops a not-committed retry when its second Blueprint barrier fails", async () => {
		const { client, actions, barrier } = harness();
		barrier
			.mockResolvedValueOnce({ kind: "saved" })
			.mockResolvedValueOnce({ kind: "cancelled" });
		actions.update.mockResolvedValueOnce(
			refuse("not-committed", "Pending level"),
		);
		expect(await client.writer.update(place.id, {})).toEqual({
			ok: false,
			message: cancelled,
		});
		expect(actions.update).toHaveBeenCalledTimes(1);
	});

	it("recovers not-committed with the same complete request after a successful second barrier", async () => {
		const { client, actions, barrier } = harness();
		await client.refresh();
		actions.read.mockResolvedValue(read("8"));
		actions.update
			.mockResolvedValueOnce(refuse("not-committed", "Pending level"))
			.mockResolvedValueOnce(ok({ revision: "8", location: place }));
		const patch = { valuePatch: { [place.levelUuid]: "one" } };
		expect(await client.writer.update(place.id, patch)).toEqual({
			ok: true,
			location: place,
		});
		expect(actions.update.mock.calls).toEqual([
			["app-one", place.id, patch, "7"],
			["app-one", place.id, patch, "7"],
		]);
		expect(barrier).toHaveBeenCalledTimes(2);
		expect(client.getSnapshot().revision).toBe("8");
	});

	it("holds the next write behind a conflict refresh and reads exactly once", async () => {
		const { client, actions } = harness();
		await client.refresh();
		const refresh = deferred<OrganizationResult<OrganizationSnapshot>>();
		const started = deferred<void>();
		actions.read.mockImplementationOnce(() => {
			started.resolve();
			return refresh.promise;
		});
		actions.update.mockResolvedValueOnce(
			refuse("conflict", "Another person changed this place."),
		);
		actions.move.mockResolvedValueOnce(
			refuse("invalid", "The destination is no longer available."),
		);
		const first = client.writer.update(place.id, { name: "New" });
		const second = client.writer.move(place.id, { parentId: null });
		await started.promise;
		expect(actions.move).not.toHaveBeenCalled();
		refresh.resolve(read("10"));
		expect(await first).toEqual({
			ok: false,
			message: "Another person changed this place.",
		});
		expect(await second).toEqual({
			ok: false,
			message: "The destination is no longer available.",
		});
		expect(actions.move.mock.calls).toEqual([
			["app-one", place.id, { parentId: null }, "10"],
		]);
		expect(actions.read).toHaveBeenCalledTimes(2);
	});

	it.each(["barrier", "action"] as const)(
		"settles a thrown %s without poisoning the next queued write",
		async (boundary) => {
			const { client, actions, barrier } = harness();
			if (boundary === "barrier")
				barrier.mockRejectedValueOnce(new Error("offline"));
			else actions.update.mockRejectedValueOnce(new Error("offline"));
			actions.update.mockResolvedValueOnce(
				refuse("invalid", "That place cannot be changed."),
			);
			const first = client.writer.update(place.id, { name: "One" });
			const second = client.writer.update(place.id, { name: "Two" });
			expect(await first).toEqual({ ok: false, message: offline });
			expect(await second).toEqual({
				ok: false,
				message: "That place cannot be changed.",
			});
			expect(barrier).toHaveBeenCalledTimes(2);
		},
	);

	it("reads archive preflight independently and preserves its full server description and refusals", async () => {
		const { client, actions, barrier } = harness();
		actions.describeArchive
			.mockResolvedValueOnce(ok(impact))
			.mockResolvedValueOnce(
				refuse("invalid", "This place is already archived."),
			)
			.mockRejectedValueOnce(new Error("offline"));
		expect(await client.writer.describeArchive(place.id)).toEqual({
			ok: true,
			impact,
		});
		expect(await client.writer.describeArchive(place.id)).toEqual({
			ok: false,
			message: "This place is already archived.",
		});
		expect(await client.writer.describeArchive(place.id)).toEqual({
			ok: false,
			message: offline,
		});
		expect(actions.describeArchive.mock.calls).toEqual(
			Array.from({ length: 3 }, () => ["app-one", place.id]),
		);
		expect(barrier).not.toHaveBeenCalled();
		expect(actions.setArchived).not.toHaveBeenCalled();
	});

	it("completes accepted gestures after disposal and preserves the original app's save barrier", async () => {
		const { actions, barrier } = harness();
		const replacementBarrier = vi
			.fn<() => Promise<HumanSaveBarrierOutcome>>()
			.mockResolvedValue({ kind: "cancelled" });
		let currentBarrier = barrier;
		const client = createOrganizationClient(
			"app-one",
			actions,
			() => currentBarrier,
		);
		await client.refresh();
		const receipt =
			deferred<Awaited<ReturnType<OrganizationActions["update"]>>>();
		const started = deferred<void>();
		actions.update
			.mockImplementationOnce(() => {
				started.resolve();
				return receipt.promise;
			})
			.mockResolvedValueOnce(ok({ revision: "9", location: place }));
		const listener = vi.fn();
		const unsubscribe = client.subscribe(listener);
		const before = client.getSnapshot();
		const first = client.writer.update(place.id, { name: "One" });
		const second = client.writer.update(place.id, { name: "Two" });
		await started.promise;
		client.dispose();
		currentBarrier = replacementBarrier;
		receipt.resolve(ok({ revision: "8", location: place }));
		expect(await Promise.all([first, second])).toEqual([
			{ ok: true, location: place },
			{ ok: true, location: place },
		]);
		expect(actions.update.mock.calls).toEqual([
			["app-one", place.id, { name: "One" }, "7"],
			["app-one", place.id, { name: "Two" }, "8"],
		]);
		expect(barrier).toHaveBeenCalledTimes(2);
		expect(replacementBarrier).not.toHaveBeenCalled();
		expect(client.getSnapshot()).toBe(before);
		expect(listener).not.toHaveBeenCalled();
		expect(actions.read).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("refreshes a conflict for already queued work after disposal without publishing to the closed view", async () => {
		const { client, actions } = harness();
		await client.refresh();
		const receipt =
			deferred<Awaited<ReturnType<OrganizationActions["update"]>>>();
		const started = deferred<void>();
		actions.update
			.mockImplementationOnce(() => {
				started.resolve();
				return receipt.promise;
			})
			.mockResolvedValueOnce(ok({ revision: "11", location: place }));
		actions.read.mockResolvedValueOnce(read("10"));
		const first = client.writer.update(place.id, { name: "One" });
		const second = client.writer.update(place.id, { name: "Two" });
		await started.promise;
		const before = client.getSnapshot();
		client.dispose();
		receipt.resolve(refuse("conflict", "Another person changed this place."));
		expect(await first).toEqual({
			ok: false,
			message: "Another person changed this place.",
		});
		expect(await second).toEqual({ ok: true, location: place });
		expect(actions.update.mock.calls[1]).toEqual([
			"app-one",
			place.id,
			{ name: "Two" },
			"10",
		]);
		expect(actions.read).toHaveBeenCalledTimes(2);
		expect(client.getSnapshot()).toBe(before);
	});

	it("supports effect teardown and reactivation without accepting an earlier lifetime's read", async () => {
		const { client, actions } = harness();
		const old = deferred<OrganizationResult<OrganizationSnapshot>>();
		actions.read.mockReturnValueOnce(old.promise);
		const pending = client.refresh();
		client.dispose();
		const listener = vi.fn();
		const unsubscribe = client.subscribe(listener);
		client.activate();
		// Wait for the activated read, with no timer or React scheduler involved.
		await actions.read.mock.results[1]?.value;
		const current = client.getSnapshot();
		old.resolve(read("6", []));
		await pending;
		expect(client.getSnapshot()).toBe(current);
		expect(current.locations).toEqual([place]);
		expect(listener).toHaveBeenCalledTimes(2);
		unsubscribe();
		await client.refresh();
		expect(listener).toHaveBeenCalledTimes(2);
	});
});
