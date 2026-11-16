/**
 * The aside a surface shows where the person has no CommCare HQ connection:
 * what connecting gives them, a link to Settings in a new tab, and a button
 * that reads the connection again once they have added a key there.
 *
 * The Publish dialog and the bring-in picker both draw it, each with its own
 * words. It holds no decision: whether to show it, what it says and what
 * Check connection does are its caller's.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import Link from "next/link";
import { type ReactElement, useId } from "react";
import { Button } from "@/components/shadcn/button";

export function HqNotConnected({
	title,
	body,
	note,
	error,
	isRefreshing,
	onRefresh,
}: {
	readonly title: string;
	readonly body: string;
	/** A third, quieter line. The Publish dialog's "You can still choose a file" is one. */
	readonly note?: string;
	/** Why the last check could not be read, drawn under the buttons with `role="alert"`. */
	readonly error?: string;
	readonly isRefreshing: boolean;
	readonly onRefresh: () => void;
}): ReactElement {
	const titleId = useId();
	return (
		<section
			aria-labelledby={titleId}
			className="rounded-xl border border-nova-amber/20 bg-nova-amber/[0.06] p-4"
		>
			<div className="flex items-start gap-3">
				<Icon
					icon={tablerInfoCircle}
					className="mt-0.5 size-5 shrink-0 text-nova-amber"
					aria-hidden="true"
				/>
				<div className="min-w-0">
					<h3 id={titleId} className="text-sm font-semibold text-nova-text">
						{title}
					</h3>
					<p className="mt-1 text-sm leading-relaxed text-nova-text-secondary">
						{body}
					</p>
					{note !== undefined ? (
						<p className="mt-2 text-xs leading-relaxed text-nova-text-muted">
							{note}
						</p>
					) : null}
				</div>
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-2 pl-8">
				<Link
					href="/settings"
					target="_blank"
					rel="noopener noreferrer"
					className="nova-focusable inline-flex h-11 items-center gap-1 px-2 text-[15px] font-medium text-nova-violet-bright hover:underline"
				>
					Open Settings
					<Icon
						icon={tablerExternalLink}
						className="size-4"
						aria-hidden="true"
					/>
					<span className="sr-only">, opens in a new tab</span>
				</Link>
				<Button
					type="button"
					variant="outline"
					onClick={onRefresh}
					disabled={isRefreshing}
					aria-busy={isRefreshing}
				>
					<Icon
						icon={tablerRefresh}
						className={`size-4 ${isRefreshing ? "animate-spin" : ""}`}
						aria-hidden="true"
					/>
					{isRefreshing ? "Checking connection" : "Check connection"}
				</Button>
			</div>
			{error !== undefined ? (
				<p
					role="alert"
					className="mt-2 pl-8 text-[13px] leading-relaxed text-nova-rose"
				>
					{error}
				</p>
			) : null}
		</section>
	);
}
