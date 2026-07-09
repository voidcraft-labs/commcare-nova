/**
 * Project switcher — the header control that shows the active Project (the
 * tenancy scope every app list, builder, and case-data read is filtered by)
 * and lets the user switch between the Projects they belong to, spin up a new
 * one, or jump to member management.
 *
 * Switching writes the session's active organization server-side
 * (`authClient.organization.setActive`) and then `navigate.refresh()`es so the
 * server-rendered app list re-scopes to the new Project. Creating makes a fresh
 * Project (the caller becomes its owner via `creatorRole`), sets it active, and
 * refreshes onto it.
 *
 * The Project list + active id are resolved server-side and passed down (see
 * `(site)/layout.tsx`) so the trigger renders the right selection with no
 * client-fetch flicker.
 */

"use client";

import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSettings from "@iconify-icons/tabler/settings";
import tablerUsers from "@iconify-icons/tabler/users";
import Link from "next/link";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import type { ProjectSummary } from "@/lib/projects/membership";
import { useExternalNavigate } from "@/lib/routing/hooks";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";
import { showToast } from "@/lib/ui/toastStore";

interface ProjectSwitcherProps {
	/** Every Project the user belongs to (server-resolved). */
	projects: ProjectSummary[];
	/** The active Project id, or null when none resolved (no session). */
	activeProjectId: string | null;
}

/** A URL-safe slug from a Project name plus a short random suffix so two
 *  Projects of the same name never collide on the org table's unique slug. */
function slugForName(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	const suffix = crypto.randomUUID().slice(0, 6);
	return base ? `${base}-${suffix}` : `project-${suffix}`;
}

export function ProjectSwitcher({
	projects,
	activeProjectId,
}: ProjectSwitcherProps) {
	const navigate = useExternalNavigate();
	const [open, setOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [busy, setBusy] = useState(false);

	/* No session / no Projects resolved — render nothing rather than an empty
	 * control (the personal Project is always provisioned, so this only happens
	 * pre-auth, where the header itself is hidden). */
	if (!activeProjectId || projects.length === 0) return null;

	const active = projects.find((p) => p.id === activeProjectId) ?? projects[0];

	async function switchTo(projectId: string) {
		if (projectId === activeProjectId) {
			setOpen(false);
			return;
		}
		setBusy(true);
		const { error } = await authClient.organization.setActive({
			organizationId: projectId,
		});
		setBusy(false);
		if (error) {
			showToast(
				"error",
				"Couldn't switch Project",
				error.message ?? "Try again in a moment.",
			);
			return;
		}
		setOpen(false);
		navigate.refresh();
	}

	async function createProject() {
		const name = newName.trim();
		if (!name || busy) return;
		setBusy(true);
		const created = await authClient.organization.create({
			name,
			slug: slugForName(name),
		});
		if (created.error || !created.data) {
			setBusy(false);
			showToast(
				"error",
				"Couldn't create Project",
				created.error?.message ?? "Try a different name.",
			);
			return;
		}
		const { error: activateError } = await authClient.organization.setActive({
			organizationId: created.data.id,
		});
		setBusy(false);
		if (activateError) {
			showToast(
				"error",
				"Project created, but couldn't switch to it",
				activateError.message ?? "Pick it from the switcher.",
			);
		}
		setCreating(false);
		setNewName("");
		setOpen(false);
		navigate.refresh();
	}

	return (
		<Popover.Root
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				/* Reset the inline create form whenever the menu closes. */
				if (!next) {
					setCreating(false);
					setNewName("");
				}
			}}
		>
			<Popover.Trigger
				aria-label="Switch Project"
				className="flex items-center gap-1.5 max-w-[200px] rounded-lg px-2.5 py-1.5 text-sm text-nova-text-muted transition-colors hover:text-nova-text hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-nova-violet focus-visible:outline-none cursor-pointer"
			>
				<Icon icon={tablerUsers} width="16" height="16" className="shrink-0" />
				<span className="truncate font-medium">{active.name}</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0"
				/>
			</Popover.Trigger>

			<Popover.Portal>
				<Popover.Positioner
					side="bottom"
					align="start"
					sideOffset={6}
					className={POPOVER_POSITIONER_GLASS_CLS}
				>
					<Popover.Popup className={POPOVER_POPUP_CLS}>
						<div style={{ minWidth: "248px" }}>
							<div className="px-3 pt-2.5 pb-1.5 text-xs font-medium uppercase tracking-wide text-nova-text-muted">
								Projects
							</div>
							<div className="max-h-[280px] overflow-y-auto">
								{projects.map((p) => {
									const isActive = p.id === active.id;
									return (
										<button
											key={p.id}
											type="button"
											disabled={busy}
											onClick={() => switchTo(p.id)}
											className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nova-text not-disabled:hover:bg-white/[0.06] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
										>
											<span className="flex-1 text-left truncate font-medium">
												{p.name}
											</span>
											{isActive && (
												<Icon
													icon={tablerCheck}
													width="16"
													height="16"
													className="shrink-0 text-nova-violet-bright"
												/>
											)}
										</button>
									);
								})}
							</div>

							<div className="border-t border-white/[0.06]" />

							{creating ? (
								<div className="p-2.5">
									<input
										// Focus on mount via a callback ref (the `autoFocus`
										// attribute is disallowed) — opening the create form is
										// a deliberate click, so jumping the cursor in is wanted.
										ref={(el) => el?.focus()}
										autoComplete="off"
										data-1p-ignore
										value={newName}
										onChange={(e) => setNewName(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") createProject();
											if (e.key === "Escape") setCreating(false);
										}}
										placeholder="Project name"
										maxLength={64}
										className="w-full rounded-lg border border-nova-border bg-nova-void px-2.5 py-1.5 text-sm text-nova-text placeholder:text-nova-text-muted focus-visible:ring-2 focus-visible:ring-nova-violet focus-visible:outline-none"
									/>
									<div className="mt-2 flex items-center justify-end gap-2">
										<button
											type="button"
											onClick={() => setCreating(false)}
											className="rounded-lg px-2.5 py-1.5 text-sm text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
										>
											Cancel
										</button>
										<button
											type="button"
											disabled={!newName.trim() || busy}
											onClick={createProject}
											className="rounded-lg bg-nova-action px-2.5 py-1.5 text-sm font-medium text-white not-disabled:hover:bg-nova-action-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
										>
											Create
										</button>
									</div>
								</div>
							) : (
								<button
									type="button"
									onClick={() => setCreating(true)}
									className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer"
								>
									<Icon
										icon={tablerPlus}
										width="16"
										height="16"
										className="text-nova-text-muted"
									/>
									New Project
								</button>
							)}

							<Link
								href="/project"
								onClick={() => setOpen(false)}
								className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer rounded-b-xl"
							>
								<Icon
									icon={tablerSettings}
									width="16"
									height="16"
									className="text-nova-text-muted"
								/>
								Project settings
							</Link>
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
