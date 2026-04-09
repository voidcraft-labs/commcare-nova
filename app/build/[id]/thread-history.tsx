/**
 * ThreadHistory — async Server Component that fetches and renders
 * historical chat threads for an app.
 *
 * Rendered inside a Suspense boundary in the build page so thread
 * loading doesn't block the builder. The pre-rendered markup passes
 * through the client boundary as children of ChatSidebar.
 *
 * Each HistoricalThread is a client component leaf (expand toggle),
 * but this wrapper and the overall thread list are server-rendered.
 */
import { HistoricalThread } from "@/components/chat/HistoricalThread";
import { ThreadDivider } from "@/components/chat/ThreadDivider";
import { loadThreads } from "@/lib/db/threads";

export async function ThreadHistory({ appId }: { appId: string }) {
	const threads = await loadThreads(appId);
	if (threads.length === 0) return null;

	return (
		<div className="space-y-1">
			{threads.map((thread) => (
				<HistoricalThread key={thread.run_id} thread={thread} />
			))}
			<ThreadDivider />
		</div>
	);
}
