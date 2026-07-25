/**
 * AppSetupWorkspace — the URL-owned workspace for app administration
 * (`/build/{appId}/setup/{section}`).
 *
 * It sits deliberately outside the structure tree. The tree represents the
 * runnable app — modules, case lists, forms — and none of what lives here
 * is something a worker opens: it is who runs the app, where they work,
 * what runs on a schedule, and where it is deployed. Preview therefore has
 * nothing to run from this URL and leaves for the app home
 * (`usePreviewModeTransition`).
 *
 * The shell is a fixed, non-scrolling section strip over an independently
 * scrolling body — the same shape the case workspace's tabs use, so the two
 * workspaces feel like one system. The section IS the URL, so switching is
 * ordinary history navigation and every section deep-links.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import type { IconifyIcon } from "@iconify/types";
import tablerBuildingCommunity from "@iconify-icons/tabler/building-community";
import tablerClockBolt from "@iconify-icons/tabler/clock-bolt";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import tablerUsers from "@iconify-icons/tabler/users";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { Button } from "@/components/shadcn/button";
import { useNavigate } from "@/lib/routing/hooks";
import {
	APP_SETUP_SECTION_LABELS,
	APP_SETUP_SECTIONS,
	type AppSetupSection,
} from "@/lib/routing/types";
import { UsersSection } from "./UsersSection";

const SECTION_ICONS: Readonly<Record<AppSetupSection, IconifyIcon>> = {
	users: tablerUsers,
	organization: tablerBuildingCommunity,
	automations: tablerClockBolt,
	deployment: tablerCloudUpload,
};

/**
 * What each not-yet-built section will hold, in the author's words. Naming
 * the contents is the honest empty state: it tells someone who opened the
 * section what belongs here, rather than showing a blank panel or — worse —
 * a control that does nothing.
 */
const SECTION_PENDING_COPY: Readonly<
	Record<Exclude<AppSetupSection, "users">, string>
> = {
	organization:
		"The places people work — districts, facilities, and the rest of your organization structure — and which of them own cases.",
	automations:
		"Rules that run on a schedule against your cases, and the messages they send.",
	deployment:
		"The CommCare project this app is published to, what Nova will create there, and what you set up by hand.",
};

export function AppSetupWorkspace({ section }: { section: AppSetupSection }) {
	const navigate = useNavigate();

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="relative z-raised shrink-0 border-b border-nova-border bg-pv-bg py-2.5">
				<ContentFrame width="3xl" className="px-3 @sm:px-6">
					<nav
						aria-label="App setup sections"
						className="flex min-w-0 items-center gap-1 @sm:gap-1.5 @2xl:gap-2"
					>
						{APP_SETUP_SECTIONS.map((id) => {
							const active = section === id;
							return (
								<Button
									key={id}
									type="button"
									variant="ghost"
									size="lg"
									aria-current={active ? "page" : undefined}
									onClick={() => navigate.openAppSetup(id)}
									className={`h-11 min-w-0 shrink gap-2 rounded-lg px-2.5 text-[13px] font-medium @sm:px-3 ${
										active
											? "bg-nova-violet/[0.15] text-nova-violet-bright shadow-[inset_0_0_0_1px_rgba(139,92,246,0.35)]"
											: "text-nova-text-muted hover:bg-white/[0.05] hover:text-nova-text"
									}`}
								>
									<Icon
										icon={SECTION_ICONS[id]}
										width="16"
										height="16"
										className="hidden shrink-0 @sm:block"
										aria-hidden="true"
									/>
									<span className="truncate">
										{APP_SETUP_SECTION_LABELS[id]}
									</span>
								</Button>
							);
						})}
					</nav>
				</ContentFrame>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<ContentFrame width="3xl" className="px-3 py-6 @sm:px-6">
					{section === "users" ? (
						<UsersSection />
					) : (
						<PendingSection section={section} />
					)}
				</ContentFrame>
			</div>
		</div>
	);
}

/**
 * A section whose contents have not been built. It names what will live
 * here so the author knows the section is real and reserved, not broken.
 */
function PendingSection({
	section,
}: {
	section: Exclude<AppSetupSection, "users">;
}) {
	return (
		<section aria-labelledby={`app-setup-${section}-heading`}>
			<h2
				id={`app-setup-${section}-heading`}
				className="text-base font-semibold text-nova-text"
			>
				{APP_SETUP_SECTION_LABELS[section]}
			</h2>
			<p className="mt-2 max-w-prose text-[13px] leading-relaxed text-nova-text-secondary">
				{SECTION_PENDING_COPY[section]}
			</p>
			<p className="mt-4 max-w-prose text-[13px] leading-relaxed text-nova-text-muted">
				There is nothing to set up here yet.
			</p>
		</section>
	);
}
