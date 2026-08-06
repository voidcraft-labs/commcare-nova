/**
 * The project space Preview may honestly say a worker signed into.
 *
 * A tiny context rather than a slice of the session store, because this is
 * durable server state and the session store is explicitly ephemeral UI
 * state. Three paths keep it current, all carrying the SERVER's resolution
 * (only the server sees every deployment, so only it can apply the
 * ambiguity rule): the page seeds it at render, the publish dialog applies
 * each publish and Check status response, and the shared realtime stream's
 * `preview-project-space` frame converges every OTHER tab — a co-member's
 * publish, a second tab of your own — the moment a deployment write
 * commits anywhere.
 *
 * `null` means Nova has nothing honest to say: either the app is on no
 * project space yet, or it is on several and picking one would be a guess.
 * Preview then omits the key entirely, which is what CommCare does for a
 * value it has not got.
 */
"use client";

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useReconcilerContext } from "@/lib/collab/context";

interface DeploymentTargetValue {
	readonly projectSpace: string | null;
	readonly setProjectSpace: (domain: string | null) => void;
}

const DeploymentTargetContext = createContext<DeploymentTargetValue>({
	projectSpace: null,
	setProjectSpace: () => {},
});

export function DeploymentTargetProvider({
	initialProjectSpace,
	children,
}: {
	initialProjectSpace: string | null;
	children: ReactNode;
}) {
	const [projectSpace, setProjectSpace] = useState(initialProjectSpace);
	/* Nullable by design: replay mode mounts no reconciler, and `/build/new`
	 * has no deployments to hear about. The server-rendered seed and the
	 * dialog's own responses still apply there. */
	const reconciler = useReconcilerContext();
	useEffect(
		() => reconciler?.subscribePreviewProjectSpace(setProjectSpace),
		[reconciler],
	);
	const value = useMemo(
		() => ({ projectSpace, setProjectSpace }),
		[projectSpace],
	);
	return (
		<DeploymentTargetContext.Provider value={value}>
			{children}
		</DeploymentTargetContext.Provider>
	);
}

/** The project space Preview names, or `null` when there is no honest one. */
export function useDeploymentProjectSpace(): string | null {
	return useContext(DeploymentTargetContext).projectSpace;
}

/** Apply a publish or refresh response's answer without waiting for the
 * stream frame to arrive back. */
export function useSetDeploymentProjectSpace(): (
	domain: string | null,
) => void {
	return useContext(DeploymentTargetContext).setProjectSpace;
}
