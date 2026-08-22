/**
 * ReconcilerProvider — owns the single session-scoped reconciler AND the
 * single `EventSource` onto the app's durable mutation, presence, and lookup
 * invalidation stream.
 *
 * Mounted inside the builder provider stack (below `BlueprintDocProvider` +
 * `BuilderSessionProvider`, so it reads both stores). It:
 *   - creates the reconciler once per mount (`createReconciler`), wiring the
 *     real PUT / reload-GET / resubscribe / retry side effects as deps;
 *   - opens ONE `EventSource` to
 *     `/api/apps/{appId}/stream?since=<baseSeq>&receiverVersion=<manifest>` and
 *     routes `mutation` / `reload` / `revoked` frames into the reconciler and
 *     `presence` frames to `subscribePresence` subscribers and seq-less full
 *     lookup manifests to `subscribeLookupManifest` subscribers;
 *   - re-opens the stream at the reload cursor when the reconciler reloads;
 *   - exposes the reconciler + both subscriptions via `ReconcilerContext`.
 *
 * A brand-new build mounts DORMANT (no `appId`): no stream opens and human
 * PUTs are disabled until `data-app-materialized` activates the reconciler (via
 * the chat wiring), which then opens the stream at the receipt's authoritative
 * cursor.
 *
 * Auth rides the session cookie — same-origin `EventSource` + `fetch` carry it
 * automatically; the browser holds no database SDK and no second identity.
 */

"use client";

import { type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import { z } from "zod";
import { clientErrorUtf8Bytes } from "@/lib/clientErrorContract";
import { reportClientError } from "@/lib/clientErrorReporter";
import { parseAppReadSnapshot } from "@/lib/collab/appReadSnapshot";
import { parseAppStatusFrame } from "@/lib/collab/appStatusFrame";
import { ReconcilerContext } from "@/lib/collab/context";
import {
	createLookupManifestBroker,
	type LookupManifestBroker,
	lookupManifestFrameSchema,
} from "@/lib/collab/lookupManifestFrame";
import {
	diagnoseMutationFrameText,
	type MutationFrame,
} from "@/lib/collab/mutationFrame";
import {
	type PresenceFrame,
	parsePresenceFrame,
	presenceFrameSchema,
} from "@/lib/collab/presenceTypes";
import { parsePreviewProjectSpaceFrame } from "@/lib/collab/previewProjectSpaceFrame";
import {
	createProjectScopeResetRegistry,
	type ProjectScopeResetRegistry,
} from "@/lib/collab/projectScopeReset";
import {
	createReconciler,
	type PutOutcome,
	type Reconciler,
	type ReconcilerDeps,
	type ReconcilerObservedFailure,
	ReconcilerReloadError,
} from "@/lib/collab/reconciler";
import { parseRevocationFrame } from "@/lib/collab/revocationFrame";
import {
	type AdmittedMutationBatch,
	encodeAdmittedMutationEnvelope,
	isMutationWireCanonicalityReason,
} from "@/lib/doc/mutationAdmission";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import { uuidSchema } from "@/lib/domain";
import { getLookupManifestAction } from "@/lib/lookup/actions";
import type { LookupManifest } from "@/lib/lookup/types";
import { invalidateCaseData } from "@/lib/preview/hooks/caseDataInvalidation";
import { buildUrl } from "@/lib/routing/location";
import {
	activateBuilderHistoryScope,
	deactivateBuilderHistoryScope,
	pushBuilderHistory,
} from "@/lib/routing/useClientPath";
import {
	BuilderSessionContext,
	type BuilderSessionStoreApi,
} from "@/lib/session/provider";
import { showProjectToast, toastStore } from "@/lib/ui/toastStore";

let nextProjectScopeId = 0;

/** Backoff for the network/5xx retry loop: 1s, 2s, 4s, … capped at 30s. */
function retryDelayMs(attempt: number): number {
	return Math.min(30_000, 1_000 * 2 ** attempt);
}

/** After this many consecutive failed stream reopens, probe the app GET to
 *  distinguish a revocation from an outage (see the reopen listener). */
const REOPEN_PROBE_AFTER = 3;

/** Zod messages can embed values; observability gets only issue code + path. */
function safeZodIssues(error: unknown): readonly string[] | undefined {
	if (!(error instanceof z.ZodError)) return undefined;
	return error.issues.slice(0, 5).map((issue) => {
		const pointer = issue.path
			.map((segment) =>
				String(segment).replaceAll("~", "~0").replaceAll("/", "~1"),
			)
			.join("/");
		return `${issue.code}:/${pointer}`;
	});
}

function observedFailureMessage(failure: ReconcilerObservedFailure): string {
	if (failure.operation === "reload-get") {
		return failure.failureKind === "invalid-json" ||
			failure.failureKind === "snapshot-schema"
			? "Reconciler recovery snapshot rejected"
			: "Reconciler reload request failed";
	}
	if (
		failure.failureKind === "canonicality" ||
		failure.failureKind === "batch-collision"
	) {
		return "Reconciler autosave protocol rejected";
	}
	if (failure.failureKind === "too-large") {
		return "Reconciler autosave request too large";
	}
	return "Reconciler autosave request failed";
}

/** Everything the provider builds once per mount and drives via effects. */
export interface ReconcilerRuntime {
	readonly reconciler: Reconciler;
	readonly projectScopeId: string;
	/** The app id, mutable once (new-build activation). Deps read it here. */
	readonly appIdBox: { current: string | undefined };
	/** Effect setup: mark the runtime live and open the single EventSource at
	 *  the reconciler's confirmed cursor (a dormant new build opens nothing —
	 *  `activate` does, once the app id is minted). Re-entrant: React
	 *  StrictMode's dev-only setup→cleanup→setup replay runs this on the SAME
	 *  ref-cached runtime, so it must fully restore what `suspend` stopped. */
	start: () => void;
	/** New-build activation: stamp the minted app id, seed the reconciler, open
	 *  the stream at the server-provided cursor. No-op if already active. */
	activate: (appId: string, baseSeq: number) => void;
	/** Effect cleanup: close the stream + cancel every pending timer and mark
	 *  the runtime inert so an async continuation (a resolving PUT/reload)
	 *  can't reopen a stream or schedule work after unmount. Deliberately does
	 *  NOT dispose the reconciler — the runtime is built once in a ref, and
	 *  StrictMode's replay re-runs `start` on it; a one-way dispose would leave
	 *  every dev session ignoring frames + discarding PUT outcomes forever. */
	suspend: () => void;
	readonly presenceSubs: Set<(roster: PresenceFrame) => void>;
	readonly organizationSubs: Set<() => void>;
	/** Subscribe to server-resolved preview-project-space announcements. The
	 *  retained latest value replays immediately, so mount order never loses
	 *  the connect-time frame; frames are authoritative whole values, so
	 *  there is no ordering to reconcile. */
	readonly subscribePreviewProjectSpace: (
		cb: (projectSpace: string | null) => void,
	) => () => void;
	readonly lookupManifestBroker: LookupManifestBroker;
	readonly projectScopeResetRegistry: ProjectScopeResetRegistry;
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
export function createReconcilerRuntime(
	docStore: BlueprintDocStoreApi,
	sessionStore: BuilderSessionStoreApi,
	init: { appId?: string; baseSeq: number; userId: string },
	/** Leaves preview mode — the conversion toast's "Review data" action
	 *  navigates to an edit-only surface, which preview would mask. */
	exitPreview: () => void,
): ReconcilerRuntime {
	const appIdBox: { current: string | undefined } = { current: init.appId };
	const projectScopeId = `builder-project-scope-${++nextProjectScopeId}`;
	const presenceSubs = new Set<(roster: PresenceFrame) => void>();
	const organizationSubs = new Set<() => void>();
	const previewProjectSpaceSubs = new Set<(space: string | null) => void>();
	/** `undefined` until the first frame: a subscriber keeps its
	 *  server-rendered seed until the stream has said anything. */
	let previewProjectSpaceLatest: string | null | undefined;
	function subscribePreviewProjectSpace(
		cb: (projectSpace: string | null) => void,
	): () => void {
		previewProjectSpaceSubs.add(cb);
		if (previewProjectSpaceLatest !== undefined) cb(previewProjectSpaceLatest);
		return () => previewProjectSpaceSubs.delete(cb);
	}
	function publishPreviewProjectSpace(projectSpace: string | null): void {
		previewProjectSpaceLatest = projectSpace;
		for (const cb of [...previewProjectSpaceSubs]) cb(projectSpace);
	}
	const lookupManifestBroker = createLookupManifestBroker();
	const projectScopeResetRegistry = createProjectScopeResetRegistry();
	let presenceMayBeRetained = false;

	/** Clear data whose authorization follows the app's current Project. Lookup
	 * subscribers receive the broker's explicit loading sentinel; presence has no
	 * retained broker, so push an empty roster directly to mounted consumers. */
	function clearPresenceState(force = false): void {
		if (!presenceMayBeRetained && !force) return;
		presenceMayBeRetained = false;
		const failures: unknown[] = [];
		for (const subscriber of [...presenceSubs]) {
			try {
				subscriber([]);
			} catch (error) {
				/* Notify every roster consumer, then let the outer tenant-boundary
				 * registry fail closed if even one could have retained source data. */
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, "Presence state failed to clear");
		}
	}
	/* Session-owned uncertain-scope data clears first: abort media transfers and
	 * drop media/run payloads before any external cache subscriber can react.
	 * Preview case/persona/form state remains until the GET confirms whether
	 * this was a same-Project refresh or a real tenant boundary. */
	projectScopeResetRegistry.subscribe(() =>
		sessionStore.getState().resetProjectScope(),
	);
	projectScopeResetRegistry.subscribe((scopeEpoch) =>
		toastStore.activateProjectScope({
			scopeId: projectScopeId,
			epoch: scopeEpoch,
		}),
	);
	projectScopeResetRegistry.subscribe((scopeEpoch) =>
		activateBuilderHistoryScope(projectScopeId, appIdBox.current, scopeEpoch),
	);
	projectScopeResetRegistry.subscribe(() => lookupManifestBroker.reset());
	projectScopeResetRegistry.subscribe(() => clearPresenceState());
	const retryTimers = new Set<ReturnType<typeof setTimeout>>();
	let presenceRecoveryGeneration = 0;
	let lookupRecoveryGeneration = 0;
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
	let pendingReloadRecovery:
		| {
				readonly trigger: "malformed-mutation-frame";
				readonly eventId?: string;
		  }
		| undefined;

	/** Atomically disown before closing so callbacks queued by the old source
	 *  fail their ownership guard. */
	function closeOwnedStream(): void {
		const previousStream = eventSource;
		eventSource = null;
		previousStream?.close();
	}

	function cancelCurrentFrameRecoveries(): void {
		presenceRecoveryGeneration += 1;
		lookupRecoveryGeneration += 1;
	}

	/** Start (or coalesce) one Project/access boundary. Editing pauses in the
	 *  same Zustand write that advances the epoch; all registered tenant caches
	 *  clear synchronously before the GET. A reset failure is reported and
	 *  returned to the reconciler, which enters its fail-closed revoked state. */
	function beginAccessRefresh(): boolean {
		cancelCurrentFrameRecoveries();
		closeOwnedStream();
		const scopeEpoch = sessionStore.getState().beginAccessRefresh();
		try {
			projectScopeResetRegistry.reset(scopeEpoch);
			return true;
		} catch (error) {
			reportClientError({
				message: `Project-scope cache reset failed (app ${appIdBox.current})`,
				stack:
					error instanceof Error
						? (error.stack ?? error.message)
						: String(error),
				source: "manual",
				url: typeof window === "undefined" ? "" : window.location.href,
			});
			return false;
		}
	}

	function confirmViewRevoked(): void {
		beginAccessRefresh();
		sessionStore.getState().revokeAccess();
	}

	// Forward reference so the deps' `resubscribe` and the mount effect share
	// one `openStream`; assigned just below.
	let reconciler: Reconciler;

	function reportCurrentFrameFailure(message: string, error?: unknown): void {
		reportClientError({
			message,
			...(error === undefined
				? {}
				: {
						stack:
							error instanceof Error
								? (error.stack ?? error.message)
								: String(error),
					}),
			source: "manual",
			url: typeof window === "undefined" ? "" : window.location.href,
		});
	}

	function failClosedAfterCurrentFrameReset(error: unknown): void {
		reportCurrentFrameFailure(
			`Current-frame state reset failed (app ${appIdBox.current})`,
			error,
		);
		closeOwnedStream();
		reconciler.onRevoked();
	}

	function scheduleCurrentFrameRetry(attempt: number, run: () => void): void {
		if (!active) return;
		const timer = setTimeout(() => {
			retryTimers.delete(timer);
			run();
		}, retryDelayMs(attempt));
		retryTimers.add(timer);
	}

	function startPresenceRecovery(): void {
		reportCurrentFrameFailure("Reconciler: malformed presence frame");
		const generation = ++presenceRecoveryGeneration;
		const scopeEpoch = sessionStore.getState().scopeEpoch;
		try {
			clearPresenceState(true);
		} catch (error) {
			failClosedAfterCurrentFrameReset(error);
			return;
		}

		const run = (attempt: number): void => {
			const id = appIdBox.current;
			if (
				!active ||
				!id ||
				generation !== presenceRecoveryGeneration ||
				scopeEpoch !== sessionStore.getState().scopeEpoch
			)
				return;
			void fetch(`/api/apps/${id}/presence`, { cache: "no-store" })
				.then(async (response) => {
					if (response.status === 404) {
						cancelCurrentFrameRecoveries();
						reconciler.onReloadEvent();
						return;
					}
					if (!response.ok) {
						throw new Error(`presence refetch failed: HTTP ${response.status}`);
					}
					const roster = presenceFrameSchema.parse(await response.json());
					if (
						!active ||
						generation !== presenceRecoveryGeneration ||
						scopeEpoch !== sessionStore.getState().scopeEpoch
					)
						return;
					presenceMayBeRetained = roster.length > 0;
					for (const subscriber of [...presenceSubs]) subscriber(roster);
				})
				.catch((error) => {
					if (
						!active ||
						generation !== presenceRecoveryGeneration ||
						scopeEpoch !== sessionStore.getState().scopeEpoch
					)
						return;
					reportCurrentFrameFailure(
						`Presence refetch failed (app ${id})`,
						error,
					);
					scheduleCurrentFrameRetry(attempt + 1, () => run(attempt + 1));
				});
		};
		run(0);
	}

	function startLookupManifestRecovery(): void {
		reportCurrentFrameFailure("Reconciler: malformed lookup manifest frame");
		const generation = ++lookupRecoveryGeneration;
		const { projectId, scopeEpoch } = sessionStore.getState();
		try {
			lookupManifestBroker.reset();
		} catch (error) {
			failClosedAfterCurrentFrameReset(error);
			return;
		}
		if (!projectId) {
			reconciler.onReloadEvent();
			return;
		}

		const run = (attempt: number): void => {
			if (
				!active ||
				generation !== lookupRecoveryGeneration ||
				scopeEpoch !== sessionStore.getState().scopeEpoch
			)
				return;
			void getLookupManifestAction(projectId)
				.then((result) => {
					if (
						!active ||
						generation !== lookupRecoveryGeneration ||
						scopeEpoch !== sessionStore.getState().scopeEpoch
					)
						return;
					if (!result.success) {
						if (result.code === "not_found") {
							cancelCurrentFrameRecoveries();
							reconciler.onReloadEvent();
							return;
						}
						throw new Error(`lookup manifest refetch failed: ${result.code}`);
					}
					const manifest = lookupManifestFrameSchema.parse(result.value);
					if (
						manifest.projectId !== projectId ||
						!lookupManifestBroker.install(manifest)
					) {
						throw new Error("lookup manifest refetch changed Project lineage");
					}
				})
				.catch((error) => {
					if (
						!active ||
						generation !== lookupRecoveryGeneration ||
						scopeEpoch !== sessionStore.getState().scopeEpoch
					)
						return;
					reportCurrentFrameFailure(
						`Lookup manifest refetch failed (app ${appIdBox.current})`,
						error,
					);
					scheduleCurrentFrameRetry(attempt + 1, () => run(attempt + 1));
				});
		};
		run(0);
	}

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
		closeOwnedStream();
		const query = new URLSearchParams({
			since: String(cursor),
		});
		const es = new EventSource(`/api/apps/${id}/stream?${query}`);
		eventSource = es;

		function reloadAfterProtocolFailure(
			recovery?: typeof pendingReloadRecovery,
		): void {
			/* Disown the malformed source before the serialized authoritative GET.
			 * The reconciler has not seen the frame, so its cursor remains at the
			 * last canonical frame and the reload cannot skip the bad suffix. */
			pendingReloadRecovery = recovery;
			closeOwnedStream();
			reconciler.onReloadEvent();
		}

		es.addEventListener("mutation", (ev) => {
			if (es !== eventSource) return;
			const event = ev as MessageEvent<string>;
			const result = diagnoseMutationFrameText(event.data);
			if (!result.ok) {
				const failure = result.failure;
				const originalError = "error" in failure ? failure.error : undefined;
				const eventId = event.lastEventId || undefined;
				reportClientError(
					{
						message: "Reconciler protocol mismatch: mutation frame rejected",
						stack:
							originalError instanceof Error ? originalError.stack : undefined,
						source: "manual",
						url: window.location.href,
						diagnostics: {
							component: "reconciler",
							operation: "mutation-frame",
							failureKind: failure.stage,
							appId: id,
							baseSeq: reconciler.getSnapshot().baseSeq,
							eventId,
							payloadBytes: clientErrorUtf8Bytes(event.data),
							reason: failure.reason,
							...(failure.stage === "envelope"
								? { issues: failure.issues }
								: {}),
							...(failure.stage === "mutation-admission"
								? {
										mutationIndex: failure.mutationIndex,
										pointer: failure.pointer,
									}
								: {}),
						},
					},
					originalError,
				);
				reloadAfterProtocolFailure({
					trigger: "malformed-mutation-frame",
					...(eventId === undefined ? {} : { eventId }),
				});
				return;
			}
			const frame = result.frame;
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
		});
		es.addEventListener("protocol-failure", () => {
			if (es !== eventSource) return;
			reloadAfterProtocolFailure();
		});
		es.addEventListener("reload", () => {
			if (es !== eventSource) return;
			/* `requestReload` synchronously disowns this source, pauses editing, and
			 * resets Project state before starting its serialized GET. */
			pendingReloadRecovery = undefined;
			reconciler.onReloadEvent();
		});
		es.addEventListener("revoked", (ev) => {
			if (es !== eventSource) return;
			const frame = parseRevocationFrame((ev as MessageEvent).data);
			if (frame === null) {
				/* An unparseable control frame is not proof of revocation. Disown
				 * its source, clear authorization-bound state, and serialize one
				 * authoritative reauthorization/reload from the unchanged cursor. */
				reportClientError({
					message: "Reconciler: malformed revocation frame",
					source: "manual",
					url: window.location.href,
				});
				reloadAfterProtocolFailure();
				return;
			}
			closeOwnedStream();
			if (frame.reason === "client-upgrade-required") {
				/* Mask + clear tenant state before navigation. If this is the second
				 * rejection for the compiled receiver, stop looping and render the
				 * explicit refresh-required state. */
				if (!beginAccessRefresh()) {
					reconciler.onRevoked();
					return;
				}
				reconciler.onClientUpgradeRequired();
				return;
			}
			reconciler.onRevoked();
		});
		es.addEventListener("presence", (ev) => {
			if (es !== eventSource) return;
			const roster = parsePresenceFrame((ev as MessageEvent).data);
			if (roster === null) {
				startPresenceRecovery();
				return;
			}
			presenceRecoveryGeneration += 1;
			presenceMayBeRetained = roster.length > 0;
			for (const cb of [...presenceSubs]) cb(roster);
		});
		es.addEventListener("organization-revision", () => {
			if (es !== eventSource) return;
			for (const cb of [...organizationSubs]) cb();
		});
		es.addEventListener("app-status", (ev) => {
			if (es !== eventSource) return;
			const frame = parseAppStatusFrame((ev as MessageEvent).data);
			if (frame === null) return; // malformed: leave the latch alone
			/* Route the server's run-lifecycle read into the session store's
			 * `buildUnfinished` latch — the release path for tabs that never see
			 * the run's own chat stream (a second tab, a co-member watching a
			 * teammate's build). Only `complete` is edit-shaped, exactly the
			 * server's charge/claim rule: `generating` and `error` (an
			 * interrupted build awaiting re-drive) both keep sends priced and
			 * captured as builds. The own-stream releases (`data-done` /
			 * `data-build-complete`) stay: they land instantly while this frame
			 * rides the completion notify or the reauth cadence. Frames are
			 * seq-less, so ordering against the own-stream release is the
			 * STORE's job: after an observed completion `markBuildUnfinished`
			 * no-ops, which is what stops a `generating` frame read
			 * milliseconds before the completing run committed from re-arming a
			 * latch this tab already released. */
			if (frame.status === "complete") {
				sessionStore.getState().markBuildFinished();
			} else {
				sessionStore.getState().markBuildUnfinished();
			}
		});
		es.addEventListener("preview-project-space", (ev) => {
			if (es !== eventSource) return;
			const frame = parsePreviewProjectSpaceFrame((ev as MessageEvent).data);
			if (frame === null) return; // malformed: leave the retained value alone
			/* Frames carry the server's whole current answer, so the latest one
			 * simply wins; there is no cursor and no ordering to reconcile. */
			publishPreviewProjectSpace(frame.projectSpace);
		});
		es.addEventListener("lookup-revision", (ev) => {
			if (es !== eventSource) return;
			if (!lookupManifestBroker.dispatch((ev as MessageEvent).data)) {
				startLookupManifestRecovery();
				return;
			}
			lookupRecoveryGeneration += 1;
		});
		es.addEventListener("open", () => {
			if (es !== eventSource) return;
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
				if (es !== eventSource) return;
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
					void fetch(`/api/apps/${appIdBox.current}`, { cache: "no-store" })
						.then((res) => {
							void res.body?.cancel();
							if (es !== eventSource) return;
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
								closeOwnedStream();
								reconciler.onRevoked();
								return;
							}
							openStream(reconciler.getSnapshot().baseSeq);
						})
						.catch(() => {
							if (es !== eventSource) return;
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
		mutations: AdmittedMutationBatch,
	): Promise<PutOutcome> => {
		const id = appIdBox.current;
		if (!id) return { ok: false, kind: "network" };
		const projectToastScope = {
			scopeId: projectScopeId,
			epoch: sessionStore.getState().scopeEpoch,
		};
		const requestBody = encodeAdmittedMutationEnvelope({
			mutations,
			batchId,
		});
		const res = await fetch(`/api/apps/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: requestBody.json,
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
				showProjectToast(
					projectToastScope,
					"warning",
					parked === 1
						? "1 value needs review"
						: `${parked} values need review`,
					parked === 1
						? "It doesn't fit the property's new type. Its case is held out of the app until you decide it."
						: "They don't fit the property's new type. Their cases are held out of the app until you decide them.",
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
											showProjectToast(
												projectToastScope,
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
											moduleUuid: uuidSchema.parse(moduleEntry[0]),
										});
										// The toast outlives the builder (ToastContainer is
										// app-wide), and pushState + notifyPathChange render
										// only while THIS app's builder is mounted to hear
										// them — pressed from anywhere else, the button must
										// be a real navigation, not a silent URL swap.
										if (window.location.pathname.startsWith(`/build/${id}`)) {
											pushBuilderHistory(url);
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
		if (res.status === 409) {
			const body = (await res.json().catch(() => ({}))) as { type?: unknown };
			if (body.type === "commit_rejected") {
				return { ok: false, kind: "commitRejected" };
			}
			/* `app_changed` is the expected scope race. An untyped 409 is also
			 * preserved: without the semantic tag it is unsafe to discard a batch. */
			return { ok: false, kind: "scopeChanged" };
		}
		if (res.status === 403) return { ok: false, kind: "reauth" };
		if (res.status === 404) return { ok: false, kind: "notFound" };
		if (res.status === 400) {
			const body = (await res.json().catch(() => ({}))) as {
				type?: unknown;
				details?: unknown;
			};
			if (
				body.type === "mutation_wire_canonicality_invalid" &&
				typeof body.details === "object" &&
				body.details !== null
			) {
				const details = body.details as Record<string, unknown>;
				const mutationIndex = details.mutationIndex;
				const pointer = details.pointer;
				const reason = details.reason;
				if (
					(mutationIndex === null ||
						(typeof mutationIndex === "number" &&
							Number.isSafeInteger(mutationIndex) &&
							mutationIndex >= 0)) &&
					typeof pointer === "string" &&
					isMutationWireCanonicalityReason(reason)
				) {
					return {
						ok: false,
						kind: "canonicality",
						details: { mutationIndex, pointer, reason },
					};
				}
			}
			if (body.type === "mutation_batch_id_collision") {
				return { ok: false, kind: "batchCollision" };
			}
			return {
				ok: false,
				kind: "network",
				detail: "HTTP 400",
				httpStatus: 400,
			};
		}
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
		if (res.status === 413) {
			return {
				ok: false,
				kind: "tooLarge",
				detail,
				httpStatus: res.status,
			};
		}
		return {
			ok: false,
			kind: "network",
			detail,
			httpStatus: res.status,
		};
	};

	const reload = async () => {
		const id = appIdBox.current;
		if (!id) {
			throw new ReconcilerReloadError("network", {
				message: "reconciler reload has no app id",
			});
		}
		let res: Response;
		try {
			res = await fetch(`/api/apps/${id}`, { cache: "no-store" });
		} catch (error) {
			throw new ReconcilerReloadError("network", {
				message: "reconciler reload network request failed",
				originalError: error,
			});
		}
		if (res.status === 404) {
			pendingReloadRecovery = undefined;
			return { kind: "revoked" as const };
		}
		if (!res.ok) {
			throw new ReconcilerReloadError("http", {
				message: `reconciler reload failed with HTTP ${res.status}`,
				httpStatus: res.status,
			});
		}
		let body: unknown;
		try {
			body = await res.json();
		} catch (error) {
			throw new ReconcilerReloadError("invalid-json", {
				message: "reconciler reload response was not JSON",
				httpStatus: res.status,
				originalError: error,
			});
		}
		let data: ReturnType<typeof parseAppReadSnapshot>;
		try {
			data = parseAppReadSnapshot(body);
		} catch (error) {
			throw new ReconcilerReloadError("snapshot-schema", {
				message: "reconciler reload snapshot failed schema admission",
				httpStatus: res.status,
				issues: safeZodIssues(error),
				/* Do not retain the ZodError itself: custom refinement messages can
				 * interpolate user-authored blueprint values. The typed wrapper's
				 * stable stack plus bounded code/path issues are the telemetry record. */
			});
		}
		pendingReloadRecovery = undefined;
		return {
			kind: "authorized" as const,
			projectId: data.projectId,
			role: data.role,
			canEdit: data.canEdit,
			blueprint: data.blueprint,
			seq: data.baseSeq,
		};
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
		canEdit: () => sessionStore.getState().canEdit,
		beginAccessRefresh,
		markAccessReconnecting: () =>
			sessionStore.getState().markAccessReconnecting(),
		applyAccessSnapshot: (snapshot, options) =>
			sessionStore.getState().applyAccessSnapshot(snapshot, options),
		onViewRevoked: confirmViewRevoked,
		onClientUpgradeRequired: () =>
			sessionStore.getState().requireClientUpgrade(),
		resubscribe: (cursor) => {
			/* Every reconciler reload path (gap, conflict, server-only app change) lands
			 * here. Idempotent with the SSE reload handler and required for paths
			 * whose trigger was not itself an SSE `reload` frame. */
			openStream(cursor);
			// A resubscribe follows a reload, which folded frames this tab
			// never saw individually — any of them could have migrated case
			// data, so refresh the per-type caches wholesale.
			invalidateDocCaseTypes();
		},
		scheduleRetry,
		onSaveError: (failure) => {
			// Stable categories group across apps/releases. Entity and sequence
			// identity stays in structured context, never in the issue message.
			const recovery =
				failure.operation === "reload-get" ? pendingReloadRecovery : undefined;
			reportClientError(
				{
					message: observedFailureMessage(failure),
					stack:
						failure.error instanceof Error ? failure.error.stack : undefined,
					source: "manual",
					url: window.location.href,
					diagnostics: {
						component: "reconciler",
						operation: failure.operation,
						failureKind: failure.failureKind,
						appId: appIdBox.current,
						baseSeq: reconciler.getSnapshot().baseSeq,
						httpStatus: failure.httpStatus,
						mutationIndex: failure.mutationIndex,
						pointer: failure.pointer,
						reason: failure.reason ?? failure.detail,
						issues: failure.issues,
						recoveryTrigger: recovery?.trigger,
						eventId: recovery?.eventId,
					},
				},
				failure.error,
			);
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

	function activate(newAppId: string, baseSeq: number): void {
		if (appIdBox.current !== undefined) return; // already active
		appIdBox.current = newAppId;
		activateBuilderHistoryScope(
			projectScopeId,
			newAppId,
			sessionStore.getState().scopeEpoch,
		);
		reconciler.activate({
			appId: newAppId,
			baseSeq,
			baseDoc: docStore.getState(),
		});
		openStream(baseSeq);
	}

	function start(): void {
		active = true;
		toastStore.activateProjectScope({
			scopeId: projectScopeId,
			epoch: sessionStore.getState().scopeEpoch,
		});
		activateBuilderHistoryScope(
			projectScopeId,
			appIdBox.current,
			sessionStore.getState().scopeEpoch,
		);
		// An existing app (or a replay of the mount effect after activation)
		// opens at the reconciler's confirmed cursor; a dormant new build waits
		// for `activate` to open at the server-provided creation cursor.
		if (appIdBox.current !== undefined) {
			openStream(reconciler.getSnapshot().baseSeq);
		}
		// Re-arm the reconciler's recovery machine — work that survived the
		// suspend window (an un-acked batch, a pending reload) gets its tick back.
		reconciler.resumeRecovery();
	}

	function suspend(): void {
		active = false;
		cancelCurrentFrameRecoveries();
		toastStore.deactivateProjectScope(projectScopeId);
		deactivateBuilderHistoryScope(projectScopeId);
		closeOwnedStream();
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
		projectScopeId,
		appIdBox,
		start,
		activate,
		suspend,
		presenceSubs,
		organizationSubs,
		subscribePreviewProjectSpace,
		lookupManifestBroker,
		projectScopeResetRegistry,
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
		runtimeRef.current = createReconcilerRuntime(
			docStore,
			sessionStore,
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
						projectScopeId: runtime.projectScopeId,
						activate: runtime.activate,
						subscribePresence: (cb: (roster: PresenceFrame) => void) => {
							runtime.presenceSubs.add(cb);
							return () => runtime.presenceSubs.delete(cb);
						},
						subscribeAppOrganization: (cb: () => void) => {
							runtime.organizationSubs.add(cb);
							return () => runtime.organizationSubs.delete(cb);
						},
						subscribePreviewProjectSpace: (
							cb: (projectSpace: string | null) => void,
						) => runtime.subscribePreviewProjectSpace(cb),
						subscribeLookupManifest: (
							cb: (manifest: LookupManifest | null) => void,
						) => runtime.lookupManifestBroker.subscribe(cb),
						subscribeProjectScopeReset: (cb: (scopeEpoch: number) => void) =>
							runtime.projectScopeResetRegistry.subscribe(cb),
						isProjectScopeCurrent: (scopeEpoch: number) =>
							runtime.projectScopeResetRegistry.isCurrent(scopeEpoch),
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
