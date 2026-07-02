/**
 * ReconcilerProvider — owns the single session-scoped reconciler AND the
 * single `EventSource` onto the app's durable mutation + presence stream.
 *
 * Mounted inside the builder provider stack (below `BlueprintDocProvider` +
 * `BuilderSessionProvider`, so it reads both stores). It:
 *   - creates the reconciler once per mount (`createReconciler`), wiring the
 *     real PUT / reload-GET / resubscribe / retry side effects as deps;
 *   - opens ONE `EventSource` to `/api/apps/{appId}/stream?since=<baseSeq>` and
 *     routes `mutation` / `reload` / `revoked` frames into the reconciler and
 *     `presence` frames to `subscribePresence` subscribers;
 *   - re-opens the stream at the reload cursor when the reconciler reloads;
 *   - exposes the reconciler + `subscribePresence` via `ReconcilerContext`.
 *
 * A brand-new build mounts DORMANT (no `appId`): no stream opens and human
 * PUTs are disabled until `data-app-id` activates the reconciler (via
 * `activateReconciler`, from the chat wiring), which then opens the stream at
 * cursor 0.
 *
 * Auth rides the session cookie — same-origin `EventSource` + `fetch` carry it
 * automatically; the browser holds no Firestore SDK and no second identity.
 */

"use client";

import { type ReactNode, useContext, useEffect, useRef } from "react";
import { reportClientError } from "@/lib/clientErrorReporter";
import { ReconcilerContext } from "@/lib/collab/context";
import type { PresenceFrame } from "@/lib/collab/presenceTypes";
import {
	createReconciler,
	type MutationFrame,
	type PutOutcome,
	type Reconciler,
	type ReconcilerDeps,
} from "@/lib/collab/reconciler";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import type { PersistableDoc } from "@/lib/domain";
import { BuilderSessionContext } from "@/lib/session/provider";
import type { BuilderSessionStoreApi } from "@/lib/session/store";

/** Backoff for the network/5xx retry loop: 1s, 2s, 4s, … capped at 30s. */
function retryDelayMs(attempt: number): number {
	return Math.min(30_000, 1_000 * 2 ** attempt);
}

/** Everything the provider builds once per mount and drives via effects. */
interface ReconcilerRuntime {
	readonly reconciler: Reconciler;
	/** The app id, mutable once (new-build activation). Deps read it here. */
	readonly appIdBox: { current: string | undefined };
	/** Open (or re-open) the single EventSource at `cursor`. */
	openStream: (cursor: number) => void;
	/** New-build activation: stamp the minted app id, seed the reconciler, open
	 *  the stream at cursor 0. No-op if already active. */
	activate: (appId: string) => void;
	/** Close the stream + cancel all retry timers + dispose the reconciler. */
	teardown: () => void;
	readonly presenceSubs: Set<(roster: PresenceFrame) => void>;
}

export interface ReconcilerProviderProps {
	/** The app id, or `undefined` for a brand-new build (dormant reconciler). */
	appId?: string;
	/** The head seq at mount (`app.mutation_seq`); 0 for a fresh app. */
	baseSeq: number;
	/** The session user id — echo classification keys on it. */
	userId: string;
	children: ReactNode;
}

/** Build the reconciler and its network wiring once. Pure of React — the
 *  provider calls it lazily from a `useRef` initializer. */
function buildRuntime(
	docStore: BlueprintDocStoreApi,
	sessionApi: BuilderSessionStoreApi,
	init: { appId?: string; baseSeq: number; userId: string },
): ReconcilerRuntime {
	const appIdBox: { current: string | undefined } = { current: init.appId };
	const presenceSubs = new Set<(roster: PresenceFrame) => void>();
	const retryTimers = new Set<ReturnType<typeof setTimeout>>();
	let eventSource: EventSource | null = null;

	// Forward reference so the deps' `resubscribe` and the mount effect share
	// one `openStream`; assigned just below.
	let reconciler: Reconciler;

	function openStream(cursor: number): void {
		const id = appIdBox.current;
		if (!id) return;
		// `EventSource` is a browser global; guard its presence so a non-browser
		// render (SSR, a jsdom/happy-dom test that mounts the builder tree) mounts
		// the reconciler for its state machine without a live stream — the PUT path
		// still works, only inbound frames are absent.
		if (typeof EventSource === "undefined") return;
		eventSource?.close();
		const es = new EventSource(`/api/apps/${id}/stream?since=${cursor}`);
		eventSource = es;
		es.addEventListener("mutation", (ev) => {
			try {
				const frame = JSON.parse((ev as MessageEvent).data) as MutationFrame;
				reconciler.onFrame(frame);
			} catch (err) {
				reportClientError({
					message: `Reconciler: malformed mutation frame — ${
						err instanceof Error ? err.message : String(err)
					}`,
					source: "manual",
					url: window.location.href,
				});
			}
		});
		es.addEventListener("reload", () => reconciler.onReloadEvent());
		es.addEventListener("revoked", () => {
			reconciler.onRevoked();
			es.close();
		});
		es.addEventListener("presence", (ev) => {
			try {
				const roster = JSON.parse((ev as MessageEvent).data) as PresenceFrame;
				for (const cb of presenceSubs) cb(roster);
			} catch {
				/* a malformed presence frame is best-effort — skip it. */
			}
		});
		// The browser's EventSource auto-reconnects (with `Last-Event-ID`) on a
		// transport drop; no `onerror` handler is needed beyond that default.
	}

	const put = async (
		batchId: string,
		mutations: Mutation[],
	): Promise<PutOutcome> => {
		const id = appIdBox.current;
		if (!id) return { ok: false, kind: "network" };
		const res = await fetch(`/api/apps/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mutations, batchId }),
		});
		if (res.ok) {
			const body = (await res.json().catch(() => ({}))) as {
				seq?: number;
				basisToken?: string;
			};
			if (typeof body.basisToken === "string") {
				sessionApi.getState().setSaveBasis(body.basisToken);
			}
			// The route ALWAYS returns a real committed seq on a 200. A 200 with no
			// parseable seq is anomalous — NEVER fabricate `init.baseSeq` (once
			// `baseSeq` has advanced, a fabricated mount-time seq is `<= baseSeq` and
			// would wrongly trip the false-network drop on a genuinely-fresh accepted
			// batch, mis-classifying its real echo as remote → double-apply). Treat a
			// seq-less 200 as a transient failure so the batch retries and re-derives
			// a real seq via `batchDedup`.
			if (typeof body.seq !== "number") {
				return { ok: false, kind: "network", detail: "200 without seq" };
			}
			return { ok: true, seq: body.seq };
		}
		if (res.status === 409) return { ok: false, kind: "conflict" };
		if (res.status === 403) return { ok: false, kind: "reauth" };
		if (res.status === 404) return { ok: false, kind: "notFound" };
		// Fine-grained 4xx taxonomy — the terminal-freeze `permanent` is narrowed
		// to ONLY a 400 "Invalid mutations" (the genuine client↔server commit-gate
		// DISAGREEMENT the freeze was designed for). The other 4xx are recoverable
		// and must NOT discard the user's unsaved edits:
		//   - 401 (session lapsed/rotated) → transient: KEEP the batch and retry; a
		//     cookie refresh / re-login makes the retry succeed. Freezing + dropping
		//     a user's work because their session lapsed would be data loss.
		//   - 413 (accumulated delta > the request cap) → `tooLarge`: retrying the
		//     same body won't shrink it, so STOP the retry loop (no 413-storm) and
		//     surface it, but KEEP the edits (a reload is the user's choice).
		//   - any OTHER 4xx → transient (retry), never discard.
		//   - 5xx → transient (retry).
		const detail = `HTTP ${res.status}`;
		if (res.status === 400) return { ok: false, kind: "permanent", detail };
		if (res.status === 413) return { ok: false, kind: "tooLarge", detail };
		return { ok: false, kind: "network", detail };
	};

	const reload = async () => {
		const id = appIdBox.current;
		if (!id) throw new Error("reconciler reload with no appId");
		const res = await fetch(`/api/apps/${id}`);
		if (!res.ok) throw new Error(`reload failed: HTTP ${res.status}`);
		const data = (await res.json()) as {
			blueprint: PersistableDoc;
			mutation_seq: number;
		};
		return { blueprint: data.blueprint, seq: data.mutation_seq };
	};

	const scheduleRetry = (attempt: number, run: () => void): (() => void) => {
		const timer = setTimeout(() => {
			retryTimers.delete(timer);
			run();
		}, retryDelayMs(attempt));
		retryTimers.add(timer);
		return () => {
			clearTimeout(timer);
			retryTimers.delete(timer);
		};
	};

	const deps: ReconcilerDeps = {
		put,
		reload,
		resubscribe: (cursor) => openStream(cursor),
		scheduleRetry,
		onReauthDenied: () => {
			// The SINGLE 403 Sentry report: `useAutoSave` reports only for a 404
			// (its "not writable" warning), so this owns the 403 report and a
			// revocation isn't double-counted.
			reportClientError({
				message: `Reconciler: edit access denied (403) for app ${appIdBox.current}`,
				source: "manual",
				url: window.location.href,
			});
		},
		onSaveError: (detail) => {
			// A persistent 5xx / network PUT failure or a reload-GET failure — an
			// app-wide save-path outage that would otherwise be invisible to Sentry.
			// The dedup message is keyed on the app id ALONE (no `detail`), so a
			// retry storm whose messages vary ("Failed to fetch" vs "NetworkError…"
			// vs "HTTP 503") stays ONE Sentry issue per app per page-load; the
			// varying `detail` rides `stack` (captured as context, not fingerprinted).
			reportClientError({
				message: `Reconciler save-path failure (app ${appIdBox.current})`,
				stack: detail,
				source: "manual",
				url: window.location.href,
			});
		},
	};

	reconciler = createReconciler(
		docStore,
		sessionApi,
		{
			appId: init.appId,
			baseSeq: init.baseSeq,
			baseDoc: docStore.getState(),
			userId: init.userId,
		},
		deps,
	);

	function activate(newAppId: string): void {
		if (appIdBox.current !== undefined) return; // already active
		appIdBox.current = newAppId;
		reconciler.activate({ appId: newAppId, baseDoc: docStore.getState() });
		openStream(0);
	}

	function teardown(): void {
		eventSource?.close();
		eventSource = null;
		for (const t of retryTimers) clearTimeout(t);
		retryTimers.clear();
		reconciler.dispose();
	}

	return {
		reconciler,
		appIdBox,
		openStream,
		activate,
		teardown,
		presenceSubs,
	};
}

export function ReconcilerProvider({
	appId,
	baseSeq,
	userId,
	children,
}: ReconcilerProviderProps) {
	const docStore = useContext(BlueprintDocContext);
	const sessionApi = useContext(BuilderSessionContext);

	const runtimeRef = useRef<ReconcilerRuntime | null>(null);
	if (runtimeRef.current === null && docStore && sessionApi) {
		runtimeRef.current = buildRuntime(docStore, sessionApi, {
			appId,
			baseSeq,
			userId,
		});
	}

	// Open the stream on mount for an existing app; a dormant new build waits
	// for chat activation to open at 0. Tear everything down on unmount. The
	// provider remounts (BuilderProvider's `key={buildId}`) on an app change, so
	// `appId`/`baseSeq` are effectively mount-time constants — listing them keeps
	// the deps exhaustive without re-running the mount-once wiring in practice.
	useEffect(() => {
		const runtime = runtimeRef.current;
		if (!runtime) return;
		if (appId !== undefined) runtime.openStream(baseSeq);
		return () => runtime.teardown();
	}, [appId, baseSeq]);

	const runtime = runtimeRef.current;
	if (!runtime) return <>{children}</>;

	return (
		<ReconcilerContext.Provider
			value={{
				reconciler: runtime.reconciler,
				activate: runtime.activate,
				subscribePresence: (cb) => {
					runtime.presenceSubs.add(cb);
					return () => runtime.presenceSubs.delete(cb);
				},
			}}
		>
			{children}
		</ReconcilerContext.Provider>
	);
}
