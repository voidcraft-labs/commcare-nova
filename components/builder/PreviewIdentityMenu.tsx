/**
 * Who Preview is running as.
 *
 * Two modes, never blended: **Preview as me** signs in as the member at
 * the keyboard, **Preview as <persona>** signs in as that named worker.
 * The control always names the current one, because a running app that
 * does not say whose session it is showing is a trap: an owner-scoped
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
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { usePersonas } from "@/lib/doc/hooks/useUserCollections";
import { asUuid } from "@/lib/domain";
import { useNavigate } from "@/lib/routing/hooks";
import {
	usePreviewing,
	usePreviewPersonaUuid,
	useSetPreviewPersonaUuid,
} from "@/lib/session/hooks";

const AS_ME = "Preview as me";

/**
 * The Preview gate is its own component so the body's subscriptions:
 * the persona list, the selection, the router: only exist while the
 * control does. The header is mounted for the whole session, and it has
 * no business re-rendering on every blueprint edit for a menu that is
 * invisible the entire time the author is editing.
 */
export function PreviewIdentityMenu() {
	const previewing = usePreviewing();
	if (!previewing) return null;
	return <PreviewIdentityMenuBody />;
}

function PreviewIdentityMenuBody() {
	const personas = usePersonas();
	const selected = usePreviewPersonaUuid();
	const setSelected = useSetPreviewPersonaUuid();
	const navigate = useNavigate();

	const active =
		selected === undefined
			? undefined
			: personas.find((p) => p.uuid === selected);
	const currentLabel =
		selected === undefined
			? AS_ME
			: (active?.name ?? "Selected persona unavailable");

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`Running as ${currentLabel}. Change who Preview runs as.`}
				render={
					<Button
						type="button"
						variant="ghost"
						className="max-w-52 gap-1.5 px-2.5 text-[13px] font-medium text-nova-text-muted hover:bg-white/[0.05] hover:text-nova-text"
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
				<DropdownMenuRadioGroup
					value={selected ?? ""}
					onValueChange={(value) =>
						setSelected(value.length === 0 ? undefined : asUuid(value))
					}
				>
					<DropdownMenuRadioItem value="" closeOnClick>
						<span className="flex min-w-0 flex-col">
							<span className="truncate">{AS_ME}</span>
							<span className="text-xs text-nova-text-muted">
								Your own account, with no worker information.
							</span>
						</span>
					</DropdownMenuRadioItem>
					{active === undefined && selected !== undefined && (
						<DropdownMenuRadioItem value={selected} disabled>
							<span className="flex min-w-0 flex-col">
								<span className="truncate">Selected persona unavailable</span>
								<span className="text-xs text-nova-text-muted">
									Choose yourself or another persona to continue.
								</span>
							</span>
						</DropdownMenuRadioItem>
					)}
					{personas.map((persona) => (
						<DropdownMenuRadioItem
							key={persona.uuid}
							value={persona.uuid}
							closeOnClick
						>
							<span className="min-w-0 truncate">
								Preview as {persona.name}
							</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
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
