"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useId } from "react";
import { Field, FieldError, FieldLabel } from "@/components/shadcn/field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { RelativeTime } from "@/components/ui/RelativeTime";
import type {
	DesignSessionSummary,
	LocalAppSummary,
} from "@/lib/agent/anatomy/recorded";
import type { InputNeed } from "@/lib/agent/anatomy/types";
import { useExternalNavigate } from "@/lib/routing/hooks";

export interface SourceState {
	readonly apps: readonly LocalAppSummary[];
	readonly sessions: readonly DesignSessionSummary[];
	readonly appId: string | null;
	readonly appName: string | null;
	/** Why the picked app could not be loaded, when it could not. */
	readonly appProblem: string | null;
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
				<Field
					className="w-72 max-w-full"
					data-invalid={sources.appProblem !== null}
				>
					<FieldLabel htmlFor={appLabelId}>Local app</FieldLabel>
					<Select
						value={sources.appId ?? NONE}
						onValueChange={(value) => navigate("app", value)}
					>
						<SelectTrigger id={appLabelId}>
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
					{sources.appProblem && (
						<FieldError>
							{sources.appProblem} Pick another app, or repair this one through
							the builder first.
						</FieldError>
					)}
				</Field>
			)}
			{wantsSession && (
				<Field className="w-80 max-w-full">
					<FieldLabel htmlFor={sessionLabelId}>Local design session</FieldLabel>
					<Select
						value={sources.sessionId ?? NONE}
						onValueChange={(value) => navigate("session", value)}
					>
						<SelectTrigger id={sessionLabelId}>
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
										{session.state},{" "}
										<RelativeTime date={new Date(session.updatedAt)} />
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			)}
		</div>
	);
}
