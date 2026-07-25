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
 * Better Auth resolves a cached session synchronously on the browser's
 * first paint while SSR has none, so the first render is deliberately
 * identity-free — the shared hydration rule every preview screen already
 * follows. A persona uuid naming nothing (a persona a peer removed while
 * this tab was previewing) falls back to previewing as the member rather
 * than freezing on a worker that no longer exists.
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

export function useSelectedPreviewIdentity(): ResolvedPreviewIdentity | null {
	const { user } = useAuth();
	const personaUuid = usePreviewPersonaUuid();
	const collections = useUserCollections();

	const [authMounted, setAuthMounted] = useState(false);
	useEffect(() => setAuthMounted(true), []);

	return useMemo(() => {
		const sessionUser = authMounted ? user : null;
		const persona =
			personaUuid === undefined ? undefined : collections.personas[personaUuid];
		if (persona === undefined) return previewAsMe(sessionUser, collections);
		return previewAsPersona(sessionUser, persona, collections);
	}, [authMounted, user, personaUuid, collections]);
}
