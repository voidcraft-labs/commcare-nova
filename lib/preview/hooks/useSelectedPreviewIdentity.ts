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
 * Visual consumers stay identity-free for the server/client hydration render:
 * Better Auth may expose a warm cached session synchronously only in the
 * browser. The engine provider opts into that warm value because the identity
 * changes only its non-rendered controller initializer; this prevents a form
 * engine from activating once without a worker and immediately rebuilding.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
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
	const [authMounted, setAuthMounted] = useState(false);

	useEffect(() => {
		if (options.useCachedSessionImmediately !== true) setAuthMounted(true);
	}, [options.useCachedSessionImmediately]);

	return useMemo(() => {
		const sessionUser =
			options.useCachedSessionImmediately === true || authMounted ? user : null;
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
		authMounted,
		collections,
		options.useCachedSessionImmediately,
		personaUuid,
		projectSpace,
		user,
	]);
}

/** Compatibility projection for consumers where unavailable means no identity. */
export function useSelectedPreviewIdentity(
	options: { readonly useCachedSessionImmediately?: boolean } = {},
): ResolvedPreviewIdentity | null {
	const state = useSelectedPreviewIdentityState(options);
	return state.kind === "ready" ? state.identity : null;
}
