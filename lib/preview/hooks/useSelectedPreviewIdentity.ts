/**
 * The identity Preview is currently running as — the one client-side
 * derivation every preview surface shares.
 *
 * "Preview as me" and "Preview as <persona>" are the two modes, and they
 * must not blend: this hook returns exactly one resolved identity, so a
 * screen can never evaluate half its expressions as one worker and half as
 * another. The selection lives in the session store (ephemeral, like every
 * other preview field); the identity itself is built here from the
 * committed document.
 *
 * Visual consumers stay identity-free for the hydration render alone: Better
 * Auth may expose a warm cached session synchronously only in the browser, so
 * a render the server also made must not read it. A screen mounted after
 * hydration reads the session at once, so its first render is the worker's
 * rather than a session still waiting for one (`identity.ts::awaitsPreviewIdentity`).
 * The engine provider opts into the warm value even while hydrating because
 * the identity changes only its non-rendered controller initializer.
 */
"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { useDeploymentProjectSpace } from "@/components/builder/DeploymentTargetProvider";
import { useAuth } from "@/lib/auth/hooks/useAuth";
import { useUserCollections } from "@/lib/doc/hooks/useUserCollections";
import { ownRecordValue } from "@/lib/domain";
import {
	heldSelectedPreviewIdentityState,
	previewAsMe,
	previewAsPersona,
	type ResolvedPreviewIdentity,
	type SelectedPreviewIdentityState,
} from "@/lib/preview/engine/identity";
import { usePreviewPersonaUuid } from "@/lib/session/hooks";

export type { SelectedPreviewIdentityState };

/**
 * Preserve the difference between an identity that has not hydrated yet and
 * a selected persona that no longer exists. Collapsing both to `null` lets
 * the latter run as an anonymous worker.
 *
 * The value is the same object for as long as it names the same worker
 * (`identity.ts::heldSelectedPreviewIdentityState`): a session refetch mints
 * a new user object, and consumers compare the selection by reference (the
 * refusal backstop retries its screen when it changes), so a new object for
 * the same worker would retry, and log, on every refetch.
 */
export function useSelectedPreviewIdentityState(
	options: { readonly useCachedSessionImmediately?: boolean } = {},
): SelectedPreviewIdentityState {
	const { user } = useAuth();
	const personaUuid = usePreviewPersonaUuid();
	const collections = useUserCollections();
	/* The project space a deployment put this app on, so `commcare_project`
	 * reads the way it will on a device instead of staying absent forever. */
	const projectSpace = useDeploymentProjectSpace();
	const hydrated = useHydrated();

	const derived = useMemo((): SelectedPreviewIdentityState => {
		const sessionUser =
			options.useCachedSessionImmediately === true || hydrated ? user : null;
		const persona =
			personaUuid === undefined
				? undefined
				: ownRecordValue(collections.personas, personaUuid);
		if (personaUuid !== undefined && persona === undefined) {
			return { kind: "persona-unavailable", personaUuid };
		}
		return {
			kind: "ready",
			identity:
				persona === undefined
					? previewAsMe(sessionUser, collections, projectSpace)
					: previewAsPersona(sessionUser, persona, collections, projectSpace),
		};
	}, [
		collections,
		hydrated,
		options.useCachedSessionImmediately,
		personaUuid,
		projectSpace,
		user,
	]);
	/* Information from the previous render, held as React holds it: a
	 * different worker replaces the held selection during this render. */
	const [held, setHeld] = useState(derived);
	const selected = heldSelectedPreviewIdentityState(held, derived);
	if (selected !== held) setHeld(selected);
	return selected;
}

const subscribeToNothing = () => () => undefined;

/** False while React hydrates a render the server made, true in every other
 *  render, so a screen mounted after hydration is never a render behind. */
function useHydrated(): boolean {
	return useSyncExternalStore(
		subscribeToNothing,
		() => true,
		() => false,
	);
}

/** Compatibility projection for consumers where unavailable means no identity. */
export function useSelectedPreviewIdentity(
	options: { readonly useCachedSessionImmediately?: boolean } = {},
): ResolvedPreviewIdentity | null {
	const state = useSelectedPreviewIdentityState(options);
	return state.kind === "ready" ? state.identity : null;
}
