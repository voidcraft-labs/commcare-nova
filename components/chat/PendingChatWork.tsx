"use client";

import {
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
	useTransition,
} from "react";
import { discardChatWork, readChatWork } from "@/app/(app)/build/work-actions";
import { Button } from "@/components/shadcn/button";

const noRevisionSubscription = () => () => {};
const noRevision = () => 0;

type PendingWork = NonNullable<
	Extract<Awaited<ReturnType<typeof readChatWork>>, { success: true }>["work"]
>;

/** Keyed by authorized Project generation and thread by its parent. It reads
 * once when a turn settles, never polls or drives a model during recovery. */
export function PendingChatWork({
	appId,
	threadId,
	status,
	onContinue,
	revisions,
}: {
	revisions?: {
		subscribeCanonicalRevision(listener: () => void): () => void;
		canonicalRevision(): number;
	};
	appId: string;
	threadId: string;
	status: "submitted" | "streaming" | "ready" | "error";
	onContinue: (text: string) => void;
}) {
	const canonicalRevision = useSyncExternalStore(
		revisions?.subscribeCanonicalRevision ?? noRevisionSubscription,
		revisions?.canonicalRevision ?? noRevision,
		noRevision,
	);
	const [readAttempt, setReadAttempt] = useState(0);
	const mounted = useRef(true);
	const discardRequest = useRef<{ revision: string; id: string } | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const [work, setWork] = useState<PendingWork | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, startTransition] = useTransition();
	const running = status === "submitted" || status === "streaming";
	// biome-ignore lint/correctness/useExhaustiveDependencies: Confirmed revisions and explicit retries invalidate this server read without changing its authority scope.
	useEffect(() => {
		if (running) return;
		let current = true;
		startTransition(async () => {
			const result = await readChatWork({ appId, threadId }).catch(() => ({
				success: false as const,
				error: "Nova couldn't check pending changes. Try again.",
			}));
			if (!current) return;
			if (result.success) {
				setWork(result.work);
				setError(null);
			} else setError(result.error);
		});
		return () => {
			current = false;
		};
	}, [appId, threadId, running, canonicalRevision, readAttempt]);
	if (!work || work.pendingChanges === 0) {
		return error ? (
			<div
				role="alert"
				className="mx-3 mb-3 rounded-xl border border-nova-border p-3 text-sm"
			>
				<p>{error}</p>
				<Button
					type="button"
					disabled={busy || running}
					onClick={() => setReadAttempt((value) => value + 1)}
				>
					Try again
				</Button>
			</div>
		) : null;
	}
	const discard = (restart: boolean) => {
		if (!work.revision) return;
		const expectedRevision = work.revision;
		if (discardRequest.current?.revision !== expectedRevision)
			discardRequest.current = {
				revision: expectedRevision,
				id: crypto.randomUUID(),
			};
		const requestId = discardRequest.current.id;
		startTransition(async () => {
			const result = await discardChatWork({
				appId,
				threadId,
				workId: work.workId,
				expectedRevision,
				requestId,
			}).catch(() => ({
				success: false as const,
				error:
					"Nova couldn't confirm whether these changes were discarded. You can try again.",
			}));
			if (!mounted.current) return;
			if (!result.success) {
				setError(result.error);
				return;
			}
			setWork(null);
			setError(null);
			if (restart)
				onContinue(
					"Restart my unfinished request from the app's current saved state. The previous pending changes were discarded. Use our conversation to rebuild the intended changes and save a valid checkpoint.",
				);
		});
	};
	return (
		<div
			className="mx-3 mb-3 rounded-xl border border-nova-border p-3 text-sm"
			role="status"
		>
			<p className="font-medium text-nova-text">Changes waiting to be saved</p>
			<p className="mt-1 text-nova-text-muted">
				{work.stale
					? "The saved app changed while these edits were in progress. Restart discards these pending changes and begins again from the saved app."
					: "Your changes are preserved. You can continue to finish and save them, or discard them."}
			</p>
			{error && (
				<p className="mt-2 text-nova-text-muted" role="alert">
					{error}
				</p>
			)}
			<div className="mt-2 flex gap-2">
				<Button
					type="button"
					disabled={busy || running}
					onClick={() =>
						work.stale
							? discard(true)
							: onContinue(
									"Continue my unfinished changes from the preserved private work and save a valid checkpoint when ready.",
								)
					}
				>
					{work.stale ? "Restart from saved app" : "Continue"}
				</Button>
				<Button
					type="button"
					variant="ghost"
					disabled={busy || running}
					onClick={() => discard(false)}
				>
					Discard
				</Button>
			</div>
		</div>
	);
}
