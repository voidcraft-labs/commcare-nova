/**
 * AppSetupWorkspace: the URL-owned workspace for app administration
 * (`/build/{appId}/setup/{section}`).
 *
 * It sits deliberately outside the structure tree. The tree represents the
 * runnable app: modules, case lists, forms, and none of what lives here
 * is something a worker opens: it is who runs the app, where they work,
 * what runs on a schedule, and where it is deployed. Preview therefore has
 * nothing to run from this URL and leaves for the app home
 * (`usePreviewModeTransition`).
 *
 * The shell is a fixed, non-scrolling section strip over an independently
 * scrolling body: the same shape the case workspace's tabs use, so the two
 * workspaces feel like one system. The section IS the URL, so switching is
 * ordinary history navigation and every section deep-links.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import type { IconifyIcon } from "@iconify/types";
import tablerBuildingCommunity from "@iconify-icons/tabler/building-community";
import tablerClockBolt from "@iconify-icons/tabler/clock-bolt";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import tablerLanguage from "@iconify-icons/tabler/language";
import tablerUsers from "@iconify-icons/tabler/users";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { useNavigate } from "@/lib/routing/hooks";
import {
	APP_SETUP_SECTION_LABELS,
	APP_SETUP_SECTIONS,
	type AppSetupSection,
} from "@/lib/routing/types";
import { selectableSegmentCls } from "@/lib/styles";
import { AutomationsSection } from "./AutomationsSection";
import { LanguagesSection } from "./LanguagesSection";
import { OrganizationSection } from "./OrganizationSection";
import { UsersSection } from "./UsersSection";

const SECTION_ICONS: Readonly<Record<AppSetupSection, IconifyIcon>> = {
	users: tablerUsers,
	organization: tablerBuildingCommunity,
	languages: tablerLanguage,
	automations: tablerClockBolt,
	publishing: tablerCloudUpload,
};

/**
 * What each not-yet-built section will hold, in the author's words. Naming
 * the contents is the honest empty state: it tells someone who opened the
 * section what belongs here, rather than showing a blank panel or, worse:
 * a control that does nothing.
 */
const SECTION_PENDING_COPY: Readonly<
	Record<
		Exclude<
			AppSetupSection,
			"users" | "organization" | "languages" | "automations"
		>,
		string
	>
> = {
	publishing:
		"The CommCare project this app is published to, what Nova will create there, and what you set up by hand.",
};

export function AppSetupWorkspace({ section }: { section: AppSetupSection }) {
	const navigate = useNavigate();

	return (
		<div className="@container flex h-full min-h-0 flex-col">
			<div className="relative z-raised shrink-0 border-b border-nova-border bg-pv-bg py-2.5">
				<ContentFrame width="3xl" className="px-3 @sm:px-6">
					{/* Section names are how you know where you are, so they stay
					 * whole. When four of them plus a chat panel and a structure
					 * tree leave no room, the strip scrolls sideways rather than
					 * shortening "Users and personas" to "Users an". */}
					<nav
						aria-label="App setup sections"
						className="flex items-center gap-1 overflow-x-auto @sm:gap-1.5 @2xl:gap-2"
					>
						{APP_SETUP_SECTIONS.map((id) => {
							const active = section === id;
							return (
								<button
									key={id}
									type="button"
									aria-current={active ? "page" : undefined}
									onClick={() => navigate.openAppSetup(id)}
									className={`shrink-0 ${selectableSegmentCls(active)}`}
								>
									<Icon
										icon={SECTION_ICONS[id]}
										width="16"
										height="16"
										className="hidden shrink-0 @sm:block"
										aria-hidden="true"
									/>
									{APP_SETUP_SECTION_LABELS[id]}
								</button>
							);
						})}
					</nav>
				</ContentFrame>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<ContentFrame width="3xl" className="px-3 py-6 @sm:px-6">
					{section === "users" ? (
						<UsersSection />
					) : section === "organization" ? (
						<OrganizationSection />
					) : section === "languages" ? (
						<LanguagesSection />
					) : section === "automations" ? (
						<AutomationsSection />
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
	section: Exclude<
		AppSetupSection,
		"users" | "organization" | "languages" | "automations"
	>;
}) {
	return (
		<section aria-labelledby={`app-setup-${section}-heading`}>
			{/* Named three times in 135px: breadcrumb, selected tab, heading.
			    The tab already carries current-screen semantics, so this stays
			    as the section's accessible name and leaves the eye alone. */}
			<h2 id={`app-setup-${section}-heading`} className="sr-only">
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
