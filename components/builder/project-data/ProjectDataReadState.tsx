/**
 * The two states every Project data read can be in besides having data,
 * rendered the same way wherever they occur.
 *
 * `loading` and `idle` share one presentation deliberately: from the author's
 * side both mean "not yet", and distinguishing "waiting for the session" from
 * "waiting for the server" would be Nova explaining its own plumbing. The
 * distinction stays in the state type, where the code needs it.
 *
 * A failure names what the server said. `lib/lookup`'s failures are already
 * written person-to-person, so this surface passes the message through rather
 * than replacing it with a generic apology — the one substitution is the
 * signed-out case, where the recovery is a reload rather than a retry.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import { Button } from "@/components/shadcn/button";
import type { LookupFailure } from "@/lib/lookup/types";

export function ProjectDataLoading({ label }: { label: string }) {
	return (
		<p
			role="status"
			className="mt-8 flex items-center gap-2 text-sm text-nova-text-secondary"
		>
			<Icon
				icon={tablerLoader2}
				className="animate-spin motion-reduce:animate-none"
				width="16"
				height="16"
				aria-hidden="true"
			/>
			{label}
		</p>
	);
}

export function ProjectDataFailure({
	title,
	failure,
	onRetry,
}: {
	title: string;
	failure: LookupFailure;
	onRetry: () => void;
}) {
	const signedOut = failure.code === "unauthenticated";
	return (
		<div
			role="alert"
			className="mt-8 max-w-md rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-4"
		>
			<p className="font-medium text-nova-text">{title}</p>
			<p className="mt-1 text-sm leading-relaxed text-nova-text-secondary">
				{signedOut
					? "You’re signed out. Reload the page to sign in again."
					: failure.message}
			</p>
			{failure.details !== undefined && failure.details.length > 0 && (
				<ul className="mt-2 space-y-1 text-sm leading-relaxed text-nova-text-secondary">
					{failure.details.slice(0, 5).map((detail) => (
						<li key={`${detail.code}:${detail.row ?? ""}:${detail.message}`}>
							{detail.message}
						</li>
					))}
				</ul>
			)}
			{!signedOut && (
				<Button
					type="button"
					variant="outline"
					className="mt-3"
					onClick={onRetry}
				>
					<Icon icon={tablerRefresh} aria-hidden="true" />
					Try again
				</Button>
			)}
		</div>
	);
}
