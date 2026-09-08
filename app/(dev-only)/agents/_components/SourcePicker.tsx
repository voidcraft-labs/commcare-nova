"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useId } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type {
	DesignSessionSummary,
	LocalAppSummary,
} from "@/lib/agent/anatomy/recorded";
import type { InputNeed } from "@/lib/agent/anatomy/types";
import { useExternalNavigate } from "@/lib/routing/hooks";
import { formatWhen } from "../_lib/format";

export interface SourceState {
	readonly apps: readonly LocalAppSummary[];
	readonly sessions: readonly DesignSessionSummary[];
	readonly appId: string | null;
	readonly appName: string | null;
	readonly sessionId: string | null;
	readonly sessionAppName: string | null;
}

const NONE = "__none__";

/**
 * Picks the local app and design session the compositions render against.
 * Selection is URL state, so a link to a moment carries its sources.
 */
export function SourcePicker({
	sources,
	needs,
}: {
	sources: SourceState;
	needs: ReadonlySet<InputNeed>;
}) {
	const router = useExternalNavigate();
	const pathname = usePathname();
	const appLabelId = useId();
	const sessionLabelId = useId();
	const params = useSearchParams();
	const navigate = (key: "app" | "session", value: string | null) => {
		const next = new URLSearchParams(params.toString());
		if (value === null || value === NONE) next.delete(key);
		else next.set(key, value);
		const query = next.toString();
		router.replace(query.length > 0 ? `${pathname}?${query}` : pathname);
	};
	const wantsApp = needs.has("app");
	const wantsSession = needs.has("design-session");
	if (!wantsApp && !wantsSession) return null;
	return (
		<div className="flex flex-wrap items-end gap-3">
			{wantsApp && (
				<div className="flex min-w-0 flex-col gap-1.5">
					<span id={appLabelId} className="text-nova-text-secondary text-xs">
						Local app
					</span>
					<Select
						value={sources.appId ?? NONE}
						onValueChange={(value) => navigate("app", value)}
					>
						<SelectTrigger
							aria-labelledby={appLabelId}
							className="w-72 max-w-full"
						>
							<SelectValue>
								{sources.appId === null
									? "No app picked"
									: (sources.appName ?? sources.appId)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NONE}>No app picked</SelectItem>
							{sources.apps.map((app) => (
								<SelectItem key={app.appId} value={app.appId}>
									{app.appName}
									<span className="ml-2 text-nova-text-muted">
										{app.moduleCount}{" "}
										{app.moduleCount === 1 ? "module" : "modules"}
										{app.hasThread ? ", has a thread" : ""}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}
			{wantsSession && (
				<div className="flex min-w-0 flex-col gap-1.5">
					<span
						id={sessionLabelId}
						className="text-nova-text-secondary text-xs"
					>
						Local design session
					</span>
					<Select
						value={sources.sessionId ?? NONE}
						onValueChange={(value) => navigate("session", value)}
					>
						<SelectTrigger
							aria-labelledby={sessionLabelId}
							className="w-80 max-w-full"
						>
							<SelectValue>
								{sources.sessionId === null
									? "No session picked"
									: (sources.sessionAppName ?? sources.sessionId.slice(0, 8))}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NONE}>No session picked</SelectItem>
							{sources.sessions.map((session) => (
								<SelectItem
									key={session.designSessionId}
									value={session.designSessionId}
								>
									{session.appName ??
										`Session ${session.designSessionId.slice(0, 8)}`}
									<span className="ml-2 text-nova-text-muted">
										{session.state}, {formatWhen(session.updatedAt)}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}
		</div>
	);
}
