/**
 * The project space Preview may honestly say a worker signed into.
 *
 * A tiny context rather than a slice of the session store, because this is
 * durable server state and the session store is explicitly ephemeral UI
 * state. It is seeded from the server on page load and replaced when a
 * publish in this tab creates or moves a deployment, so `commcare_project`
 * becomes real the moment the app actually lands on a project space.
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
	useMemo,
	useState,
} from "react";

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

/** Update it after a publish lands, without waiting for a page reload. */
export function useSetDeploymentProjectSpace(): (
	domain: string | null,
) => void {
	return useContext(DeploymentTargetContext).setProjectSpace;
}
