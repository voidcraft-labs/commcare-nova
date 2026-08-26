/**
 * BuilderFormEngineProvider — scoped context for the preview EngineController.
 *
 * The EngineController is a plain class that owns the form preview's
 * runtime store (computed visibility, validation, test-mode values) and
 * the blueprint subscriptions that keep it in sync with the doc store.
 * Its lifecycle matches the builder session, not any specific component —
 * so it lives in a context at the provider-stack level rather than in a
 * per-component hook.
 *
 * Descendants access the controller via `useBuilderFormEngine()`. Direct
 * imports of `EngineController` are confined to this file and the
 * controller's own module — components never construct one themselves.
 *
 * Install timing matters: the doc store reference is bound on the
 * controller SYNCHRONOUSLY inside `useState`'s initializer, not in a
 * mount effect. React runs effects child-before-parent, so if the parent
 * (this provider) installed the doc store in `useEffect`, descendant
 * effects that call `controller.activateForm(...)` on first mount would
 * see `docStore === null`, silently no-op, and leave the form preview
 * with no runtime state. Binding inside `useState` avoids that race —
 * by the time any descendant renders, the controller is already wired.
 *
 * A follow-up `useEffect` keeps the binding fresh if the doc store
 * reference changes after mount (rare today since `buildId` changes
 * remount the entire provider tree, but defensive against future
 * refactors) and runs `deactivate()` cleanup on unmount.
 */
"use client";

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { reportClientError } from "@/lib/clientErrorReporter";
import { BlueprintAuthoringLanguageContext } from "@/lib/doc/authoringLanguageContext";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { useSelectedPreviewIdentityState } from "@/lib/preview/hooks/useSelectedPreviewIdentity";
import { useOptionalBuilderSessionApi } from "@/lib/session/provider";
import { createBrowserXPathRuntime } from "../xpath/browserWorkerClient";
import {
	createInProcessXPathWorkerFactory,
	XPathRuntime,
} from "../xpath/workerClient";
import { EngineController, type EngineRuntimeFault } from "./engineController";

/** Preserve useful originating frames without retaining an exception message
 * that may contain authored paths, labels, answers, or other user data. */
function sanitizedEngineFaultError(
	fault: EngineRuntimeFault,
	thrown: unknown,
): Error {
	const error = new Error(
		`Preview runtime invariant failed during ${fault.operation}.`,
	);
	if (thrown instanceof Error && thrown.stack !== undefined) {
		/* V8 prefixes the stack with the complete Error message, including any
		 * embedded newlines. Remove that exact prefix before retaining frames so
		 * a message containing a fake `at ...` line can never cross the boundary. */
		const rawHeader = `${thrown.name}: ${thrown.message}`;
		if (thrown.stack.startsWith(rawHeader)) {
			const frames = thrown.stack.slice(rawHeader.length);
			if (/^\n\s+at\s/.test(frames)) {
				error.stack = `${error.name}: ${error.message}${frames}`;
			}
		}
	}
	return error;
}

// ── Context ─────────────────────────────────────────────────────────────

const BuilderFormEngineContext = createContext<EngineController | null>(null);

// ── Provider ────────────────────────────────────────────────────────────

/**
 * Wraps the builder subtree with a single long-lived `EngineController`.
 *
 * Expected placement: inside `BlueprintDocProvider` so the doc store is
 * reachable via context. The controller is created AND wired to the doc
 * store inside `useState`'s initializer so it's ready for descendant
 * effects on first render — see the module header for the race this
 * avoids. The follow-up effect re-syncs on doc-store identity change
 * and tears down the active form subscription on unmount.
 */
export function BuilderFormEngineProvider({
	children,
}: {
	children: ReactNode;
}) {
	const docStore = useContext(BlueprintDocContext);
	const presentationLanguage = useContext(BlueprintAuthoringLanguageContext);
	const session = useOptionalBuilderSessionApi();

	/* Create the controller AND bind the doc store + preview identity
	 * synchronously on first render. Child effects (e.g.
	 * `useFormEngine.activateForm`) flush before parent effects, so any
	 * install we did in this component's own `useEffect` would land too
	 * late — descendants would already have called `activateForm` against
	 * an unwired controller. For the identity that lateness would mean
	 * every warm-session form mount builds its engine identity-less and
	 * immediately rebuilds when the parent effect lands. The `useState`
	 * initializer runs during render, before any descendant mounts, so
	 * both are in place before anyone needs them (`previewAsMe` is pure,
	 * and Better Auth resolves a warm client session synchronously). */
	const identityState = useSelectedPreviewIdentityState({
		useCachedSessionImmediately: true,
	});

	const [controller] = useState(() => {
		const runtime =
			typeof Worker === "undefined"
				? new XPathRuntime({
						workerFactory: createInProcessXPathWorkerFactory(),
						requestTimeoutMilliseconds: 30_000,
					})
				: createBrowserXPathRuntime({ requestTimeoutMilliseconds: 30_000 });
		const c = new EngineController(runtime);
		c.setFaultReporter((fault, thrown) => {
			const safeError = sanitizedEngineFaultError(fault, thrown);
			reportClientError(
				{
					message: safeError.message,
					stack: safeError.stack,
					source: "manual",
					/* The fixed category + operation group this invariant without
					 * forwarding any route, app, tenant, case, or user identity. */
					url: typeof window === "undefined" ? "" : window.location.origin,
					diagnostics: {
						component: "preview-engine",
						operation: fault.operation,
						failureKind: "runtime-invariant",
					},
				},
				safeError,
			);
		});
		if (docStore) c.setDocStore(docStore);
		c.setPresentationLanguage(presentationLanguage);
		c.setPreviewIdentityBlocked(identityState.kind === "persona-unavailable");
		if (identityState.kind === "ready") {
			c.setPreviewIdentity(identityState.identity);
		}
		return c;
	});

	/* Keep the doc store reference in sync if it changes after mount
	 * (rare — `buildId` changes today fully remount the provider tree,
	 * but explicit handling makes the contract resilient). On unmount we
	 * also deactivate any active form subscription and clear the
	 * reference so stray events can't fire against a destroyed store. */
	useEffect(() => {
		if (!docStore) return;
		controller.setDocStore(docStore);
		return () => {
			controller.deactivate();
			controller.setDocStore(null);
		};
	}, [controller, docStore]);
	/* React Strict Mode replays effect setup-cleanup-setup against the SAME
	 * state-created controller. Keep cleanup leak-safe but re-armable: terminate
	 * workers and subscriptions on every cleanup, then reopen the runtime when
	 * the owner effect mounts again. `dispose()` remains the terminal API for
	 * non-React owners that can prove the controller will never be reused. */
	useEffect(() => {
		controller.resume();
		return () => controller.suspend();
	}, [controller]);

	/* Keep the identity in sync with later session changes — the cold
	 * session resolving after mount, a sign-out broadcast from another
	 * tab. The controller's setter treats a materially-identical identity
	 * as a no-op, so session refetches minting new user references don't
	 * rebuild an active engine. The provider's warm-session opt-in changes
	 * only this non-rendered controller; visual consumers retain the
	 * identity-free hydration render. */
	useEffect(() => {
		if (identityState.kind === "persona-unavailable") {
			controller.setPreviewIdentityBlocked(true);
			return;
		}
		controller.setPreviewIdentityBlocked(false);
		controller.setPreviewIdentity(identityState.identity);
	}, [controller, identityState]);

	/* URL-owned language changes must reach the engine before paint so a
	 * localized rendered field and its dynamic resolved prose never flash two
	 * different languages. The initializer above covers the first mount. */
	useLayoutEffect(() => {
		controller.setPresentationLanguage(presentationLanguage);
	}, [controller, presentationLanguage]);

	/* The reset signal starts before the authoritative GET knows whether the
	 * app actually changed Projects, so it cannot retire form state. Observe
	 * confirmed authorized identities instead: a same-Project refresh keeps
	 * the entry, while an app/Project change synchronously drops source-tenant
	 * answers and case preloads. */
	const confirmedScopeRef = useRef<
		{ appId: string; projectId: string | undefined } | undefined
	>(undefined);
	useEffect(() => {
		if (session === null) return;
		const observe = () => {
			const current = session.getState();
			if (current.accessPhase !== "authorized" || current.appId === undefined) {
				return;
			}
			const previous = confirmedScopeRef.current;
			const next = {
				appId: current.appId,
				projectId: current.projectId,
			};
			confirmedScopeRef.current = next;
			if (
				previous !== undefined &&
				(previous.appId !== next.appId || previous.projectId !== next.projectId)
			) {
				controller.deactivate();
			}
		};
		observe();
		return session.subscribe(observe);
	}, [controller, session]);

	return (
		<BuilderFormEngineContext value={controller}>
			{children}
		</BuilderFormEngineContext>
	);
}

// ── Hook ────────────────────────────────────────────────────────────────

/**
 * Imperative access to the form preview's EngineController. Does NOT
 * subscribe to any state — callers that want to observe runtime state
 * for a specific field should use `useEngineState(uuid)` from
 * `hooks/useEngineState.ts`.
 *
 * Throws when used outside `BuilderFormEngineProvider` to surface
 * provider-order bugs immediately during development.
 */
export function useBuilderFormEngine(): EngineController {
	const ctx = useContext(BuilderFormEngineContext);
	if (!ctx) {
		throw new Error(
			"useBuilderFormEngine must be used within a BuilderFormEngineProvider",
		);
	}
	return ctx;
}
