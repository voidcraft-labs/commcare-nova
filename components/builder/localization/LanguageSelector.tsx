"use client";

import { Icon } from "@iconify/react/offline";
import tablerLanguage from "@iconify-icons/tabler/language";
import tablerSettings from "@iconify-icons/tabler/settings";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { useNavigate } from "@/lib/routing/hooks";
import { useBuilderLanguage } from "./BuilderLocalizationProvider";

export function LanguageSelector() {
	const state = useBuilderLanguage();
	const navigate = useNavigate();
	const selected = state.languages.find(
		(language) => language.code === state.language,
	);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`Worker language: ${selected?.name ?? state.language}`}
				className="nova-focusable flex h-11 max-w-48 items-center gap-2 rounded-xl px-3 text-sm text-nova-text outline-none transition-colors hover:bg-white/5"
			>
				<Icon icon={tablerLanguage} width="18" height="18" aria-hidden="true" />
				<span className="max-w-28 truncate">
					{selected?.name ?? state.language}
				</span>
				<span className="text-[10px] font-semibold uppercase tracking-wide text-nova-text-muted">
					{state.language}
				</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="center"
				sideOffset={6}
				preferredMinWidth="14rem"
			>
				<DropdownMenuLabel>Worker content language</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={state.language}
					onValueChange={(value) => state.selectLanguage(value)}
				>
					{state.languages.map((language) => (
						<DropdownMenuRadioItem
							key={language.code}
							value={language.code}
							closeOnClick
						>
							<span className="min-w-0 flex-1 truncate">{language.name}</span>
							<span className="text-[11px] uppercase text-nova-text-muted">
								{language.code}
							</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={() => navigate.openAppSetup("languages")}>
					<Icon
						icon={tablerSettings}
						width="17"
						height="17"
						aria-hidden="true"
					/>
					Manage languages
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
