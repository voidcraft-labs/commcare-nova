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

import { useMemo, useSyncExternalStore } from "react";
import { useDeploymentProjectSpace } from "@/components/builder/DeploymentTargetProvider";
import { useAuth } from "@/lib/auth/hooks/useAuth";
import { useUserCollections } from "@/lib/doc/hooks/useUserCollections";
import { ownRecordValue } from "@/lib/domain";
import {
	previewAsMe,
	previewAsPersona,
	type ResolvedPreviewIdentity,
} from "@/lib/preview/engine/identity";
import { usePreviewPersonaUuid } from "@/lib/session/hooks";

export type SelectedPreviewIdentityState =
	| {
			readonly kind: "ready";
			readonly identity: ResolvedPreviewIdentity | null;
	  }
	| { readonly kind: "persona-unavailable"; readonly personaUuid: string };

/**
 * Preserve the difference between an identity that has not hydrated yet and
 * a selected persona that no longer exists. Collapsing both to `null` lets
 * the latter run as an anonymous worker.
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

	return useMemo(() => {
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
