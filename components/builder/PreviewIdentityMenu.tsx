/**
 * Who Preview is running as.
 *
 * Two modes, never blended: **Preview as me** signs in as the member at
 * the keyboard, **Preview as <persona>** signs in as that named worker.
 * The control always names the current one, because a running app that
 * does not say whose session it is showing is a trap — an owner-scoped
 * case list looks broken rather than correct.
 *
 * It appears only in Preview. In edit mode there is no session to be in,
 * and offering the choice there would suggest authoring changes with it.
 * With no personas authored the control stays out of the way entirely:
 * there is only one identity, and the app already runs as it.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerUserCircle from "@iconify-icons/tabler/user-circle";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { usePersonas } from "@/lib/doc/hooks/useUserCollections";
import { useNavigate } from "@/lib/routing/hooks";
import {
	usePreviewing,
	usePreviewPersonaUuid,
	useSetPreviewPersonaUuid,
} from "@/lib/session/hooks";

const AS_ME = "Preview as me";

export function PreviewIdentityMenu() {
	const previewing = usePreviewing();
	const personas = usePersonas();
	const selected = usePreviewPersonaUuid();
	const setSelected = useSetPreviewPersonaUuid();
	const navigate = useNavigate();

	if (!previewing) return null;

	const active =
		selected === undefined
			? undefined
			: personas.find((p) => p.uuid === selected);
	const currentLabel = active?.name ?? AS_ME;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`Running as ${currentLabel}. Change who Preview runs as.`}
				render={
					<Button
						type="button"
						variant="ghost"
						size="lg"
						className="h-11 max-w-52 gap-1.5 px-2.5 text-[13px] font-medium text-nova-text-muted hover:bg-white/[0.05] hover:text-nova-text"
					/>
				}
			>
				<Icon
					icon={tablerUserCircle}
					width="17"
					height="17"
					aria-hidden="true"
					className="shrink-0"
				/>
				<span className="truncate">{currentLabel}</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					aria-hidden="true"
					className="shrink-0"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent sideOffset={8} preferredMinWidth={240}>
				<DropdownMenuItem onClick={() => setSelected(undefined)}>
					<span className="flex min-w-0 flex-col">
						<span className="truncate">{AS_ME}</span>
						<span className="text-xs text-nova-text-muted">
							Your own account, with no worker information.
						</span>
					</span>
				</DropdownMenuItem>
				{personas.map((persona) => (
					<DropdownMenuItem
						key={persona.uuid}
						onClick={() => setSelected(persona.uuid)}
					>
						<span className="min-w-0 truncate">Preview as {persona.name}</span>
					</DropdownMenuItem>
				))}
				{personas.length === 0 && (
					<DropdownMenuItem onClick={() => navigate.openAppSetup("users")}>
						<span className="flex min-w-0 flex-col">
							<span className="truncate">Add a persona</span>
							<span className="text-xs text-nova-text-muted">
								Name a worker in App setup to preview as them.
							</span>
						</span>
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
