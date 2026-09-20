/**
 * Connection issue page (server component).
 *
 * Where an OAuth authorize request lands when Nova can't go through with it:
 * the auth route handler classifies the failure and redirects here with a
 * `reason` from the closed set in `lib/oauth/authorize-errors`. The MCP client
 * that opened the tab never learns what happened, so this page is the only
 * way forward the person gets: it says what Nova saw and what usually fixes
 * it, in the same card the consent screen uses.
 *
 * Public on purpose. The failure happens before sign-in as often as after, so
 * the proxy exempts this exact path from the signed-out redirect and the page
 * reads no session. It renders nothing from the request beyond the parsed
 * reason: a hand-typed URL can only ever pick one of the four messages.
 */

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerCloudOff from "@iconify-icons/tabler/cloud-off";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerHourglass from "@iconify-icons/tabler/hourglass";
import tablerPlugConnectedX from "@iconify-icons/tabler/plug-connected-x";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/shadcn/button";
import { docsLink } from "@/lib/hostnames";
import {
	type AuthorizeIssueReason,
	parseAuthorizeIssueReason,
} from "@/lib/oauth/authorize-errors";
import { ConsentCard, IconChip } from "../consent/ConsentCard";

export const metadata: Metadata = { title: "Connection issue" };

interface ConnectionIssuePageProps {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}

interface IssueCopy {
	icon: Parameters<typeof Icon>[0]["icon"];
	/** Rose for a request Nova turned away, violet for one that only has to
	 * wait: a pause isn't a failure and shouldn't look like one. */
	tone: "error" | "violet";
	heading: string;
	body: string;
	/** Optional client-specific pointer under the body. */
	hint?: ReactNode;
}

const ISSUE_COPY: Record<AuthorizeIssueReason, IssueCopy> = {
	"unknown-client": {
		icon: tablerPlugConnectedX,
		tone: "error",
		heading: "This connection needs a fresh start",
		body: "Nova doesn't recognize the app that asked to connect. That can happen when a saved connection goes out of date. You can clear the Nova server's sign-in in your MCP client, then connect again.",
		hint: (
			<>
				In Claude Code, you can run <HintCode>/mcp</HintCode>, choose{" "}
				<HintCode>nova</HintCode>, then pick Clear authentication
			</>
		),
	},
	"client-unavailable": {
		icon: tablerCloudOff,
		tone: "error",
		heading: "Nova couldn't confirm this app",
		body: "Nova couldn't reach or confirm the address the app uses to identify itself. Trying again in a little while usually works. If it keeps happening, the app's publisher can help.",
	},
	"try-again-shortly": {
		icon: tablerHourglass,
		tone: "violet",
		heading: "Let's give this a minute",
		body: "Nova saw a lot of connection attempts just now. Waiting a minute, then connecting again from your MCP client, should work.",
	},
	"request-problem": {
		icon: tablerAlertTriangle,
		tone: "error",
		heading: "Nova couldn't complete this connection",
		body: "Something in this connection request didn't come through the way Nova expected. Starting the connection again from your MCP client usually fixes it.",
	},
};

/** A literal the person types or picks, set apart from the sentence around it. */
function HintCode({ children }: { children: ReactNode }) {
	return (
		<code className="rounded-md border border-nova-border/60 bg-nova-elevated/30 px-1.5 py-0.5 font-mono text-[12px] text-nova-text">
			{children}
		</code>
	);
}

export default async function ConnectionIssuePage({
	searchParams,
}: ConnectionIssuePageProps) {
	const sp = await searchParams;
	const reason = parseAuthorizeIssueReason(
		typeof sp.reason === "string" ? sp.reason : null,
	);
	const copy = ISSUE_COPY[reason];

	return (
		<main className="relative isolate flex min-h-full items-center justify-center overflow-hidden px-5 py-6 sm:py-10">
			{/* The same atmosphere the consent page paints, so a request that
			 *   can't continue still lands on a screen that is recognizably
			 *   part of the connection flow. */}
			<div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
				<div className="absolute left-1/2 top-[15%] h-[620px] w-[620px] -translate-x-1/2 rounded-full bg-nova-violet/[0.06] blur-[120px]" />
				<div className="absolute bottom-[-10%] left-[20%] h-[480px] w-[480px] rounded-full bg-nova-violet/[0.04] blur-[100px]" />
			</div>

			<div className="w-full max-w-[28rem]">
				<ConsentCard tone={copy.tone === "error" ? "error" : "default"}>
					<div className="flex flex-col items-start gap-5">
						<IconChip tone={copy.tone} icon={copy.icon} />
						<div className="flex flex-col gap-2">
							<h1 className="font-display tracking-tighter text-2xl font-semibold leading-tight text-nova-text">
								{copy.heading}
							</h1>
							<p className="text-sm leading-relaxed text-nova-text-secondary">
								{copy.body}
							</p>
						</div>
						{copy.hint ? (
							<p className="w-full rounded-xl border border-nova-border/70 bg-nova-surface/20 px-3.5 py-3 text-[13px] leading-relaxed text-nova-text-secondary">
								{copy.hint}
							</p>
						) : null}
						<div className="flex w-full flex-col-reverse gap-2.5 sm:flex-row">
							<Button
								render={<Link href="/" />}
								nativeButton={false}
								variant="secondary"
								className="sm:flex-1"
							>
								Back to Nova
							</Button>
							<Button
								render={
									<a
										href={docsLink("/mcp/connecting")}
										target="_blank"
										rel="noopener noreferrer"
									/>
								}
								nativeButton={false}
								className="sm:flex-1"
							>
								Read the guide
								<Icon
									icon={tablerExternalLink}
									width="16"
									height="16"
									aria-hidden
								/>
							</Button>
						</div>
					</div>
				</ConsentCard>
			</div>
		</main>
	);
}
