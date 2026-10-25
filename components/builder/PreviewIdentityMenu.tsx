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
 * It also opens recorded test journeys, which do not change this session's
 * identity or its live records.
 *
 * The same menu chooses where Preview runs (Runs on): Web Apps or Android,
 * one platform the app declares at a time. A platform the app does not
 * declare is shown disabled with the reason, never hidden. The trigger's
 * icon is the platform's glyph, so the header band still fits at 320px
 * without a control of its own.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerBrowser from "@iconify-icons/tabler/browser";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerDeviceMobile from "@iconify-icons/tabler/device-mobile";
import { useState } from "react";
import { AppTestHistory } from "@/components/builder/AppTestHistory";
import { usePreviewModeTransition } from "@/components/builder/usePreviewModeTransition";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import { useWorkerReadiness } from "@/lib/doc/hooks/useWorkerReadiness";
import { asUuid } from "@/lib/domain";
import {
	declaredPlatforms,
	inPlatform,
	PLATFORM_LABELS,
	PLATFORMS,
	type Platform,
	platformDeclarationPhrase,
} from "@/lib/domain/platforms";
import { useNavigate } from "@/lib/routing/hooks";
import {
	useAppId,
	usePreviewing,
	usePreviewPersonaUuid,
	usePreviewPlatform,
	useSetPreviewing,
	useSetPreviewPersonaUuid,
	useSetPreviewPlatform,
} from "@/lib/session/hooks";

const AS_ME = "Preview as me";

/** Each platform's glyph and the line under its name in Runs on. */
const PLATFORM_CHOICES: Readonly<
	Record<
		Platform,
		{ readonly icon: typeof tablerBrowser; readonly line: string }
	>
> = {
	"web-apps": {
		icon: tablerBrowser,
		line: "The browser app on CommCare HQ",
	},
	android: {
		icon: tablerDeviceMobile,
		line: "The CommCare app on a phone or tablet",
	},
};

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
	const appId = useAppId();
	const [showTests, setShowTests] = useState(false);
	const readiness = useWorkerReadiness();
	const personas = readiness.personas;
	const selected = usePreviewPersonaUuid();
	const setSelected = useSetPreviewPersonaUuid();
	const navigate = useNavigate();
	const setPreviewing = useSetPreviewing();
	const changePreview = usePreviewModeTransition(setPreviewing);
	const appSettings = useAppSettings();
	const declared = declaredPlatforms({ appSettings });
	const platform = usePreviewPlatform();
	const setPlatform = useSetPreviewPlatform();

	const active =
		selected === undefined
			? undefined
			: personas.find((p) => p.uuid === selected);
	const currentLabel =
		selected === undefined
			? AS_ME
			: (active?.name ?? "Selected persona unavailable");

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label={`Running as ${currentLabel} ${inPlatform(platform)}. Change who Preview runs as or where.`}
					render={
						<Button
							type="button"
							variant="ghost"
							className="transition-colors max-w-52 max-sm:max-w-28 max-sm:gap-1 max-sm:px-2"
						/>
					}
				>
					<Icon
						icon={PLATFORM_CHOICES[platform].icon}
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
					<DropdownMenuGroup>
						<DropdownMenuLabel>Runs on</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={platform}
							onValueChange={(value) => {
								const chosen = PLATFORMS.find((each) => each === value);
								if (chosen === undefined || chosen === platform) return;
								setPlatform(chosen);
								// The other platform's screens start again from app entry.
								navigate.replace({ kind: "home" });
							}}
						>
							{PLATFORMS.map((each) => {
								const runsThere = declared.includes(each);
								return (
									<DropdownMenuRadioItem
										key={each}
										value={each}
										disabled={!runsThere}
										closeOnClick
									>
										<span className="flex min-w-0 flex-col">
											<span className="truncate">{PLATFORM_LABELS[each]}</span>
											<span className="text-xs text-nova-text-muted">
												{runsThere
													? PLATFORM_CHOICES[each].line
													: `This app runs ${platformDeclarationPhrase(declared)}`}
											</span>
										</span>
									</DropdownMenuRadioItem>
								);
							})}
						</DropdownMenuRadioGroup>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuLabel>Running as</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={selected ?? ""}
							onValueChange={(value) => {
								if (value === (selected ?? "")) return;
								setSelected(value.length === 0 ? undefined : asUuid(value));
								// A prior worker's open form is not the new worker's entry.
								navigate.replace({ kind: "home" });
							}}
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
										<span className="truncate">
											Selected persona unavailable
										</span>
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
									<span className="flex min-w-0 flex-col">
										<span className="truncate">Preview as {persona.name}</span>
										{persona.locationContext === "no-assigned-place" && (
											<span className="text-xs text-nova-text-muted">
												No place assigned
											</span>
										)}
									</span>
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
						{appId ? (
							<DropdownMenuItem onClick={() => setShowTests(true)}>
								Test journeys
							</DropdownMenuItem>
						) : null}
						{personas.length === 0 && (
							<DropdownMenuItem
								onClick={() => {
									changePreview(false);
									navigate.openAppSetup("users");
								}}
							>
								<span className="flex min-w-0 flex-col">
									<span className="truncate">Add a persona</span>
									<span className="text-xs text-nova-text-muted">
										Name a worker in App setup to preview as them.
									</span>
								</span>
							</DropdownMenuItem>
						)}
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			{appId ? (
				<AppTestHistory
					appId={appId}
					open={showTests}
					onOpenChange={setShowTests}
				/>
			) : null}
		</>
	);
}
