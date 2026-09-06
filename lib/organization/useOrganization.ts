/** React subscribes to the app-scoped organization client. The client owns
 * snapshots, save barriers, revisions, and the write queue. */
"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import {
	createLocationAction,
	describeArchiveImpactAction,
	moveLocationAction,
	readOrganizationAction,
	setLocationArchivedAction,
	updateLocationAction,
} from "./actions";
import {
	createOrganizationClient,
	type OrganizationView,
	type OrganizationWriter,
} from "./organizationClient";

export type {
	OrganizationView,
	OrganizationWriter,
} from "./organizationClient";

const actions = {
	read: readOrganizationAction,
	create: createLocationAction,
	update: updateLocationAction,
	move: moveLocationAction,
	describeArchive: describeArchiveImpactAction,
	setArchived: setLocationArchivedAction,
};

export function useOrganization(
	appId: string,
): OrganizationView & OrganizationWriter {
	const collab = useReconcilerContext();
	const collabRef = useRef(collab);
	collabRef.current = collab;
	const client = useMemo(
		() =>
			createOrganizationClient(appId, actions, () => {
				const reconciler = collabRef.current?.reconciler;
				return async () =>
					reconciler?.waitForHumanSaveBarrier() ?? { kind: "saved" };
			}),
		[appId],
	);
	const snapshot = useSyncExternalStore(
		client.subscribe,
		client.getSnapshot,
		client.getSnapshot,
	);
	useEffect(() => {
		client.activate();
		return () => client.dispose();
	}, [client]);
	// A stream notification is only a poke; the authorized read remains the data plane.
	useEffect(
		() => collab?.subscribeAppOrganization(client.reload),
		[client, collab],
	);
	return { ...snapshot, ...client.writer, reload: client.reload };
}
