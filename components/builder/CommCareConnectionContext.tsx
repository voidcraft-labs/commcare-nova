/**
 * The signed-in user's CommCare HQ connection, as one context.
 *
 * The RSC page resolves `CommCareSettingsPublic` once and hands it to
 * BuilderLayout; two distant surfaces then need it — PublishPanel in the
 * header band and the App setup Publishing section deep in the canvas — so
 * it rides context rather than a prop chain through everything between.
 *
 * The value is memoized against the settings object (RSC-stable across
 * renders), so `PublishPanel`'s memo and the dialog's domain-reset effect
 * see one identity per page load rather than a fresh array per render.
 */
"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { CommCareSettingsPublic } from "@/lib/db/settings";

/* The dialog's own domain shape, restated rather than imported: the wire
 * type lives in lib/commcare, whose import boundary components/* stays
 * outside of. */
interface ConnectionDomain {
	name: string;
	displayName: string;
}

export interface CommCareConnection {
	/** Whether an API key is configured (and so direct HQ upload is offered). */
	readonly configured: boolean;
	/** Every project space the key can upload to; empty when not configured. */
	readonly availableDomains: ConnectionDomain[];
}

const EMPTY_DOMAINS: ConnectionDomain[] = [];
const NOT_CONFIGURED: CommCareConnection = {
	configured: false,
	availableDomains: EMPTY_DOMAINS,
};

const CommCareConnectionContext =
	createContext<CommCareConnection>(NOT_CONFIGURED);

export function CommCareConnectionProvider({
	settings,
	children,
}: {
	settings: CommCareSettingsPublic | undefined;
	children: ReactNode;
}) {
	const value = useMemo<CommCareConnection>(
		() =>
			settings?.configured
				? { configured: true, availableDomains: settings.availableDomains }
				: NOT_CONFIGURED,
		[settings],
	);
	return (
		<CommCareConnectionContext.Provider value={value}>
			{children}
		</CommCareConnectionContext.Provider>
	);
}

/** The connection state, defaulting to not-configured outside the provider. */
export function useCommCareConnection(): CommCareConnection {
	return useContext(CommCareConnectionContext);
}
