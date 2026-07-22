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

type FakeListener = (event: { data?: string }) => void;

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

	emit(type: string, data?: string): void {
		for (const listener of this.listeners.get(type) ?? []) listener({ data });
	}
}

afterEach(() => {
	FakeEventSource.instances.length = 0;
	window.sessionStorage.clear();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("ReconcilerProvider EventSource ownership", () => {
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
		expect(sourceStream.url).toBe(
			"/api/apps/app-1/stream?since=0&receiverVersion=1",
		);
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
		window.sessionStorage.setItem("nova:stream-upgrade:app-1:receiver-1", "1");
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
