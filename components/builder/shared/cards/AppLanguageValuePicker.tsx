// components/builder/shared/cards/AppLanguageValuePicker.tsx
//
// The value an "App language" read is compared with: one of the app's own
// languages, stored as its CommCare wire code. The session holds the wire
// code (`localization.wireCodes`), which no author chooses and few know, so
// the comparison offers each language by its name and writes its code, as
// `CaseTypeValuePicker` offers a case type. A legacy English-only app (no
// stored `localization`) offers its one language with the code `en`.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerLanguage from "@iconify-icons/tabler/language";
import { useRef } from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { useAppLocalization } from "@/lib/doc/hooks/useLocalization";
import { effectiveAppLocalization } from "@/lib/domain";
import { languageDisplayLabel } from "@/lib/domain/languageRegistry";
import { platformPickerLine } from "@/lib/domain/platforms";
import type { ExpressionChangeAdmission } from "../editorContext";

interface AppLanguageValuePickerProps {
	/** The stored wire code, or undefined while none is chosen. */
	readonly value: string | undefined;
	readonly onChange: (wireCode: string) => void;
	/** Whole-rule verdict for one choice. */
	readonly admit?: (wireCode: string) => ExpressionChangeAdmission;
	readonly invalid?: boolean;
}

export function AppLanguageValuePicker({
	value,
	onChange,
	admit,
	invalid = false,
}: AppLanguageValuePickerProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const localization = effectiveAppLocalization(useAppLocalization());
	const languages = localization.languageOrder.map((tag) => ({
		tag,
		code: localization.wireCodes[tag] ?? tag,
		name: languageDisplayLabel(tag) ?? tag,
	}));
	const chosen = languages.find((language) => language.code === value);
	const label =
		value === undefined || value === ""
			? "Choose a language"
			: (chosen?.name ?? `Language code ${value}`);
	const triggerClass = [
		"group min-h-11 w-full justify-between rounded-lg border bg-nova-deep/50 px-3 text-sm text-nova-text dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50",
		invalid
			? "border-nova-rose/40"
			: "border-white/[0.06] not-disabled:hover:border-nova-violet/30",
	].join(" ");

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				aria-label={`Language to compare with: ${label}`}
				aria-invalid={invalid || undefined}
				render={
					<Button type="button" variant="outline" className={triggerClass} />
				}
			>
				<span className="flex min-w-0 items-center gap-1.5">
					<Icon
						icon={tablerLanguage}
						width="14"
						height="14"
						className={
							chosen !== undefined
								? "text-nova-violet-bright"
								: "text-nova-text-muted"
						}
					/>
					<span
						className={`break-words ${chosen !== undefined ? "text-nova-violet-bright" : "text-nova-text-muted"}`}
					>
						{label}
					</span>
				</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuPortal>
				<DropdownMenuPositioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					style={{ minWidth: "var(--anchor-width)", maxHeight: 360 }}
				>
					<DropdownMenuPopup className="max-h-80 min-w-0 overflow-y-auto">
						{languages.map((language) => {
							const isActive = language.code === value;
							const verdict = admit?.(language.code) ?? {
								admitted: true as const,
							};
							return (
								<DropdownMenuItem
									key={language.tag}
									disabled={!verdict.admitted}
									onClick={() => onChange(language.code)}
									className={
										isActive ? "bg-nova-violet/10 text-nova-violet-bright" : ""
									}
								>
									<span className="min-w-0 flex-1 text-left">
										<span className="block break-words">{language.name}</span>
										<span className="block break-words text-xs text-nova-text-muted">
											{verdict.admitted === false
												? verdict.platform !== undefined
													? platformPickerLine(verdict.platform)
													: verdict.reason
												: `Code ${language.code}`}
										</span>
									</span>
									{isActive && (
										<Icon
											icon={tablerCheck}
											width="14"
											height="14"
											className="shrink-0 text-nova-violet-bright"
										/>
									)}
								</DropdownMenuItem>
							);
						})}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}
