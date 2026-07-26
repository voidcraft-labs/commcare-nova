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
import { useAuth } from "@/lib/auth/hooks/useAuth";
import { useUserCollections } from "@/lib/doc/hooks/useUserCollections";
import {
	previewAsMe,
	previewAsPersona,
	type ResolvedPreviewIdentity,
} from "@/lib/preview/engine/identity";
import { usePreviewPersonaUuid } from "@/lib/session/hooks";

export function useSelectedPreviewIdentity(
	options: { readonly useCachedSessionImmediately?: boolean } = {},
): ResolvedPreviewIdentity | null {
	const { user } = useAuth();
	const personaUuid = usePreviewPersonaUuid();
	const collections = useUserCollections();
	const [authMounted, setAuthMounted] = useState(false);

	useEffect(() => {
		if (options.useCachedSessionImmediately !== true) setAuthMounted(true);
	}, [options.useCachedSessionImmediately]);

	return useMemo(() => {
		const sessionUser =
			options.useCachedSessionImmediately === true || authMounted ? user : null;
		const persona =
			personaUuid === undefined ? undefined : collections.personas[personaUuid];
		if (personaUuid !== undefined && persona === undefined) return null;
		if (persona === undefined) return previewAsMe(sessionUser, collections);
		return previewAsPersona(sessionUser, persona, collections);
	}, [
		authMounted,
		collections,
		options.useCachedSessionImmediately,
		personaUuid,
		user,
	]);
}
