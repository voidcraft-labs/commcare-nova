// @vitest-environment happy-dom

/**
 * Network-wiring tests for the React-free reconciler runtime.
 *
 * The reconciler state machine has its own headless suite. These cases exercise
 * the thin EventSource ownership layer that cannot be proven through broker or
 * reconciler tests alone: a Project handoff must clear retained tenant data,
 * replace the stream, and reject callbacks queued by the superseded instance.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresenceFrame } from "@/lib/collab/presenceTypes";
import { createReconcilerRuntime } from "@/lib/collab/ReconcilerProvider";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import type { LookupManifest } from "@/lib/lookup/types";
import { createBuilderSessionStore } from "@/lib/session/store";

const reportClientError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clientErrorReporter", () => ({ reportClientError }));
const getLookupManifestAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lookup/actions", () => ({ getLookupManifestAction }));

const SOURCE_MANIFEST = {
	projectId: "project-source",
	projectRevision: "17",
	tables: [
		{
			id: "01890f45-0000-7000-8000-000000000001",
			name: "Facilities",
			tag: "facilities",
			columnCount: 2,
			rowCount: 3,
			dataBytes: 128,
			definitionRevision: "12",
			rowsRevision: "17",
			tableRevision: "17",
		},
	],
} as LookupManifest;

const DESTINATION_MANIFEST = {
	projectId: "project-destination",
	projectRevision: "1",
	tables: [],
} as unknown as LookupManifest;

const SOURCE_PRESENCE = [
	{
		userId: "source-user",
		sessionId: "source-session",
		name: "Source collaborator",
		image: null,
		email: "source@dimagi.com",
		color: "#123456",
		location: { kind: "home" },
		updatedAt: 1,
	},
] as PresenceFrame;

const DESTINATION_PRESENCE = [
	{
		...SOURCE_PRESENCE[0],
		userId: "destination-user",
		sessionId: "destination-session",
		name: "Destination collaborator",
		email: "destination@dimagi.com",
	},
] as PresenceFrame;

function emptyDoc(): BlueprintDoc {
	return {
		appId: "app-1",
		appName: "App",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

type FakeListener = (event: { data?: string; lastEventId?: string }) => void;

class FakeEventSource {
	static readonly CLOSED = 2;
	static readonly instances: FakeEventSource[] = [];

	readonly listeners = new Map<string, Set<FakeListener>>();
	readyState = 1;

	constructor(readonly url: string) {
		FakeEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: FakeListener): void {
		const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	close(): void {
		this.readyState = FakeEventSource.CLOSED;
	}

	emit(type: string, data?: string, lastEventId = ""): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener({ data, lastEventId });
		}
	}
}

afterEach(() => {
	FakeEventSource.instances.length = 0;
	window.sessionStorage.clear();
	reportClientError.mockReset();
	getLookupManifestAction.mockReset();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("ReconcilerProvider EventSource ownership", () => {
	it("activates a dormant build at the server-provided cursor without replacing its doc", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		const docStore = createBlueprintDocStore();
		docStore.getState().load(toPersistableDoc(emptyDoc()));
		docStore
			.getState()
			.applyMany([{ kind: "setAppName", name: "Built locally" }]);
		const sessionStore = createBuilderSessionStore({
			projectId: "project-seeded-by-build-new",
			role: "editor",
			canEdit: true,
		});
		const runtime = createReconcilerRuntime(
			docStore,
			sessionStore,
			{ appId: undefined, baseSeq: 0, userId: "self" },
			() => {},
		);

		runtime.start();
		expect(FakeEventSource.instances).toHaveLength(0);
		sessionStore.getState().activateCreatedApp("app-created", {
			projectId: "project-seeded-by-build-new",
			role: "editor",
			canEdit: true,
		});
		runtime.activate("app-created", 7);

		expect(runtime.reconciler.getSnapshot()).toMatchObject({
			appId: "app-created",
			baseSeq: 7,
		});
		expect(docStore.getState().appName).toBe("Built locally");
		expect(FakeEventSource.instances[0]?.url).toBe(
			"/api/apps/app-created/stream?since=7",
		);
		runtime.suspend();
	});

	it("clears Project-scoped state on reload and ignores the superseded stream", async () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		const docStore = createBlueprintDocStore();
		const persistedDoc = toPersistableDoc(emptyDoc());
		const sessionStore = createBuilderSessionStore({
			appId: "app-1",
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		docStore.getState().load(persistedDoc);
		docStore.getState().startTracking();

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({
					projectId: "project-destination",
					role: "editor",
					canEdit: true,
					blueprint: persistedDoc,
					baseSeq: 0,
				}),
			})),
		);

		const runtime = createReconcilerRuntime(
			docStore,
			sessionStore,
			{ appId: "app-1", baseSeq: 0, userId: "self" },
			() => {},
		);
		const lookupSnapshots: Array<LookupManifest | null> = [];
		const presenceSnapshots: PresenceFrame[] = [];
		runtime.lookupManifestBroker.subscribe((snapshot) => {
			lookupSnapshots.push(snapshot);
		});
		runtime.presenceSubs.add((snapshot) => {
			presenceSnapshots.push(snapshot);
		});

		runtime.start();
		const sourceStream = FakeEventSource.instances[0];
		expect(sourceStream.url).toBe("/api/apps/app-1/stream?since=0");
		sourceStream.emit("lookup-revision", JSON.stringify(SOURCE_MANIFEST));
		sourceStream.emit("presence", JSON.stringify(SOURCE_PRESENCE));
		expect(lookupSnapshots).toEqual([SOURCE_MANIFEST]);
		expect(presenceSnapshots).toEqual([SOURCE_PRESENCE]);

		sourceStream.emit("reload");
		expect(sourceStream.readyState).toBe(FakeEventSource.CLOSED);
		expect(lookupSnapshots).toEqual([SOURCE_MANIFEST, null]);
		expect(presenceSnapshots).toEqual([SOURCE_PRESENCE, []]);

		await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
		const destinationStream = FakeEventSource.instances[1];

		// Queued callbacks can still invoke the old listener after close. Ownership
		// guards must reject them so source data cannot relatch after the reset.
		sourceStream.emit("lookup-revision", JSON.stringify(SOURCE_MANIFEST));
		sourceStream.emit("presence", JSON.stringify(SOURCE_PRESENCE));
		expect(lookupSnapshots).toEqual([SOURCE_MANIFEST, null]);
		expect(presenceSnapshots).toEqual([SOURCE_PRESENCE, []]);

		destinationStream.emit(
			"lookup-revision",
			JSON.stringify(DESTINATION_MANIFEST),
		);
		destinationStream.emit("presence", JSON.stringify(DESTINATION_PRESENCE));
		expect(lookupSnapshots).toEqual([
			SOURCE_MANIFEST,
			null,
			DESTINATION_MANIFEST,
		]);
		expect(presenceSnapshots).toEqual([
			SOURCE_PRESENCE,
			[],
			DESTINATION_PRESENCE,
		]);

		runtime.suspend();
		expect(destinationStream.readyState).toBe(FakeEventSource.CLOSED);
	});

	it.each([
		{
			name: "a malformed mutation frame",
			event: "mutation",
			data: JSON.stringify({
				seq: 1,
				batchId: "peer-batch",
				actorId: "peer",
				kind: "autosave",
				mutations: [
					{ kind: "setAppName", name: "must not apply", unexpected: true },
				],
			}),
			reportsClientError: true,
			errorMessage: "Reconciler protocol mismatch: mutation frame rejected",
		},
		{
			name: "a malformed revocation frame",
			event: "revoked",
			data: JSON.stringify({
				reason: "access-revoked",
				unexpected: true,
			}),
			reportsClientError: true,
			errorMessage: "Reconciler: malformed revocation frame",
		},
		{
			name: "a server protocol-failure terminal",
			event: "protocol-failure",
			data: JSON.stringify({ reason: "malformed-mutation-suffix" }),
			reportsClientError: false,
			errorMessage: undefined,
		},
	])(
		"disowns the stream and reloads from the unchanged cursor after $name",
		async ({ event, data, reportsClientError, errorMessage }) => {
			vi.stubGlobal("EventSource", FakeEventSource);
			const persistedDoc = toPersistableDoc(emptyDoc());
			const docStore = createBlueprintDocStore();
			docStore.getState().load(persistedDoc);
			docStore.getState().startTracking();
			const sessionStore = createBuilderSessionStore({
				appId: "app-1",
				projectId: "project-source",
				role: "editor",
				canEdit: true,
			});

			let resolveReload: ((response: unknown) => void) | undefined;
			const reloadFetch = vi.fn(
				() =>
					new Promise((resolve) => {
						resolveReload = resolve;
					}),
			);
			vi.stubGlobal("fetch", reloadFetch);

			const runtime = createReconcilerRuntime(
				docStore,
				sessionStore,
				{ appId: "app-1", baseSeq: 0, userId: "self" },
				() => {},
			);
			runtime.start();
			const sourceStream = FakeEventSource.instances[0];

			sourceStream.emit(event, data, "14");

			expect(sourceStream.readyState).toBe(FakeEventSource.CLOSED);
			expect(runtime.reconciler.getSnapshot().baseSeq).toBe(0);
			expect(docStore.getState().appName).toBe("App");
			expect(reloadFetch).toHaveBeenCalledTimes(1);
			if (reportsClientError) {
				if (event === "mutation") {
					expect(reportClientError).toHaveBeenCalledWith(
						expect.objectContaining({
							diagnostics: expect.objectContaining({
								component: "reconciler",
								operation: "mutation-frame",
								failureKind: "mutation-admission",
								appId: "app-1",
								baseSeq: 0,
								eventId: "14",
								payloadBytes: new TextEncoder().encode(data).byteLength,
							}),
						}),
						expect.any(Error),
					);
				} else {
					expect(reportClientError).toHaveBeenCalledWith(
						expect.objectContaining({ message: errorMessage }),
					);
				}
			} else {
				expect(reportClientError).not.toHaveBeenCalled();
			}

			resolveReload?.({
				ok: true,
				status: 200,
				json: async () => ({
					projectId: "project-source",
					role: "editor",
					canEdit: true,
					blueprint: persistedDoc,
					baseSeq: 0,
				}),
			});
			await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
			expect(FakeEventSource.instances[1]?.url).toBe(
				"/api/apps/app-1/stream?since=0",
			);

			runtime.suspend();
		},
	);

	it("links a rejected recovery snapshot to the malformed mutation that triggered it", async () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		const persistedDoc = toPersistableDoc(emptyDoc());
		const propertyUuid = "01890f45-0000-7000-8000-000000000001";
		const privateChoice = "private-choice-must-not-reach-telemetry";
		const docStore = createBlueprintDocStore();
		docStore.getState().load(persistedDoc);
		docStore.getState().startTracking();
		const sessionStore = createBuilderSessionStore({
			appId: "app-1",
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					projectId: "project-source",
					role: "editor",
					canEdit: true,
					blueprint: {
						...persistedDoc,
						userProperties: {
							[propertyUuid]: {
								uuid: propertyUuid,
								slug: "private_choice",
								label: "Private choice",
								choices: [privateChoice, privateChoice],
							},
						},
						userPropertyOrder: [propertyUuid],
					},
					baseSeq: 14,
				}),
			),
		);

		const runtime = createReconcilerRuntime(
			docStore,
			sessionStore,
			{ appId: "app-1", baseSeq: 13, userId: "self" },
			() => {},
		);
		runtime.start();
		FakeEventSource.instances[0].emit(
			"mutation",
			JSON.stringify({
				seq: 14,
				batchId: "peer-batch",
				actorId: "peer",
				kind: "autosave",
				mutations: [
					{ kind: "setAppName", name: "not-retained", unexpected: true },
				],
			}),
			"14",
		);

		await vi.waitFor(() => expect(reportClientError).toHaveBeenCalledTimes(2));
		expect(reportClientError).toHaveBeenLastCalledWith(
			expect.objectContaining({
				message: "Reconciler recovery snapshot rejected",
				diagnostics: expect.objectContaining({
					component: "reconciler",
					operation: "reload-get",
					failureKind: "snapshot-schema",
					appId: "app-1",
					baseSeq: 13,
					httpStatus: 200,
					recoveryTrigger: "malformed-mutation-frame",
					eventId: "14",
					issues: expect.arrayContaining([
						expect.stringContaining(
							`/blueprint/userProperties/${propertyUuid}/choices/1`,
						),
					]),
				}),
			}),
			expect.any(Error),
		);
		const [reportedPayload, reportedError] =
			reportClientError.mock.lastCall ?? [];
		expect(reportedPayload?.stack).not.toContain(privateChoice);
		expect(reportedError).toMatchObject({
			message: "reconciler reload snapshot failed schema admission",
		});
		expect((reportedError as Error).stack).not.toContain(privateChoice);
		expect(JSON.stringify(reportClientError.mock.calls)).not.toContain(
			privateChoice,
		);
		runtime.suspend();
	});

	it("does not trust an unknown canonicality reason from a malformed PUT response", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("EventSource", FakeEventSource);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json(
					{
						type: "mutation_wire_canonicality_invalid",
						details: {
							mutationIndex: 0,
							pointer: "/0/name",
							reason: "invented-reason",
						},
					},
					{ status: 400 },
				),
			),
		);
		const persistedDoc = toPersistableDoc(emptyDoc());
		const docStore = createBlueprintDocStore();
		docStore.getState().load(persistedDoc);
		docStore.getState().startTracking();
		const sessionStore = createBuilderSessionStore({
			appId: "app-1",
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		const runtime = createReconcilerRuntime(
			docStore,
			sessionStore,
			{ appId: "app-1", baseSeq: 0, userId: "self" },
			() => {},
		);
		const observed: string[] = [];

		runtime.start();
		docStore
			.getState()
			.applyMany([{ kind: "setAppName", name: "Still local" }]);
		runtime.reconciler.dispatchHumanBatch((signal) =>
			observed.push(signal.kind),
		);
		await vi.waitFor(() => expect(observed).toContain("error"));

		const snapshot = runtime.reconciler.getSnapshot();
		expect(snapshot.revoked).toBe(false);
		expect(snapshot.sentPending).toHaveLength(1);
		expect(docStore.getState().appName).toBe("Still local");
		expect(observed).not.toContain("permanent");
		runtime.suspend();
	});

	it("clears and authoritatively refetches only presence after a malformed frame", async () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		const presenceFetch = vi.fn(async () =>
			Response.json(DESTINATION_PRESENCE),
		);
		vi.stubGlobal("fetch", presenceFetch);
		const persistedDoc = toPersistableDoc(emptyDoc());
		const docStore = createBlueprintDocStore();
		docStore.getState().load(persistedDoc);
		const sessionStore = createBuilderSessionStore({
			appId: "app-1",
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		const runtime = createReconcilerRuntime(
			docStore,
			sessionStore,
			{ appId: "app-1", baseSeq: 0, userId: "self" },
			() => {},
		);
		const presenceSnapshots: PresenceFrame[] = [];
		runtime.presenceSubs.add((snapshot) => presenceSnapshots.push(snapshot));

		runtime.start();
		const stream = FakeEventSource.instances[0];
		stream.emit("presence", JSON.stringify(SOURCE_PRESENCE));
		stream.emit(
			"presence",
			JSON.stringify([
				{
					...SOURCE_PRESENCE[0],
					unexpected: true,
				},
			]),
		);

		expect(presenceSnapshots).toEqual([SOURCE_PRESENCE, []]);
		await vi.waitFor(() =>
			expect(presenceSnapshots).toEqual([
				SOURCE_PRESENCE,
				[],
				DESTINATION_PRESENCE,
			]),
		);
		expect(presenceFetch).toHaveBeenCalledExactlyOnceWith(
			"/api/apps/app-1/presence",
			{ cache: "no-store" },
		);
		expect(stream.readyState).not.toBe(FakeEventSource.CLOSED);
		expect(reportClientError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Reconciler: malformed presence frame",
			}),
		);
		runtime.suspend();
	});

	it("clears and authoritatively refetches lookup state after a malformed frame", async () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		const refreshed = {
			projectId: "project-source",
			projectRevision: "18",
			tables: [],
		} as unknown as LookupManifest;
		getLookupManifestAction.mockResolvedValue({
			success: true,
			value: refreshed,
		});
		const docStore = createBlueprintDocStore();
		docStore.getState().load(toPersistableDoc(emptyDoc()));
		const sessionStore = createBuilderSessionStore({
			appId: "app-1",
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		const runtime = createReconcilerRuntime(
			docStore,
			sessionStore,
			{ appId: "app-1", baseSeq: 0, userId: "self" },
			() => {},
		);
		const snapshots: Array<LookupManifest | null> = [];
		runtime.lookupManifestBroker.subscribe((snapshot) =>
			snapshots.push(snapshot),
		);

		runtime.start();
		const stream = FakeEventSource.instances[0];
		stream.emit("lookup-revision", JSON.stringify(SOURCE_MANIFEST));
		stream.emit(
			"lookup-revision",
			JSON.stringify({ ...SOURCE_MANIFEST, unexpected: true }),
		);

		expect(snapshots).toEqual([SOURCE_MANIFEST, null]);
		await vi.waitFor(() =>
			expect(snapshots).toEqual([SOURCE_MANIFEST, null, refreshed]),
		);
		expect(getLookupManifestAction).toHaveBeenCalledExactlyOnceWith(
			"project-source",
		);
		expect(stream.readyState).not.toBe(FakeEventSource.CLOSED);
		expect(reportClientError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Reconciler: malformed lookup manifest frame",
			}),
		);
		runtime.suspend();
	});

	it("cancels a superseded reopen while a non-SSE reload is pending", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("EventSource", FakeEventSource);
		const persistedDoc = toPersistableDoc(emptyDoc());
		const docStore = createBlueprintDocStore();
		const sessionStore = createBuilderSessionStore({
			appId: "app-1",
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		docStore.getState().load(persistedDoc);
		docStore.getState().startTracking();

		let resolveReload: ((response: unknown) => void) | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise((resolve) => {
						resolveReload = resolve;
					}),
			),
		);

		const runtime = createReconcilerRuntime(
			docStore,
			sessionStore,
			{ appId: "app-1", baseSeq: 0, userId: "self" },
			() => {},
		);
		const lookupSnapshots: Array<LookupManifest | null> = [];
		runtime.lookupManifestBroker.subscribe((snapshot) => {
			lookupSnapshots.push(snapshot);
		});
		runtime.start();
		const sourceStream = FakeEventSource.instances[0];
		sourceStream.emit("lookup-revision", JSON.stringify(SOURCE_MANIFEST));

		// A terminal transport error schedules a reopen against this captured
		// stream. Before that timer fires, a mutation gap starts the authoritative
		// reload path without an SSE `reload` event.
		sourceStream.readyState = FakeEventSource.CLOSED;
		sourceStream.emit("error");
		sourceStream.emit(
			"mutation",
			JSON.stringify({
				seq: 2,
				batchId: "gap-batch",
				actorId: "peer",
				kind: "autosave",
				mutations: [],
			}),
		);
		expect(lookupSnapshots).toEqual([SOURCE_MANIFEST, null]);
		expect(resolveReload).toBeTypeOf("function");

		await vi.advanceTimersByTimeAsync(1_000);
		// The retry closure belongs to the disowned source stream and must not
		// create a second connection while the authoritative GET is pending.
		expect(FakeEventSource.instances).toHaveLength(1);

		resolveReload?.({
			ok: true,
			status: 200,
			json: async () => ({
				projectId: "project-destination",
				role: "editor",
				canEdit: true,
				blueprint: persistedDoc,
				baseSeq: 0,
			}),
		});
		await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));

		runtime.suspend();
		expect(FakeEventSource.instances[1].readyState).toBe(
			FakeEventSource.CLOSED,
		);
	});

	it("fails closed when a Project-scoped surface cannot clear", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);
		const persistedDoc = toPersistableDoc(emptyDoc());
		const docStore = createBlueprintDocStore();
		docStore.getState().load(persistedDoc);
		docStore.getState().startTracking();
		const sessionStore = createBuilderSessionStore({
			appId: "app-1",
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		const runtime = createReconcilerRuntime(
			docStore,
			sessionStore,
			{ appId: "app-1", baseSeq: 0, userId: "self" },
			() => {},
		);
		const survivor = vi.fn();
		runtime.lookupManifestBroker.subscribe((snapshot) => {
			if (snapshot === null) throw new Error("surface retained source data");
		});
		runtime.lookupManifestBroker.subscribe(survivor);

		runtime.start();
		const sourceStream = FakeEventSource.instances[0];
		sourceStream.emit("lookup-revision", JSON.stringify(SOURCE_MANIFEST));
		sourceStream.emit("reload");

		expect(survivor).toHaveBeenLastCalledWith(null);
		expect(sessionStore.getState()).toMatchObject({
			canEdit: false,
			accessPhase: "revoked",
		});
		expect(runtime.reconciler.getSnapshot().revoked).toBe(true);
		expect(FakeEventSource.instances).toHaveLength(1);
		expect(reportClientError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Project-scope cache reset failed (app app-1)",
			}),
		);
		runtime.suspend();
	});

	it("clears Project-scoped state before confirming that view access is gone", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		const persistedDoc = toPersistableDoc(emptyDoc());
		const docStore = createBlueprintDocStore();
		docStore.getState().load(persistedDoc);
		docStore.getState().startTracking();
		const sessionStore = createBuilderSessionStore({
			appId: "app-1",
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		const runtime = createReconcilerRuntime(
			docStore,
			sessionStore,
			{ appId: "app-1", baseSeq: 0, userId: "self" },
			() => {},
		);
		const lookupSnapshots: Array<LookupManifest | null> = [];
		const presenceSnapshots: PresenceFrame[] = [];
		runtime.lookupManifestBroker.subscribe((snapshot) =>
			lookupSnapshots.push(snapshot),
		);
		runtime.presenceSubs.add((snapshot) => presenceSnapshots.push(snapshot));

		runtime.start();
		const sourceStream = FakeEventSource.instances[0];
		sourceStream.emit("lookup-revision", JSON.stringify(SOURCE_MANIFEST));
		sourceStream.emit("presence", JSON.stringify(SOURCE_PRESENCE));
		sourceStream.emit("revoked", JSON.stringify({ reason: "access-revoked" }));

		expect(sourceStream.readyState).toBe(FakeEventSource.CLOSED);
		expect(lookupSnapshots).toEqual([SOURCE_MANIFEST, null]);
		expect(presenceSnapshots).toEqual([SOURCE_PRESENCE, []]);
		expect(sessionStore.getState()).toMatchObject({
			canEdit: false,
			accessPhase: "revoked",
		});
		expect(runtime.reconciler.getSnapshot().revoked).toBe(true);
		expect(FakeEventSource.instances).toHaveLength(1);
		runtime.suspend();
	});

	it("shows a distinct refresh-required state after the one-shot upgrade latch", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		window.sessionStorage.setItem("nova:stream-upgrade:app-1:receiver-3", "1");
		const persistedDoc = toPersistableDoc(emptyDoc());
		const docStore = createBlueprintDocStore();
		docStore.getState().load(persistedDoc);
		docStore.getState().startTracking();
		const sessionStore = createBuilderSessionStore({
			appId: "app-1",
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		const runtime = createReconcilerRuntime(
			docStore,
			sessionStore,
			{ appId: "app-1", baseSeq: 0, userId: "self" },
			() => {},
		);
		const snapshots: Array<LookupManifest | null> = [];
		runtime.lookupManifestBroker.subscribe((snapshot) =>
			snapshots.push(snapshot),
		);

		runtime.start();
		const sourceStream = FakeEventSource.instances[0];
		sourceStream.emit("lookup-revision", JSON.stringify(SOURCE_MANIFEST));
		sourceStream.emit(
			"revoked",
			JSON.stringify({ reason: "client-upgrade-required" }),
		);

		expect(sourceStream.readyState).toBe(FakeEventSource.CLOSED);
		expect(snapshots).toEqual([SOURCE_MANIFEST, null]);
		expect(sessionStore.getState()).toMatchObject({
			canEdit: false,
			accessPhase: "upgradeRequired",
		});
		expect(runtime.reconciler.getSnapshot().revoked).toBe(true);
		expect(FakeEventSource.instances).toHaveLength(1);
		runtime.suspend();
	});
});

describe("app-status frame → buildUnfinished latch", () => {
	it("routes the server's lifecycle read into the latch and ignores garbage", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		const docStore = createBlueprintDocStore();
		docStore.getState().load(toPersistableDoc(emptyDoc()));
		docStore.getState().startTracking();
		/* A tab that opened a generating app: latch seeded true, and — the gap
		 * this frame closes — never attached to the run's chat stream, so no
		 * `data-done` will ever release it. */
		const sessionStore = createBuilderSessionStore({
			appId: "app-1",
			projectId: "project-source",
			role: "editor",
			canEdit: true,
			buildUnfinished: true,
		});
		const runtime = createReconcilerRuntime(
			docStore,
			sessionStore,
			{ appId: "app-1", baseSeq: 0, userId: "self" },
			() => {},
		);
		runtime.start();
		const stream = FakeEventSource.instances[0];

		/* Malformed / out-of-vocabulary frames must not move a pricing signal. */
		stream.emit("app-status", "not json");
		stream.emit("app-status", JSON.stringify({ status: "deleted" }));
		expect(sessionStore.getState().buildUnfinished).toBe(true);

		/* The teammate's build finished: only `complete` releases. */
		stream.emit("app-status", JSON.stringify({ status: "complete" }));
		expect(sessionStore.getState().buildUnfinished).toBe(false);

		/* The frames are seq-less, so the STORE enforces direction: `complete`
		 * is terminal in the app lifecycle, and an arming frame delivered
		 * after an observed completion is a stale read (a cadence tick that
		 * resolved just before the completing run committed), not fresh
		 * truth. It must not re-price a finished app's sends as builds. */
		stream.emit("app-status", JSON.stringify({ status: "generating" }));
		expect(sessionStore.getState().buildUnfinished).toBe(false);
		stream.emit("app-status", JSON.stringify({ status: "error" }));
		expect(sessionStore.getState().buildUnfinished).toBe(false);

		runtime.suspend();
	});

	it("arms the latch from a frame before any observed completion", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		const docStore = createBlueprintDocStore();
		docStore.getState().load(toPersistableDoc(emptyDoc()));
		docStore.getState().startTracking();
		/* An `error` app whose page seed read false (the arm this frame
		 * channel repairs at connect): no completion observed, so the frame
		 * arms normally. */
		const sessionStore = createBuilderSessionStore({
			appId: "app-1",
			projectId: "project-source",
			role: "editor",
			canEdit: true,
			buildUnfinished: false,
		});
		const runtime = createReconcilerRuntime(
			docStore,
			sessionStore,
			{ appId: "app-1", baseSeq: 0, userId: "self" },
			() => {},
		);
		runtime.start();
		const stream = FakeEventSource.instances[0];

		stream.emit("app-status", JSON.stringify({ status: "error" }));
		expect(sessionStore.getState().buildUnfinished).toBe(true);

		runtime.suspend();
	});
});

describe("preview-project-space frame → subscriber fan-out", () => {
	it("fans frames out, replays the latest to a late subscriber, and ignores garbage", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		const docStore = createBlueprintDocStore();
		docStore.getState().load(toPersistableDoc(emptyDoc()));
		docStore.getState().startTracking();
		const sessionStore = createBuilderSessionStore({
			appId: "app-1",
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		const runtime = createReconcilerRuntime(
			docStore,
			sessionStore,
			{ appId: "app-1", baseSeq: 0, userId: "self" },
			() => {},
		);
		runtime.start();
		const stream = FakeEventSource.instances[0];

		const seen: Array<string | null> = [];
		runtime.subscribePreviewProjectSpace((space) => seen.push(space));

		/* Malformed frames must not move what an expression evaluates to:
		 * garbage, an empty-string space (the resolver never names one — an
		 * empty `commcare_project` is a value no worker can hold), and an
		 * unknown key all drop. */
		stream.emit("preview-project-space", "not json");
		stream.emit("preview-project-space", JSON.stringify({ projectSpace: "" }));
		stream.emit("preview-project-space", JSON.stringify({ other: "x" }));
		expect(seen).toEqual([]);

		stream.emit(
			"preview-project-space",
			JSON.stringify({ projectSpace: "acme" }),
		);
		expect(seen).toEqual(["acme"]);
		/* An observation walked the deployment back: `null` is a real answer
		 * (Preview names nothing), delivered like any other. */
		stream.emit(
			"preview-project-space",
			JSON.stringify({ projectSpace: null }),
		);
		expect(seen).toEqual(["acme", null]);

		/* A subscriber arriving after those frames still receives the retained
		 * answer immediately, so mount order can never lose the connect-time
		 * resolution — and an unsubscribed one hears nothing more. */
		const late: Array<string | null> = [];
		const unsubscribe = runtime.subscribePreviewProjectSpace((space) =>
			late.push(space),
		);
		expect(late).toEqual([null]);
		unsubscribe();
		stream.emit(
			"preview-project-space",
			JSON.stringify({ projectSpace: "beta" }),
		);
		expect(late).toEqual([null]);
		expect(seen).toEqual(["acme", null, "beta"]);

		runtime.suspend();
	});
});
