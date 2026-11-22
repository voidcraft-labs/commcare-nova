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
import {
	type PreviewSearchCatalog,
	type PreviewSearchFacts,
	type PreviewSearchTarget,
	resolvePreviewSearchFacts,
} from "@/lib/preview/searchSettings";
import {
	useAccessPhase,
	useAppId,
	useProjectId,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";

interface Configuration {
	catalog: PreviewSearchCatalog | null;
	target: PreviewSearchTarget | undefined;
	facts: PreviewSearchFacts;
	select: (target: PreviewSearchTarget | undefined) => void;
}

const Context = createContext<Configuration>({
	catalog: null,
	target: undefined,
	facts: resolvePreviewSearchFacts(null),
	select: () => {},
});

export function PreviewSearchConfigurationProvider({
	children,
}: {
	children: ReactNode;
}) {
	const projectId = useProjectId();
	const scopeEpoch = useProjectScopeEpoch();
	const appId = useAppId();
	const authorized = useAccessPhase() === "authorized";
	const reconciler = useReconcilerContext();
	const [received, setReceived] = useState<PreviewSearchCatalog | null>(null);
	const scope = JSON.stringify([appId, projectId, scopeEpoch]);
	const [selection, setSelection] = useState<{
		scope: string;
		target: PreviewSearchTarget | undefined;
	}>();
	useEffect(
		() => reconciler?.subscribePreviewSearchSettings?.(setReceived),
		[reconciler],
	);
	const catalog =
		authorized && received?.projectId === projectId ? received : null;
	const target = scope === selection?.scope ? selection.target : undefined;
	const value = useMemo(
		() => ({
			catalog,
			target,
			facts: resolvePreviewSearchFacts(catalog, target),
			select: (target: PreviewSearchTarget | undefined) =>
				setSelection({ scope, target }),
		}),
		[catalog, target, scope],
	);
	return <Context value={value}>{children}</Context>;
}
export function usePreviewSearchConfiguration() {
	return useContext(Context);
}
