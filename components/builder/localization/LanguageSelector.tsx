"use client";

import { Icon } from "@iconify/react/offline";
import tablerLanguage from "@iconify-icons/tabler/language";
import tablerSettings from "@iconify-icons/tabler/settings";
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
import { Skeleton } from "@/components/shadcn/skeleton";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type { AppLanguageIdentity, LanguageTag } from "@/lib/domain";
import {
	languageDirection,
	languageDisplayLabel,
	languageEnglishName,
	languageQualifierLabels,
} from "@/lib/domain/languageRegistry";
import { useNavigate } from "@/lib/routing/hooks";
import { useBuilderLanguage } from "./BuilderLocalizationProvider";
import { useLanguageRegistrySearch } from "./useLanguageRegistrySearch";

interface SelectorRow {
	readonly tag: LanguageTag;
	readonly identity: AppLanguageIdentity;
	/** Endonym-first label; undefined while the full registry chunk loads. */
	readonly label: string | undefined;
	/** Full English qualified name, for the tooltip and accessible name. */
	readonly englishName: string | undefined;
	readonly direction: "ltr" | "rtl";
	/**
	 * The muted disambiguator, present only when the identity carries
	 * qualifiers or shares its language axis with another app language.
	 */
	readonly qualifier: string | undefined;
}

export function LanguageSelector() {
	const state = useBuilderLanguage();
	const navigate = useNavigate();

	// The baked common set labels most languages statically; the full registry
	// chunk loads only when an app language falls outside it.
	const needsResolver = state.languages.some(
		({ identity }) =>
			languageDisplayLabel(identity) === undefined ||
			languageEnglishName(identity) === undefined,
	);
	const resolver = useLanguageRegistrySearch(needsResolver).data;

	const axisCounts = new Map<string, number>();
	for (const { identity } of state.languages) {
		axisCounts.set(
			identity.language,
			(axisCounts.get(identity.language) ?? 0) + 1,
		);
	}
	const rows: SelectorRow[] = state.languages.map(({ tag, identity }) => {
		const qualifiers = languageQualifierLabels(identity);
		const sharesAxis = (axisCounts.get(identity.language) ?? 0) > 1;
		return {
			tag,
			identity,
			label:
				languageDisplayLabel(identity) ??
				resolver?.resolvedLanguageDisplayLabel(identity),
			englishName:
				languageEnglishName(identity) ??
				resolver?.resolvedLanguageEnglishName(identity),
			direction: languageDirection(identity),
			qualifier:
				qualifiers.length > 0
					? qualifiers.join(", ")
					: sharesAxis
						? "General"
						: undefined,
		};
	});
	const selected = rows.find((row) => row.tag === state.language) ?? rows[0];
	const selectedAccessibleName =
		selected?.englishName ?? selected?.label ?? "current language";

	return (
		<DropdownMenu>
			<SimpleTooltip content={selected?.englishName} side="bottom">
				<DropdownMenuTrigger
					aria-label={`Worker language: ${selectedAccessibleName}`}
					className="nova-focusable flex h-11 max-w-48 items-center gap-2 rounded-xl px-3 text-sm text-nova-text outline-none transition-colors hover:bg-white/5"
				>
					<Icon
						icon={tablerLanguage}
						width="18"
						height="18"
						aria-hidden="true"
					/>
					{selected?.label === undefined ? (
						<Skeleton className="h-4 w-16" />
					) : (
						<bdi dir={selected.direction} className="max-w-28 truncate">
							{selected.label}
						</bdi>
					)}
					{selected?.qualifier !== undefined && (
						<span className="max-w-24 truncate text-xs text-nova-text-muted">
							· {selected.qualifier}
						</span>
					)}
				</DropdownMenuTrigger>
			</SimpleTooltip>
			<DropdownMenuContent
				align="center"
				sideOffset={6}
				preferredMinWidth="14rem"
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>Language workers see</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuRadioGroup
					value={state.language}
					onValueChange={(value) => state.selectLanguage(value)}
				>
					{rows.map((row) => (
						<DropdownMenuRadioItem key={row.tag} value={row.tag} closeOnClick>
							<span className="flex min-w-0 flex-1 flex-col">
								{row.label === undefined ? (
									<Skeleton className="h-4 w-24" />
								) : (
									<bdi dir={row.direction} className="truncate">
										{row.label}
									</bdi>
								)}
								{row.qualifier !== undefined && (
									<span className="truncate text-xs text-nova-text-muted">
										{row.qualifier}
									</span>
								)}
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
