/**
 * The check when the builder opens: once per mount for an app, after the
 * builder is drawn, Nova asks whether CommCare HQ changed the app in any
 * project space it publishes to, and where it did, the header offers See what
 * changed in CommCare HQ.
 *
 * Nothing waits on it. It renders nothing and reads no promise in render; it
 * is a Route Handler's `fetch`, never a Server Action, since a tab's Server
 * Actions run one at a time and the builder's deployment reads are Server
 * Actions; its one effect runs after the commit it belongs to, so the builder
 * is on screen first; its one output is a write of the session's
 * `hqChangedTargets`, which has no "checking" value; leaving the builder
 * aborts it; and a failure of any kind is dropped here without a word.
 */
"use client";

import { useEffect, useRef } from "react";
import { hqChangedTargetsOf } from "@/components/builder/hqChangesPanelModel";
import {
	useAppId,
	useBuilderIsReady,
	useCanEdit,
	useSetHqChangedTargets,
} from "@/lib/session/hooks";

const CHECK_PATH = "/api/commcare/changes/check";

export function HqChangesCheck(): null {
	const appId = useAppId();
	const ready = useBuilderIsReady();
	const canEdit = useCanEdit();
	const setHqChangedTargets = useSetHqChangedTargets();
	const asks = appId !== undefined && ready && canEdit;
	/* The app this mount has its answer for. A request that answered, or
	 * failed, is not made again in this mount (the provider remounts on a new
	 * build id, which is the next open); one aborted under it, by an access
	 * refresh taking edit away for a moment, is. */
	const answeredFor = useRef<string | null>(null);

	useEffect(() => {
		if (!asks || appId === undefined || answeredFor.current === appId) return;
		const controller = new AbortController();
		void (async () => {
			try {
				const response = await fetch(CHECK_PATH, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ appId }),
					cache: "no-store",
					signal: controller.signal,
				});
				const body: unknown =
					response.status === 200 ? await response.json() : null;
				if (controller.signal.aborted) return;
				answeredFor.current = appId;
				const targets = hqChangedTargetsOf(body);
				if (targets !== null) setHqChangedTargets(targets);
			} catch {
				/* An aborted or failed request, or a body that is no JSON: the
				 * check says nothing, and the next publish checks again. */
				if (!controller.signal.aborted) answeredFor.current = appId;
			}
		})();
		return () => controller.abort();
	}, [asks, appId, setHqChangedTargets]);

	return null;
}
