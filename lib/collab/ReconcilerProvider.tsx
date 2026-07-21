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
 * automatically; the browser holds no database SDK and no second identity.
 */

"use client";

import { type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
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
import type { Mutation, Uuid } from "@/lib/doc/types";
import type { PersistableDoc } from "@/lib/domain";
import { invalidateCaseData } from "@/lib/preview/hooks/caseDataInvalidation";
import { buildUrl } from "@/lib/routing/location";
import { notifyPathChange } from "@/lib/routing/useClientPath";
import { BuilderSessionContext } from "@/lib/session/provider";
import { showToast } from "@/lib/ui/toastStore";

/** Backoff for the network/5xx retry loop: 1s, 2s, 4s, … capped at 30s. */
function retryDelayMs(attempt: number): number {
	return Math.min(30_000, 1_000 * 2 ** attempt);
}

/** After this many consecutive failed stream reopens, probe the app GET to
 *  distinguish a revocation from an outage (see the reopen listener). */
const REOPEN_PROBE_AFTER = 3;

/** Everything the provider builds once per mount and drives via effects. */
interface ReconcilerRuntime {
	readonly reconciler: Reconciler;
	/** The app id, mutable once (new-build activation). Deps read it here. */
	readonly appIdBox: { current: string | undefined };
	/** Effect setup: mark the runtime live and open the single EventSource at
	 *  the reconciler's confirmed cursor (a dormant new build opens nothing —
	 *  `activate` does, once the app id is minted). Re-entrant: React
	 *  StrictMode's dev-only setup→cleanup→setup replay runs this on the SAME
	 *  ref-cached runtime, so it must fully restore what `suspend` stopped. */
	start: () => void;
	/** New-build activation: stamp the minted app id, seed the reconciler, open
	 *  the stream at cursor 0. No-op if already active. */
	activate: (appId: string) => void;
	/** Effect cleanup: close the stream + cancel every pending timer and mark
	 *  the runtime inert so an async continuation (a resolving PUT/reload)
	 *  can't reopen a stream or schedule work after unmount. Deliberately does
	 *  NOT dispose the reconciler — the runtime is built once in a ref, and
	 *  StrictMode's replay re-runs `start` on it; a one-way dispose would leave
	 *  every dev session ignoring frames + discarding PUT outcomes forever. */
	suspend: () => void;
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
	init: { appId?: string; baseSeq: number; userId: string },
	/** Leaves preview mode — the conversion toast's "Review data" action
	 *  navigates to an edit-only surface, which preview would mask. */
	exitPreview: () => void,
): ReconcilerRuntime {
	const appIdBox: { current: string | undefined } = { current: init.appId };
	const presenceSubs = new Set<(roster: PresenceFrame) => void>();
	const retryTimers = new Set<ReturnType<typeof setTimeout>>();
	let eventSource: EventSource | null = null;
	/* True between the mount effect's `start` and its `suspend` cleanup. Gates
	 * every side-effect entry point (openStream, scheduleRetry, the reopen
	 * timer) so an async continuation resolving post-unmount can't open an
	 * untear-downable EventSource or schedule an orphan timer — while staying
	 * RE-ARMABLE for StrictMode's setup→cleanup→setup replay. */
	let active = false;
	/* Backoff attempt counter for the stream REOPEN path below — reset by a
	 * successful `open`, so an isolated failure retries at 1s while a sustained
	 * outage backs off to the 30s cap. */
	let streamRetryAttempt = 0;

	// Forward reference so the deps' `resubscribe` and the mount effect share
	// one `openStream`; assigned just below.
	let reconciler: Reconciler;

	/** Bump the shared case-data revision for every case type the (post-
	 *  apply) doc declares. Case rows are keyed per type; a commit can
	 *  migrate any type it touched, and over-invalidating an untouched
	 *  type costs one bounded re-SELECT per mounted representation. */
	function invalidateDocCaseTypes(): void {
		const id = appIdBox.current;
		if (!id) return;
		for (const caseType of docStore.getState().caseTypes ?? []) {
			invalidateCaseData(id, caseType.name);
		}
	}

	/** Whether a committed batch could have touched case data (run a
	 *  write-time migration, park, or restore). Everything except a
	 *  cosmetic-only `updateField` qualifies — label/hint edits are the
	 *  high-frequency typing stream and never change a property's
	 *  derived schema, while the structural kinds arrive at click
	 *  cadence where an occasional needless refetch is cheap. */
	function frameMayTouchCaseData(frame: MutationFrame): boolean {
		return frame.mutations.some((mutation) => {
			if (mutation.kind !== "updateField") return true;
			return Object.keys(mutation.patch ?? {}).some(
				(key) => key !== "label" && key !== "hint",
			);
		});
	}

	function openStream(cursor: number): void {
		const id = appIdBox.current;
		if (!id || !active) return;
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
				// Blueprint commits can change CASE DATA now (write-time
				// migrations park/restore/reshape rows), and the stream is the
				// one channel every commit path reaches this tab through —
				// its own autosave echo, its own chat run's echo, a same-user
				// MCP edit, and every teammate's commit. Bumping the shared
				// per-type revision here is what keeps the data-review surfaces
				// (and every other case-data representation) honest without a
				// per-path invalidation. Filtered so a peer's label-typing
				// stream doesn't refetch case data per keystroke-batch.
				if (frameMayTouchCaseData(frame)) invalidateDocCaseTypes();
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
		es.addEventListener("open", () => {
			streamRetryAttempt = 0;
		});
		es.addEventListener("error", () => {
			/* The browser's EventSource auto-reconnects (with `Last-Event-ID`) only
			 * on a TRANSPORT drop (readyState CONNECTING — leave it alone). An
			 * HTTP-error response — a 502/503 from the LB mid-deploy, a transient
			 * 500 — FAILS the connection permanently (readyState CLOSED) and the
			 * browser never retries it. Without this reopen the tab keeps PUT-ing
			 * fine but silently stops receiving peer frames — the exact divergence
			 * the stream exists to prevent. Reopen at the reconciler's confirmed
			 * cursor with backoff; the route's replay + gap check reconcile
			 * whatever was missed (a retention overrun reloads). After a few
			 * consecutive failures the timer body probes the app GET to tell a
			 * revocation (stop) from an outage (keep retrying) — see below. */
			if (es.readyState !== EventSource.CLOSED) return;
			if (es !== eventSource) return; // superseded by a newer stream
			if (!active || reconciler.getSnapshot().revoked) return;
			const timer = setTimeout(() => {
				retryTimers.delete(timer);
				const now = reconciler.getSnapshot();
				if (!active || now.revoked) return;
				/* A reload's `resubscribe` may have already replaced the failed
				 * stream while this timer was pending — don't churn a healthy one. */
				if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
					return;
				}
				/* SUSTAINED reopen failures are ambiguous: `EventSource` exposes no
				 * HTTP status, so a permanent 404 — access revoked while the stream
				 * was DOWN, which the cadence `revoked` event can't deliver and a
				 * VIEWER (who never PUTs) gets no 403 freeze for — looks identical to
				 * a long deploy outage. Probe the app GET once. ONLY the IDOR-safe
				 * 404 is terminal (a deterministic membership denial — the GET maps
				 * every access denial to it): a 401 is TRANSIENT by the package
				 * taxonomy (a lapsed/rotated session, or ANY swallowed auth-stack
				 * fault — `getSessionSafe` nulls them all), so revoking on it would
				 * irreversibly freeze every open tab over a seconds-long auth blip.
				 * Anything else (200, 401, 5xx, network) keeps the backoff alive.
				 * The response body (the whole blueprint) is cancelled unread —
				 * only the status matters, and buffering it per tick would multiply
				 * load on the exact backend that is struggling. */
				if (streamRetryAttempt >= REOPEN_PROBE_AFTER) {
					void fetch(`/api/apps/${appIdBox.current}`)
						.then((res) => {
							void res.body?.cancel();
							if (!active || reconciler.getSnapshot().revoked) return;
							/* Re-check for a healthy replacement stream — a reload's
							 * `resubscribe` may have landed while the probe was in
							 * flight; reopening would churn it. */
							if (
								eventSource &&
								eventSource.readyState !== EventSource.CLOSED
							) {
								return;
							}
							if (res.status === 404) {
								reconciler.onRevoked();
								return;
							}
							openStream(reconciler.getSnapshot().baseSeq);
						})
						.catch(() => {
							// Network down — keep the backoff loop alive.
							const snap = reconciler.getSnapshot();
							if (!active || snap.revoked) return;
							if (
								eventSource &&
								eventSource.readyState !== EventSource.CLOSED
							) {
								return;
							}
							openStream(snap.baseSeq);
						});
					return;
				}
				openStream(now.baseSeq);
			}, retryDelayMs(streamRetryAttempt));
			streamRetryAttempt += 1;
			retryTimers.add(timer);
		});
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
				migration?: {
					parked?: number;
					parkedCaseTypes?: string[];
					failureReasons?: string[];
				};
			};
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
			// A commit whose row migration SET VALUES ASIDE must be loud — the
			// values left the case rows into the review surface's store. A
			// fully-successful migration stays silent: the conversion did
			// exactly what was asked. (No invalidation here — this batch's
			// own stream echo runs the shared frame-layer invalidation, one
			// bump per commit for every path alike.)
			const parked = body.migration?.parked ?? 0;
			const parkedCaseTypes = body.migration?.parkedCaseTypes ?? [];
			if (parked > 0) {
				showToast(
					"warning",
					parked === 1 ? "1 value to review" : `${parked} values to review`,
					parked === 1
						? "It doesn't fit the property's new type, so Nova kept it for review."
						: "They don't fit the property's new type, so Nova kept them for review.",
					// The Review action only renders when the response NAMED the
					// affected case types (a version-skewed server that reports
					// `parked` without them gets the plain toast rather than a
					// button that cannot navigate).
					parkedCaseTypes.length === 0
						? undefined
						: {
								action: {
									label: "Review data",
									onPress: () => {
										// Resolve the destination at PRESS time from the live
										// doc — a module bound to the first affected case type
										// (the doc may have moved since the commit).
										const doc = docStore.getState();
										const moduleEntry = Object.entries(doc.modules).find(
											([, module]) =>
												module.caseType !== undefined &&
												parkedCaseTypes.includes(module.caseType),
										);
										if (moduleEntry === undefined) {
											// The bound module vanished (e.g. removed in the same
											// batch) — say so instead of consuming the press
											// silently. The values stay safe either way.
											showToast(
												"info",
												"No screen shows them right now",
												"No module uses that case type anymore. The values stay saved. Add a module for that case type, or ask Nova to add one, and you'll find them under Case data.",
											);
											return;
										}
										// The review screen is edit-only; in preview its URL
										// renders the running case list, so leave preview
										// before navigating.
										exitPreview();
										const url = buildUrl(`/build/${id}`, {
											kind: "data-review",
											moduleUuid: moduleEntry[0] as Uuid,
										});
										// The toast outlives the builder (ToastContainer is
										// app-wide), and pushState + notifyPathChange render
										// only while THIS app's builder is mounted to hear
										// them — pressed from anywhere else, the button must
										// be a real navigation, not a silent URL swap.
										if (window.location.pathname.startsWith(`/build/${id}`)) {
											window.history.pushState(null, "", url);
											notifyPathChange();
										} else {
											window.location.assign(url);
										}
									},
								},
							},
				);
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
		// A continuation resolving after the effect's cleanup must not schedule
		// an orphan timer into a suspended runtime (a leak the cleanup can no
		// longer clear). A no-op canceller keeps the reconciler's contract.
		if (!active) return () => {};
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
		resubscribe: (cursor) => {
			openStream(cursor);
			// A resubscribe follows a reload, which folded frames this tab
			// never saw individually — any of them could have migrated case
			// data, so refresh the per-type caches wholesale.
			invalidateDocCaseTypes();
		},
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

	function start(): void {
		active = true;
		// An existing app (or a replay of the mount effect after activation)
		// opens at the reconciler's confirmed cursor; a dormant new build waits
		// for `activate` to open at 0.
		if (appIdBox.current !== undefined) {
			openStream(reconciler.getSnapshot().baseSeq);
		}
		// Re-arm the reconciler's recovery machine — work that survived the
		// suspend window (an un-acked batch, a pending reload) gets its tick back.
		reconciler.resumeRecovery();
	}

	function suspend(): void {
		active = false;
		eventSource?.close();
		eventSource = null;
		for (const t of retryTimers) clearTimeout(t);
		retryTimers.clear();
		// The timers above back the reconciler's scheduled retry — clearing them
		// directly would leave its `cancelRetry` latch pointing at a dead timer,
		// wedging `scheduleRetryLoop`'s "already scheduled" early-return forever
		// after a StrictMode-replay `start`. Drop the latch with the timers.
		reconciler.suspendRecovery();
	}

	return {
		reconciler,
		appIdBox,
		start,
		activate,
		suspend,
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
		const sessionStore = sessionApi;
		runtimeRef.current = buildRuntime(
			docStore,
			{
				appId,
				baseSeq,
				userId,
			},
			() => sessionStore.getState().setPreviewing(false),
		);
	}

	// Open the stream on mount for an existing app; a dormant new build waits
	// for chat activation to open at 0. Suspend (close the stream + cancel
	// timers) on unmount. `start`/`suspend` are a re-entrant pair over the
	// ref-cached runtime: React StrictMode's dev-only setup→cleanup→setup
	// replay must land back on a WORKING runtime — a one-way dispose here left
	// every dev session with a reconciler that ignored frames and discarded
	// PUT outcomes (multiplayer + save-status dead in dev only). `start` reads
	// the live app id + confirmed cursor off the runtime itself, so the effect
	// has no reactive inputs; an app change remounts the whole provider
	// (BuilderProvider's `key={buildId}`).
	useEffect(() => {
		const runtime = runtimeRef.current;
		if (!runtime) return;
		runtime.start();
		return () => runtime.suspend();
	}, []);

	const runtime = runtimeRef.current;

	// One stable context value per runtime — an inline object would mint a new
	// identity every provider render and re-render every consumer of the
	// context (each PeerBadge, the auto-save hook) for nothing.
	const contextValue = useMemo(
		() =>
			runtime
				? {
						reconciler: runtime.reconciler,
						activate: runtime.activate,
						subscribePresence: (cb: (roster: PresenceFrame) => void) => {
							runtime.presenceSubs.add(cb);
							return () => runtime.presenceSubs.delete(cb);
						},
					}
				: null,
		[runtime],
	);

	if (!contextValue) return <>{children}</>;

	return (
		<ReconcilerContext.Provider value={contextValue}>
			{children}
		</ReconcilerContext.Provider>
	);
}
