/**
 * The builder's migration notices: what this member has not dismissed (the
 * chip and the dialog) and every deployment entry of the app (the Publishing
 * cards). The builder page loads them in the same request as the app, and
 * each server render hands this provider the current rows; this member's own
 * dismissals in this tab stay applied over whatever rows arrive, since
 * serving code never writes a notice.
 */
"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import type {
	AppDeploymentNoticeEntry,
	AppMigrationNotice,
} from "@/lib/notices/migrationNotice";
import {
	type BuilderNotices,
	NO_BUILDER_NOTICES,
	withoutDismissed,
} from "./appNoticeModel";

interface AppNoticesValue {
	readonly notices: readonly AppMigrationNotice[];
	readonly deploymentEntries: readonly AppDeploymentNoticeEntry[];
	/** Hide these notices from this member's chip and dialog. */
	readonly forget: (noticeIds: readonly string[]) => void;
}

const AppNoticesContext = createContext<AppNoticesValue>({
	...NO_BUILDER_NOTICES,
	forget: () => {},
});

export function AppNoticesProvider({
	initial,
	children,
}: {
	initial: BuilderNotices | undefined;
	children: ReactNode;
}) {
	const [dismissedIds, setDismissedIds] = useState<readonly string[]>([]);
	const loaded = initial?.notices ?? NO_BUILDER_NOTICES.notices;
	const notices = useMemo(
		() => withoutDismissed(loaded, dismissedIds),
		[loaded, dismissedIds],
	);
	const deploymentEntries =
		initial?.deploymentEntries ?? NO_BUILDER_NOTICES.deploymentEntries;
	const forget = useCallback((noticeIds: readonly string[]) => {
		setDismissedIds((current) => [...current, ...noticeIds]);
	}, []);
	const value = useMemo(
		() => ({ notices, deploymentEntries, forget }),
		[notices, deploymentEntries, forget],
	);
	return <AppNoticesContext value={value}>{children}</AppNoticesContext>;
}

export function useAppNotices(): AppNoticesValue {
	return useContext(AppNoticesContext);
}
