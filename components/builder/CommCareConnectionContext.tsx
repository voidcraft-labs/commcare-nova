/**
 * The signed-in user's CommCare HQ connection, as one context.
 *
 * The RSC page resolves `CommCareSettingsPublic` once and hands it to
 * BuilderLayout; two distant surfaces then need it — PublishPanel in the
 * header band and the App setup Publishing section deep in the canvas — so
 * it rides context rather than a prop chain through everything between.
 *
 * The value is memoized against the settings object and the last answer of
 * `refresh`, so `PublishPanel`'s memo and the dialog's domain-reset effect
 * see one identity until a refresh answers (its in-flight and failed flags
 * aside, which change only around a press). `refresh` reads
 * `GET /api/commcare/connection` and never calls the Next router: on a page
 * whose address the History API wrote, a router refresh would write Next's
 * own address back.
 */
"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import type { CommCareSettingsPublic } from "@/lib/db/settings";
import type { CommCareServer } from "@/lib/deployment";

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
	/** Which CommCare HQ installation the key authenticates against, or
	 *  null when not configured. A key reaches exactly one — US, India, and
	 *  EU share no accounts — so anything matching a deployment record to
	 *  this connection must compare the server before the domain name. */
	readonly server: CommCareServer | null;
	/** Every project space the key can upload to; empty when not configured. */
	readonly availableDomains: ConnectionDomain[];
	/** Reads the connection again and takes what comes back. Never rejects. */
	readonly refresh: () => Promise<void>;
	/** True while a refresh is in flight. */
	readonly isRefreshing: boolean;
	/** True where the last refresh could not be read. Cleared by the next one that answers. */
	readonly refreshFailed: boolean;
}

const EMPTY_DOMAINS: ConnectionDomain[] = [];
const NO_REFRESH = async () => {};
const NOT_CONFIGURED: CommCareConnection = {
	configured: false,
	server: null,
	availableDomains: EMPTY_DOMAINS,
	refresh: NO_REFRESH,
	isRefreshing: false,
	refreshFailed: false,
};

const CommCareConnectionContext =
	createContext<CommCareConnection>(NOT_CONFIGURED);

/** What a refresh answered, held beside the prop it was read over. */
interface RefreshedConnection {
	/** The `settings` prop this answer was read while the provider held. */
	readonly over: CommCareSettingsPublic | undefined;
	readonly settings: CommCareSettingsPublic;
}

/** The route's body, or null where it is not one. */
function connectionOf(body: unknown): CommCareSettingsPublic | null {
	if (typeof body !== "object" || body === null) return null;
	const connection = (body as { connection?: unknown }).connection;
	if (typeof connection !== "object" || connection === null) return null;
	const value = connection as Partial<Record<string, unknown>>;
	if (value.configured === false) return { configured: false };
	if (
		value.configured === true &&
		typeof value.username === "string" &&
		typeof value.server === "string" &&
		Array.isArray(value.availableDomains)
	) {
		return connection as CommCareSettingsPublic;
	}
	return null;
}

export function CommCareConnectionProvider({
	settings,
	children,
}: {
	settings: CommCareSettingsPublic | undefined;
	children: ReactNode;
}) {
	const [refreshed, setRefreshed] = useState<RefreshedConnection | null>(null);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [refreshFailed, setRefreshFailed] = useState(false);
	/* Only the latest refresh may settle the state. */
	const generationRef = useRef(0);

	/* An answer is filed under the prop it was read over, so a newer server
	 * render still wins over it. */
	const refresh = useCallback(async () => {
		const generation = ++generationRef.current;
		const over = settings;
		setIsRefreshing(true);
		let answer: CommCareSettingsPublic | null = null;
		try {
			const response = await fetch("/api/commcare/connection", {
				cache: "no-store",
			});
			if (response.ok) answer = connectionOf(await response.json());
			else await response.body?.cancel();
		} catch {
			answer = null;
		}
		if (generation !== generationRef.current) return;
		setIsRefreshing(false);
		if (answer === null) {
			setRefreshFailed(true);
			return;
		}
		setRefreshFailed(false);
		setRefreshed({ over, settings: answer });
	}, [settings]);

	/* A new `settings` prop (a later server render) clears the stored answer,
	 * so the server's word wins whenever it speaks. */
	const current =
		refreshed !== null && refreshed.over === settings
			? refreshed.settings
			: settings;
	const value = useMemo<CommCareConnection>(
		() =>
			current?.configured
				? {
						configured: true,
						server: current.server,
						availableDomains: current.availableDomains,
						refresh,
						isRefreshing,
						refreshFailed,
					}
				: {
						...NOT_CONFIGURED,
						refresh,
						isRefreshing,
						refreshFailed,
					},
		[current, refresh, isRefreshing, refreshFailed],
	);
	return (
		<CommCareConnectionContext value={value}>
			{children}
		</CommCareConnectionContext>
	);
}

/** The connection state, defaulting to not-configured outside the provider. */
export function useCommCareConnection(): CommCareConnection {
	return useContext(CommCareConnectionContext);
}
