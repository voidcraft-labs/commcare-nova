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
import { log } from "@/lib/logger";

export async function ThreadHistory({ appId }: { appId: string }) {
	// [perf] TEMP — thread-load bucket. Runs inside the page's Suspense
	// boundary (streams in after the builder), so it doesn't block first paint,
	// but a slow threads query still delays the chat history. Remove with the
	// rest of the `[perf]` logging once the load regression is diagnosed.
	const threadsStart = performance.now();
	const threads = await loadThreads(appId);
	log.info("[perf] build/threadHistory loadThreads", {
		appId,
		ms: Math.round(performance.now() - threadsStart),
		threadCount: threads.length,
	});
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
