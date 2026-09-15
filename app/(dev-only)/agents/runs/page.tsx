import Link from "next/link";
import { connection } from "next/server";
import { Badge } from "@/components/shadcn/badge";
import { listDesignSessions, listLocalApps } from "@/lib/agent/anatomy";
import { formatCurrency, formatRelativeDate } from "@/lib/utils/format";
import { formatTokens } from "../_lib/format";

export const dynamic = "force-dynamic";

/**
 * What local runs recorded: design sessions with their model contexts, and
 * apps whose newest thread the architect page can reconstruct a turn from.
 */
export default async function RunsPage() {
	await connection();
	const [sessions, apps] = await Promise.all([
		listDesignSessions(),
		listLocalApps(),
	]);
	return (
		<div className="space-y-10">
			<div className="max-w-[68ch] space-y-2">
				<h1 className="font-display text-[28px] font-semibold leading-tight tracking-[-0.015em]">
					Recorded runs
				</h1>
				<p className="text-nova-text-secondary text-[15px] leading-relaxed">
					The architect, peer and translator record their messages and usage.
					Open a session to read them in order, with estimates beside recorded
					usage.
				</p>
			</div>

			<section aria-labelledby="sessions-heading" className="space-y-3">
				<h2
					id="sessions-heading"
					className="font-display text-[19px] font-semibold tracking-[-0.015em]"
				>
					Design sessions
				</h2>
				{sessions.length === 0 ? (
					<p className="max-w-[68ch] rounded-xl border border-nova-border border-dashed px-4 py-3 text-nova-text-secondary text-sm">
						No design session has run locally yet. Start a chat build on this
						machine and its contexts appear here.
					</p>
				) : (
					<ol className="divide-y divide-nova-border rounded-xl border border-nova-border bg-nova-surface">
						{sessions.map((session) => (
							<li key={session.designSessionId}>
								<Link
									href={`/agents/runs/${session.designSessionId}`}
									className="nova-focusable-inset flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-white/[0.06]"
								>
									<span className="min-w-0 flex-1 basis-56 truncate text-[15px]">
										{session.appName ??
											`Session ${session.designSessionId.slice(0, 8)}`}
									</span>
									<span className="flex flex-wrap items-center gap-1.5">
										<Badge
											variant={
												session.state === "complete" ? "emerald" : "muted"
											}
										>
											{session.state}
										</Badge>
										<Badge>{session.mode}</Badge>
										{session.architectContexts > 0 && (
											<Badge variant="violet">
												{session.architectContexts} architect{" "}
												{session.architectContexts === 1
													? "context"
													: "contexts"}
											</Badge>
										)}
										{session.peerContexts > 0 && (
											<Badge variant="violet">
												{session.peerContexts} peer{" "}
												{session.peerContexts === 1 ? "context" : "contexts"}
											</Badge>
										)}
										{session.translatorContexts > 0 && (
											<Badge variant="violet">
												{session.translatorContexts} translation{" "}
												{session.translatorContexts === 1 ? "batch" : "batches"}
											</Badge>
										)}
									</span>
									<span className="font-mono text-nova-text-secondary text-xs">
										{formatTokens(session.billedInputTokens)} in ·{" "}
										{formatTokens(session.billedOutputTokens)} out ·{" "}
										{formatCurrency(session.costEstimate)}
									</span>
									<span className="text-nova-text-muted text-xs">
										{formatRelativeDate(new Date(session.updatedAt))}
									</span>
								</Link>
							</li>
						))}
					</ol>
				)}
			</section>

			<section aria-labelledby="apps-heading" className="space-y-3">
				<h2
					id="apps-heading"
					className="font-display text-[19px] font-semibold tracking-[-0.015em]"
				>
					Apps
				</h2>
				<p className="max-w-[68ch] text-nova-text-secondary text-sm leading-relaxed">
					An app opens the edit agent's current composition with its newest
					thread, labeled as a reconstruction. Build conversations appear in the
					sessions above.
				</p>
				{apps.length === 0 ? (
					<p className="max-w-[68ch] rounded-xl border border-nova-border border-dashed px-4 py-3 text-nova-text-secondary text-sm">
						No local app yet. Build one and it appears here.
					</p>
				) : (
					<ol className="divide-y divide-nova-border rounded-xl border border-nova-border bg-nova-surface">
						{apps.map((app) => (
							<li key={app.appId}>
								<Link
									href={`/agents/solutions-architect?app=${encodeURIComponent(app.appId)}`}
									className="nova-focusable-inset flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-white/[0.06]"
								>
									<span className="min-w-0 flex-1 basis-56 truncate text-[15px]">
										{app.appName}
									</span>
									<span className="flex items-center gap-1.5">
										<Badge
											variant={app.status === "complete" ? "emerald" : "muted"}
										>
											{app.status}
										</Badge>
										{app.hasThread ? (
											<Badge variant="violet">has a thread</Badge>
										) : (
											<Badge>no thread</Badge>
										)}
									</span>
									<span className="text-nova-text-muted text-xs">
										{app.moduleCount}{" "}
										{app.moduleCount === 1 ? "module" : "modules"} ·{" "}
										{app.formCount} {app.formCount === 1 ? "form" : "forms"}
									</span>
								</Link>
							</li>
						))}
					</ol>
				)}
			</section>
		</div>
	);
}
