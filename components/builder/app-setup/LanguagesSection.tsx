"use client";

import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useEffect, useMemo, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/shadcn/alert-dialog";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/shadcn/dialog";
import { Field, FieldLabel } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { Skeleton } from "@/components/shadcn/skeleton";
import { Textarea } from "@/components/shadcn/textarea";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	type AppLanguageIdentity,
	canonicalProseTemplate,
	collectLocalizedTranslationUnits,
	collectTranslationCoverageDiagnostics,
	effectiveAppLocalization,
	fieldRegistry,
	type LanguageDirection,
	type LanguageTag,
	type LocalizedTranslationUnit,
	type LocalizedValue,
	type ProsePart,
	type ProseReferencePart,
	type ProseTemplate,
	parseLanguageTag,
	projectProseTemplate,
	resolveAppLanguage,
	type TranslationCoverageDiagnosticCode,
	type TranslationStatus,
	type TranslationUnitRole,
} from "@/lib/domain";
import {
	languageDirection,
	languageDisplayLabel,
	languageEnglishName,
} from "@/lib/domain/languageRegistry";
import type { LanguageRegistrySearch } from "@/lib/domain/languageRegistry/load";
import { useNavigate } from "@/lib/routing/hooks";
import { automaticTranslationCapability } from "@/lib/translation/capabilityPolicy";
import { cn } from "@/lib/utils";
import {
	useBuilderLanguage,
	useTranslationUnitEditor,
} from "../localization/BuilderLocalizationProvider";
import { useLanguageRegistrySearch } from "../localization/useLanguageRegistrySearch";
import { LanguagePickerFields } from "./languagePicker/LanguagePickerFields";
import {
	duplicateLanguageRefusal,
	EMPTY_LANGUAGE_CHOICE,
	type LanguagePickerChoice,
	resolvedLanguageSelection,
} from "./languagePicker/pickerModel";

const STATUS_LABELS: Readonly<Record<TranslationStatus, string>> = {
	missing: "Missing",
	"needs-review": "Needs review",
	"out-of-date": "Out of date",
	ready: "Ready",
};

const STATUS_VARIANTS: Readonly<
	Record<TranslationStatus, "muted" | "amber" | "rose" | "emerald">
> = {
	missing: "muted",
	"needs-review": "amber",
	"out-of-date": "rose",
	ready: "emerald",
};

type TranslationStatusFilter = TranslationStatus | "all";

/* The Select root's `items` map is what lets a bare <SelectValue /> render
 * the label; without it Base UI falls back to the raw stored value. */
const STATUS_FILTER_ITEMS: Readonly<Record<TranslationStatusFilter, string>> = {
	all: "All statuses",
	...STATUS_LABELS,
};

const ROLE_LABELS: Readonly<Record<TranslationUnitRole, string>> = {
	"app-name": "App name",
	"module-name": "Module name",
	"form-name": "Form name",
	"field-label": "Field label",
	"field-hint": "Field hint",
	"field-help": "Field help",
	"field-validation-message": "Validation message",
	"select-option-label": "Option label",
	"case-list-header": "Case list header",
	"case-list-mapping-label": "Case list value label",
	"case-list-interval-text": "Case list interval text",
	"search-input-label": "Search field label",
	"search-screen-title": "Search screen title",
	"search-screen-subtitle": "Search screen subtitle",
	"search-button-label": "Search button label",
	"search-runtime-validation-message": "Search validation message",
	"case-property-option-label": "Case property option label",
};

/* What one affected thing is called, per coverage diagnostic: the counts mean
 * different things (fields, forms, files, automations) and a generic word
 * would hide that. */
const COVERAGE_COUNT_NOUNS: Readonly<
	Record<TranslationCoverageDiagnosticCode, readonly [string, string]>
> = {
	"lookup-labels-need-localized-data": ["field", "fields"],
	"connect-text-has-no-locale-carrier": ["form", "forms"],
	"media-is-shared-across-locales": ["file", "files"],
	"automation-language-is-recipient-owned": ["automation", "automations"],
};

function coverageCounts(units: readonly LocalizedTranslationUnit[]) {
	const counts: Record<TranslationStatus, number> = {
		missing: 0,
		"needs-review": 0,
		"out-of-date": 0,
		ready: 0,
	};
	for (const unit of units) counts[unit.status] += 1;
	return counts;
}

function firstRefusal(
	outcome: { ok: true } | { ok: false; messages: string[] },
): string | undefined {
	return outcome.ok
		? undefined
		: outcome.messages[0] || "That change was refused.";
}

/**
 * One app language's derived display facts. `label` and `englishName` are
 * undefined only for a language outside the baked common set while the full
 * registry chunk is still loading; a code is never the fallback.
 */
interface LanguageDisplay {
	readonly tag: LanguageTag;
	readonly identity: AppLanguageIdentity;
	readonly label: string | undefined;
	readonly englishName: string | undefined;
	readonly direction: LanguageDirection;
	readonly directionWord: "left to right" | "right to left";
}

function languageDisplay(
	tag: LanguageTag,
	resolver: LanguageRegistrySearch | undefined,
): LanguageDisplay {
	const identity = parseLanguageTag(tag);
	const direction = languageDirection(identity);
	return {
		tag,
		identity,
		label:
			languageDisplayLabel(identity) ??
			resolver?.resolvedLanguageDisplayLabel(identity),
		englishName:
			languageEnglishName(identity) ??
			resolver?.resolvedLanguageEnglishName(identity),
		direction,
		directionWord: direction === "rtl" ? "right to left" : "left to right",
	};
}

/** The worker-facing name, or a placeholder while its registry chunk loads. */
function LanguageName({
	display,
	className,
}: {
	readonly display: LanguageDisplay;
	readonly className?: string;
}) {
	if (display.label === undefined) {
		return (
			<Skeleton
				className={cn("inline-block h-4 w-20 align-middle", className)}
			/>
		);
	}
	return (
		<bdi dir={display.direction} className={className}>
			{display.label}
		</bdi>
	);
}

export function LanguagesSection() {
	const doc = useBlueprintDoc((value) => value);
	const localization = effectiveAppLocalization(doc.localization);
	const languageState = useBuilderLanguage();
	const { inline } = useBlueprintMutations();
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState<TranslationStatusFilter>("all");
	const [message, setMessage] = useState<string>();
	const selectedTag = resolveAppLanguage(
		doc.localization,
		languageState.language,
	);
	const isSource = selectedTag === localization.sourceLanguage;

	// The baked common set labels most languages statically; the full registry
	// chunk loads only when an app language falls outside it.
	const needsResolver = localization.languageOrder.some(
		(tag) =>
			languageDisplayLabel(tag) === undefined ||
			languageEnglishName(tag) === undefined,
	);
	const resolver = useLanguageRegistrySearch(needsResolver).data;
	const displays = useMemo(
		() =>
			new Map(
				localization.languageOrder.map((tag) => [
					tag,
					languageDisplay(tag, resolver),
				]),
			),
		[localization.languageOrder, resolver],
	);
	const selectedDisplay =
		displays.get(selectedTag) ?? languageDisplay(selectedTag, resolver);
	const sourceDisplay =
		displays.get(localization.sourceLanguage) ??
		languageDisplay(localization.sourceLanguage, resolver);
	const sourceName =
		sourceDisplay.englishName ?? sourceDisplay.label ?? "the source language";
	const selectedName =
		selectedDisplay.englishName ?? selectedDisplay.label ?? "this language";

	const automaticTranslation = isSource
		? null
		: automaticTranslationCapability(
				sourceDisplay.identity,
				selectedDisplay.identity,
			);
	const selectedUnits = useMemo(
		() => collectLocalizedTranslationUnits(doc, selectedTag),
		[doc, selectedTag],
	);
	const coverageDiagnostics = useMemo(
		() => collectTranslationCoverageDiagnostics(doc),
		[doc],
	);
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const visibleUnits = selectedUnits.filter((unit) => {
		if (status !== "all" && unit.status !== status) return false;
		if (normalizedQuery === "") return true;
		return `${unit.breadcrumb.join(" ")} ${unit.role} ${ROLE_LABELS[unit.role]} ${JSON.stringify(unit.source)} ${JSON.stringify(unit.effective)} ${JSON.stringify(unit.explicit?.value ?? null)}`
			.toLocaleLowerCase()
			.includes(normalizedQuery);
	});

	const commit = (mutations: Mutation[]) => {
		const refusal = firstRefusal(inline.commitMany(mutations));
		setMessage(refusal);
		return refusal === undefined;
	};

	return (
		<section aria-labelledby="languages-heading" className="space-y-7">
			<header>
				{/* Named by the breadcrumb and the selected tab already, both within
				    135px and near-identical in colour and weight. Kept as the
				    section's accessible name, dropped from the eye, matching every
				    other App setup section. */}
				<h2 id="languages-heading" className="sr-only">
					Languages
				</h2>
				<p className="text-sm leading-relaxed text-nova-text-secondary">
					Add the languages your workers speak, then translate everything they
					see in one place. Anything you haven't translated yet shows the
					original text, so your app always works.
				</p>
			</header>

			<div>
				<div className="grid gap-3 @xl:grid-cols-2">
					{localization.languageOrder.map((tag) => {
						const display = displays.get(tag) ?? languageDisplay(tag, resolver);
						const units = collectLocalizedTranslationUnits(doc, tag);
						const counts = coverageCounts(units);
						const source = tag === localization.sourceLanguage;
						const active = tag === selectedTag;
						const metaSegments = [
							...(display.englishName !== undefined &&
							display.englishName !== display.label
								? [display.englishName]
								: []),
							display.directionWord,
						];
						return (
							<article
								key={tag}
								className={`rounded-xl border p-4 transition-colors ${
									active
										? "border-nova-violet/50 bg-nova-violet/[0.08]"
										: "border-nova-border bg-white/[0.025]"
								}`}
							>
								<div className="flex items-start justify-between gap-3">
									<button
										type="button"
										className="nova-focusable min-w-0 rounded-lg text-left"
										aria-pressed={active}
										onClick={() => languageState.selectLanguage(tag)}
									>
										<span className="block truncate font-medium text-nova-text">
											<LanguageName display={display} />
										</span>
										<span className="mt-0.5 block truncate text-xs text-nova-text-muted">
											{metaSegments.join(" · ")}
										</span>
									</button>
									<div className="flex flex-wrap justify-end gap-1.5">
										{source && <Badge variant="violet">Source</Badge>}
										{tag === localization.defaultLanguage && (
											<Badge variant="emerald">Default</Badge>
										)}
									</div>
								</div>
								{source ? (
									<p className="mt-4 text-xs text-nova-text-muted">
										{units.length} {units.length === 1 ? "phrase" : "phrases"}
									</p>
								) : (
									<div className="mt-4 flex flex-wrap gap-1.5">
										{units.length === 0 ? (
											<Badge>No phrases yet</Badge>
										) : counts.ready === units.length ? (
											<Badge variant="emerald">All {units.length} ready</Badge>
										) : (
											<>
												{counts.ready > 0 && (
													<Badge variant="emerald">{counts.ready} ready</Badge>
												)}
												{counts["needs-review"] > 0 && (
													<Badge variant="amber">
														{counts["needs-review"]} to review
													</Badge>
												)}
												{counts["out-of-date"] > 0 && (
													<Badge variant="rose">
														{counts["out-of-date"]} out of date
													</Badge>
												)}
												{counts.missing > 0 && (
													<Badge>{counts.missing} missing</Badge>
												)}
											</>
										)}
									</div>
								)}
								<div className="mt-4 flex flex-wrap gap-2">
									{source && localization.languageOrder.length === 1 && (
										<ChangeLanguageDialog currentTag={tag} onCommit={commit} />
									)}
									{tag !== localization.defaultLanguage && (
										<Button
											type="button"
											variant="ghost"
											onClick={() =>
												commit([{ kind: "setDefaultLanguage", code: tag }])
											}
										>
											Make default
										</Button>
									)}
									{!source && tag !== localization.defaultLanguage && (
										<RemoveLanguageDialog
											display={display}
											onRemove={() => {
												if (commit([{ kind: "removeLanguage", code: tag }])) {
													languageState.selectLanguage(
														localization.defaultLanguage,
													);
												}
											}}
										/>
									)}
								</div>
							</article>
						);
					})}
				</div>
				<AddLanguageDialog
					doc={doc}
					languages={localization.languageOrder.map(
						(tag) => displays.get(tag) ?? languageDisplay(tag, resolver),
					)}
					onCommit={commit}
					onAdded={languageState.selectLanguage}
				/>
			</div>

			{coverageDiagnostics.length > 0 && (
				<section
					aria-labelledby="language-coverage-notes"
					className="space-y-3"
				>
					<div>
						<h3
							id="language-coverage-notes"
							className="font-display text-lg font-semibold tracking-tight text-nova-text"
						>
							Good to know
						</h3>
						<p className="mt-1 text-sm text-nova-text-secondary">
							A few parts of your app handle languages their own way, so they
							aren't translated here. Everything still works as expected.
						</p>
					</div>
					<div className="space-y-3">
						{coverageDiagnostics.map((diagnostic) => (
							<article
								key={diagnostic.code}
								className="rounded-xl border border-nova-amber/25 bg-nova-amber/[0.05] p-4"
							>
								<p className="font-medium text-nova-text">{diagnostic.title}</p>
								<p className="mt-1 text-sm leading-relaxed text-nova-text-secondary">
									{diagnostic.explanation}
								</p>
								<p className="mt-2 text-xs text-nova-text-muted">
									Affects {diagnostic.affectedCount}{" "}
									{
										COVERAGE_COUNT_NOUNS[diagnostic.code][
											diagnostic.affectedCount === 1 ? 0 : 1
										]
									}
								</p>
							</article>
						))}
					</div>
				</section>
			)}

			{message !== undefined && (
				<p role="alert" className="text-sm text-nova-rose">
					{message}
				</p>
			)}

			<div className="border-t border-nova-border pt-7">
				<div className="space-y-4">
					<div>
						<h3 className="font-display text-lg font-semibold tracking-tight text-nova-text">
							<LanguageName display={selectedDisplay} /> phrases
						</h3>
						<p className="mt-1 max-w-2xl text-sm text-nova-text-secondary">
							{isSource
								? "Every phrase workers see in your app, all in one place. To change one, open it in the Builder."
								: automaticTranslation?.status === "available"
									? `Translate each phrase by hand, or ask Nova to translate from ${sourceName} to ${selectedName} for you. Automatic translations start as Needs review so you get the final say.`
									: `Translate each phrase by hand. ${automaticTranslation?.explanation ?? "Automatic translation isn't available for this pair of languages."}`}
						</p>
					</div>
					<div className="flex flex-col gap-2 @md:flex-row">
						<div className="relative min-w-64 @md:flex-1">
							<Icon
								icon={tablerSearch}
								width="16"
								height="16"
								className="pointer-events-none absolute left-3.5 top-3.5 text-nova-text-muted"
							/>
							<Input
								value={query}
								aria-label="Search phrases"
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Search phrases or where they appear"
								className="pl-10"
							/>
						</div>
						<Select
							items={STATUS_FILTER_ITEMS}
							value={status}
							onValueChange={(value) =>
								value !== null && setStatus(value as TranslationStatusFilter)
							}
						>
							<SelectTrigger aria-label="Filter by status" className="w-44">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(STATUS_FILTER_ITEMS).map(([value, label]) => (
									<SelectItem key={value} value={value}>
										{label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>

				<p className="mt-4 text-xs text-nova-text-muted">
					Showing {visibleUnits.length} of {selectedUnits.length}{" "}
					{selectedUnits.length === 1 ? "phrase" : "phrases"}
				</p>
				<div className="mt-3 space-y-3">
					{visibleUnits.map((unit) => (
						<TranslationUnitRow
							key={`${selectedTag}:${unit.id}:${unit.sourceFingerprint}:${JSON.stringify(unit.explicit ?? null)}`}
							doc={doc}
							unit={unit}
							isSource={isSource}
						/>
					))}
					{visibleUnits.length === 0 && (
						<div className="rounded-xl border border-dashed border-nova-border px-5 py-10 text-center text-sm text-nova-text-muted">
							{selectedUnits.length === 0
								? "Nothing to translate yet. Text you add in the Builder shows up here."
								: "No phrases match your search. Try different words or another status."}
						</div>
					)}
				</div>
			</div>
		</section>
	);
}

/** The loading and failed states both dialogs show around the picker fields. */
function RegistryLoadFallback({
	failed,
	onRetry,
}: {
	readonly failed: boolean;
	readonly onRetry: () => void;
}) {
	if (failed) {
		return (
			<div className="rounded-xl border border-nova-border bg-white/[0.025] p-4 text-sm text-nova-text-secondary">
				<p>
					The language catalog didn't load. Check your connection and try again
				</p>
				<Button
					type="button"
					variant="outline"
					className="mt-3"
					onClick={onRetry}
				>
					Try again
				</Button>
			</div>
		);
	}
	return (
		<div className="space-y-3" aria-hidden="true">
			<Skeleton className="h-4 w-20" />
			<Skeleton className="h-11 w-full" />
			<Skeleton className="h-11 w-full" />
		</div>
	);
}

function AddLanguageDialog({
	doc,
	languages,
	onCommit,
	onAdded,
}: {
	readonly doc: BlueprintDoc;
	readonly languages: readonly LanguageDisplay[];
	readonly onCommit: (mutations: Mutation[]) => boolean;
	readonly onAdded: (language: LanguageTag) => void;
}) {
	const [open, setOpen] = useState(false);
	const registry = useLanguageRegistrySearch(open);
	const [choice, setChoice] = useState<LanguagePickerChoice>(
		EMPTY_LANGUAGE_CHOICE,
	);
	const [pickerQuery, setPickerQuery] = useState("");
	const [copyFrom, setCopyFrom] = useState<LanguageTag | undefined>(
		languages[0]?.tag,
	);
	const [error, setError] = useState<string>();
	const existingTags = useMemo(
		() => languages.map((language) => language.tag),
		[languages],
	);
	const copySource =
		languages.find((language) => language.tag === copyFrom) ?? languages[0];
	const copySourceTag = copySource?.tag;
	useEffect(() => {
		if (copySourceTag !== undefined && copySourceTag !== copyFrom) {
			setCopyFrom(copySourceTag);
		}
	}, [copyFrom, copySourceTag]);

	const data = registry.data;
	const selection = resolvedLanguageSelection(choice);
	const duplicate =
		data !== undefined && selection !== undefined
			? duplicateLanguageRefusal(data, selection, existingTags)
			: undefined;

	const reset = () => {
		setChoice(EMPTY_LANGUAGE_CHOICE);
		setPickerQuery("");
		setCopyFrom(languages[0]?.tag);
		setError(undefined);
	};

	const add = () => {
		if (
			data === undefined ||
			selection === undefined ||
			duplicate !== undefined
		) {
			return;
		}
		if (copySource === undefined) {
			setError("Choose a language to copy text from");
			return;
		}
		const mutations: Mutation[] = [
			{ kind: "addLanguage", language: selection.identity },
		];
		for (const unit of collectLocalizedTranslationUnits(doc, copySource.tag)) {
			mutations.push({
				kind: "setTranslation",
				language: selection.tag,
				unitId: unit.id,
				entry: {
					value: structuredClone(unit.effective),
					sourceFingerprint: unit.sourceFingerprint,
					origin: "copied",
					review: "needs-review",
					translatedFrom: copySource.tag,
				},
			});
		}
		if (!onCommit(mutations)) return;
		onAdded(selection.tag);
		setOpen(false);
		reset();
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				setOpen(nextOpen);
				if (!nextOpen) reset();
			}}
		>
			<DialogTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						className="nova-add-slot mt-3 w-full"
					/>
				}
			>
				<Icon icon={tablerPlus} aria-hidden="true" />
				Add language
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Add a language</DialogTitle>
					<DialogDescription>
						Search for the language your workers speak. Nova will copy your
						app's current text into it, marked for review, so you can translate
						at your own pace.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="space-y-4">
					{data === undefined ? (
						<RegistryLoadFallback
							failed={registry.failed}
							onRetry={registry.retry}
						/>
					) : (
						<>
							<LanguagePickerFields
								data={data}
								choice={choice}
								onChoiceChange={(next) => {
									setChoice(next);
									setError(undefined);
								}}
								query={pickerQuery}
								onQueryChange={setPickerQuery}
								existingTags={existingTags}
								idPrefix="add-language"
							/>
							<Field>
								<FieldLabel htmlFor="add-language-copy-from">
									Copy text from
								</FieldLabel>
								<Select
									key={copySourceTag ?? "no-copy-source"}
									value={copySource?.tag ?? null}
									onValueChange={(value: string | null) =>
										value !== null && setCopyFrom(value)
									}
								>
									<SelectTrigger id="add-language-copy-from" className="w-full">
										<SelectValue>
											{copySource === undefined ? (
												"No source language"
											) : (
												<bdi dir={copySource.direction}>
													{copySource.label ??
														data.resolvedLanguageDisplayLabel(
															copySource.identity,
														)}
												</bdi>
											)}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										{languages.map((language) => {
											const label =
												language.label ??
												data.resolvedLanguageDisplayLabel(language.identity);
											const englishName =
												language.englishName ??
												data.resolvedLanguageEnglishName(language.identity);
											return (
												<SelectItem
													key={language.tag}
													value={language.tag}
													wrap
												>
													<span className="flex min-w-0 flex-col">
														<bdi dir={language.direction}>{label}</bdi>
														{englishName !== undefined &&
															englishName !== label && (
																<span className="text-xs text-nova-text-muted">
																	{englishName}
																</span>
															)}
													</span>
												</SelectItem>
											);
										})}
									</SelectContent>
								</Select>
							</Field>
						</>
					)}
					{error !== undefined && (
						<p role="alert" className="text-sm text-nova-rose">
							{error}
						</p>
					)}
				</DialogBody>
				<DialogFooter showCloseButton>
					<Button
						type="button"
						onClick={add}
						disabled={
							data === undefined ||
							selection === undefined ||
							duplicate !== undefined
						}
					>
						Add language
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ChangeLanguageDialog({
	currentTag,
	onCommit,
}: {
	readonly currentTag: LanguageTag;
	readonly onCommit: (mutations: Mutation[]) => boolean;
}) {
	const [open, setOpen] = useState(false);
	const registry = useLanguageRegistrySearch(open);
	/* A missing draft follows the current document value, so an untouched
	 * dialog stays live when a multiplayer peer relabels the language. */
	const [draftChoice, setDraftChoice] = useState<LanguagePickerChoice>();
	const [draftQuery, setDraftQuery] = useState<string>();

	const data = registry.data;
	const currentIdentity = parseLanguageTag(currentTag);
	const currentChoice: LanguagePickerChoice = {
		language: currentIdentity.language,
		...(currentIdentity.script !== undefined && {
			script: currentIdentity.script,
		}),
		...(currentIdentity.region !== undefined && {
			region: currentIdentity.region,
		}),
	};
	const choice = draftChoice ?? currentChoice;
	const currentLabel =
		languageDisplayLabel(currentIdentity) ??
		data?.resolvedLanguageDisplayLabel(currentIdentity) ??
		"";
	const query = draftQuery ?? currentLabel;
	const selection = resolvedLanguageSelection(choice);

	const setDialogOpen = (nextOpen: boolean) => {
		setOpen(nextOpen);
		setDraftChoice(undefined);
		setDraftQuery(undefined);
	};
	const save = () => {
		if (selection === undefined) return;
		if (selection.tag !== currentTag) {
			if (
				!onCommit([
					{ kind: "relabelSourceLanguage", language: selection.identity },
				])
			) {
				return;
			}
		}
		setDialogOpen(false);
	};
	return (
		<Dialog open={open} onOpenChange={setDialogOpen}>
			<DialogTrigger render={<Button type="button" variant="ghost" />}>
				Change language
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Change the language</DialogTitle>
					<DialogDescription>
						Search for the language your workers speak. You can change this
						until you add a second language.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="space-y-4">
					{data === undefined ? (
						<RegistryLoadFallback
							failed={registry.failed}
							onRetry={registry.retry}
						/>
					) : (
						<LanguagePickerFields
							data={data}
							choice={choice}
							onChoiceChange={setDraftChoice}
							query={query}
							onQueryChange={setDraftQuery}
							// Relabel replaces the sole language, so nothing counts as a
							// duplicate; re-saving the current identity is a quiet no-op.
							existingTags={[]}
							idPrefix="change-language"
						/>
					)}
				</DialogBody>
				<DialogFooter showCloseButton>
					<Button
						type="button"
						onClick={save}
						disabled={data === undefined || selection === undefined}
					>
						Save language
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function RemoveLanguageDialog({
	display,
	onRemove,
}: {
	readonly display: LanguageDisplay;
	readonly onRemove: () => void;
}) {
	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={<Button type="button" variant="ghost-destructive" />}
			>
				<Icon icon={tablerTrash} aria-hidden="true" />
				Remove
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						Remove <LanguageName display={display} />?
					</AlertDialogTitle>
					<AlertDialogDescription>
						This removes every translation you've added for{" "}
						<LanguageName display={display} />. Your original text and other
						languages stay as they are.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction variant="destructive" onClick={onRemove}>
						Remove language
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

function displayValue(value: LocalizedValue, doc: BlueprintDoc): string {
	return typeof value === "string"
		? value
		: projectProseTemplate(value, doc).text;
}

function TranslationUnitRow({
	doc,
	unit,
	isSource,
}: {
	readonly doc: BlueprintDoc;
	readonly unit: LocalizedTranslationUnit;
	readonly isSource: boolean;
}) {
	const { inline } = useBlueprintMutations();
	const navigate = useNavigate();
	const editor = useTranslationUnitEditor(unit.id);
	const { direction } = useBuilderLanguage();
	const initial = unit.explicit?.value ?? unit.effective;
	const [draft, setDraft] = useState<LocalizedValue>(() =>
		structuredClone(initial),
	);
	const [draftValid, setDraftValid] = useState(true);
	const [error, setError] = useState<string>();
	const localization = effectiveAppLocalization(doc.localization);
	const sourceDirection = languageDirection(localization.sourceLanguage);
	const changed = JSON.stringify(draft) !== JSON.stringify(initial);
	const save = () => {
		if (!draftValid) return;
		const refusal = firstRefusal(editor.saveTarget(draft));
		setError(refusal);
	};
	const review = () => {
		if (unit.explicit === undefined) return;
		setError(
			firstRefusal(
				inline.commitMany([
					{
						kind: "reviewTranslation",
						language: unit.language,
						unitId: unit.id,
						expectedSourceFingerprint: unit.explicit.sourceFingerprint,
						sourceFingerprint: unit.sourceFingerprint,
						value: structuredClone(unit.explicit.value),
					},
				]),
			),
		);
	};
	const clear = () => {
		setError(
			firstRefusal(
				inline.commitMany([
					{
						kind: "setTranslation",
						language: unit.language,
						unitId: unit.id,
						entry: null,
					},
				]),
			),
		);
	};
	const openOwner = () => {
		switch (unit.owner.kind) {
			case "app":
				navigate.goHome();
				break;
			case "module":
				navigate.openModule(unit.owner.moduleUuid);
				break;
			case "form":
				navigate.openForm(unit.owner.moduleUuid, unit.owner.formUuid);
				break;
			case "field":
			case "select-option":
				navigate.openForm(
					unit.owner.moduleUuid,
					unit.owner.formUuid,
					unit.owner.fieldUuid,
				);
				break;
			case "case-list-column":
				navigate.openCaseList(unit.owner.moduleUuid);
				break;
			case "search-input":
				navigate.openSearchConfig(unit.owner.moduleUuid);
				break;
			case "case-property-option":
				navigate.goHome();
				break;
		}
	};

	return (
		<article className="rounded-xl border border-nova-border bg-white/[0.025] p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="break-words text-sm font-medium text-nova-text">
						{unit.breadcrumb.join(" › ")}
					</p>
					<p className="mt-1 text-xs text-nova-text-muted">
						{ROLE_LABELS[unit.role]}
						{unit.context.fieldKind !== undefined
							? ` · ${fieldRegistry[unit.context.fieldKind].label} field`
							: ""}
						{unit.context.optionValue !== undefined
							? ` · value ${unit.context.optionValue}`
							: ""}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button type="button" variant="ghost" onClick={openOwner}>
						Open in Builder
					</Button>
					{!isSource && (
						<Badge variant={STATUS_VARIANTS[unit.status]}>
							{STATUS_LABELS[unit.status]}
						</Badge>
					)}
				</div>
			</div>
			<div className={`mt-4 grid gap-4 ${isSource ? "" : "@xl:grid-cols-2"}`}>
				<div>
					<p className="mb-1.5 text-xs font-medium text-nova-text-secondary">
						Source
					</p>
					<div
						dir={sourceDirection}
						className="min-h-11 whitespace-pre-wrap rounded-lg border border-nova-border bg-black/10 px-3.5 py-2.5 text-sm leading-relaxed text-nova-text-secondary"
					>
						{displayValue(unit.source, doc) || (
							<span className="italic text-nova-text-muted">Empty</span>
						)}
					</div>
				</div>
				{!isSource && (
					<div dir={direction}>
						<p className="mb-1.5 text-xs font-medium text-nova-text-secondary">
							Translation
						</p>
						{typeof draft === "string" ? (
							<Textarea
								value={draft}
								onChange={(event) => setDraft(event.target.value)}
								aria-label={`Translation for ${unit.breadcrumb.join(" › ")}`}
							/>
						) : (
							<ProtectedProseEditor
								doc={doc}
								source={unit.source as ProseTemplate}
								value={draft}
								onChange={setDraft}
								onValidityChange={setDraftValid}
							/>
						)}
						<div className="mt-2 flex flex-wrap items-center justify-end gap-2">
							{unit.explicit !== undefined && (
								<Button
									type="button"
									variant="ghost-destructive"
									onClick={clear}
								>
									Use the original text
								</Button>
							)}
							{unit.explicit !== undefined &&
								unit.status !== "ready" &&
								!changed && (
									<Button type="button" variant="outline" onClick={review}>
										<Icon icon={tablerCheck} aria-hidden="true" />
										Mark as reviewed
									</Button>
								)}
							<Button
								type="button"
								disabled={
									!draftValid || (!changed && unit.explicit !== undefined)
								}
								onClick={save}
							>
								Save translation
							</Button>
						</div>
						{error !== undefined && (
							<p role="alert" className="mt-2 text-sm text-nova-rose">
								{error}
							</p>
						)}
					</div>
				)}
			</div>
		</article>
	);
}

interface ProtectedToken {
	readonly token: string;
	readonly part: ProseReferencePart;
	readonly label: string;
}

function sameReference(left: ProseReferencePart, right: ProseReferencePart) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function protectedTokens(
	source: ProseTemplate,
	target: ProseTemplate,
	doc: BlueprintDoc,
): readonly ProtectedToken[] {
	const literalText = [...source.parts, ...target.parts]
		.filter((part) => part.kind === "text")
		.map((part) => part.text)
		.join("");
	let prefix = "NOVA_REF";
	while (literalText.includes(`[[${prefix}_`)) prefix += "_";
	return source.parts
		.filter((part): part is ProseReferencePart => part.kind !== "text")
		.map((part, index) => ({
			token: `[[${prefix}_${index + 1}]]`,
			part,
			label: projectProseTemplate({ parts: [part] }, doc).text,
		}));
}

function serializeProse(
	value: ProseTemplate,
	tokens: readonly ProtectedToken[],
): string {
	const unused = [...tokens];
	let output = "";
	for (const part of value.parts) {
		if (part.kind === "text") {
			if (tokens.length === 0) {
				output += part.text;
				continue;
			}
			let escaped = part.text.replaceAll("\\", "\\\\");
			for (const token of tokens) {
				escaped = escaped.replaceAll(token.token, `\\${token.token}`);
			}
			output += escaped;
			continue;
		}
		const index = unused.findIndex((token) => sameReference(token.part, part));
		if (index < 0) continue;
		output += unused[index]?.token ?? "";
		unused.splice(index, 1);
	}
	return output;
}

function parseProtectedProse(
	value: string,
	tokens: readonly ProtectedToken[],
): { value?: ProseTemplate; error?: string } {
	if (tokens.length === 0) {
		return {
			value: canonicalProseTemplate(
				value.length === 0 ? [] : [{ kind: "text", text: value }],
			),
		};
	}
	const counts = new Map(tokens.map((token) => [token.token, 0]));
	const parts: ProsePart[] = [];
	let literal = "";
	const flushLiteral = () => {
		if (literal === "") return;
		parts.push({ kind: "text", text: literal });
		literal = "";
	};
	for (let index = 0; index < value.length; ) {
		if (value[index] === "\\") {
			if (index + 1 < value.length) {
				literal += value[index + 1];
				index += 2;
			} else {
				literal += "\\";
				index += 1;
			}
			continue;
		}
		const token = tokens.find((candidate) =>
			value.startsWith(candidate.token, index),
		);
		if (token === undefined) {
			literal += value[index];
			index += 1;
			continue;
		}
		flushLiteral();
		parts.push(token.part);
		counts.set(token.token, (counts.get(token.token) ?? 0) + 1);
		index += token.token.length;
	}
	flushLiteral();
	for (const token of tokens) {
		if (counts.get(token.token) !== 1) {
			return { error: `Keep ${token.token} exactly once.` };
		}
	}
	return { value: canonicalProseTemplate(parts) };
}

function ProtectedProseEditor({
	doc,
	source,
	value,
	onChange,
	onValidityChange,
}: {
	readonly doc: BlueprintDoc;
	readonly source: ProseTemplate;
	readonly value: ProseTemplate;
	readonly onChange: (value: ProseTemplate) => void;
	readonly onValidityChange: (valid: boolean) => void;
}) {
	/* Freeze collision-free markers for this editor instance. Parent draft
	 * updates must not change the marker alphabet midway through an edit; the
	 * row remounts when its persisted source or target value changes. */
	const [tokens] = useState(() => protectedTokens(source, value, doc));
	const [draft, setDraft] = useState(() => serializeProse(value, tokens));
	const [error, setError] = useState<string>();
	return (
		<div>
			<Textarea
				value={draft}
				onChange={(event) => {
					const next = event.target.value;
					setDraft(next);
					const parsed = parseProtectedProse(next, tokens);
					setError(parsed.error);
					onValidityChange(parsed.error === undefined);
					if (parsed.value !== undefined) onChange(parsed.value);
				}}
				aria-label="Reference-safe translation"
			/>
			{tokens.length > 0 && (
				<div className="mt-2 space-y-1.5">
					<div className="flex flex-wrap gap-1.5">
						{tokens.map((token) => (
							<Badge key={token.token} variant="violet">
								<span className="font-mono">{token.token}</span>
								<span aria-hidden="true">·</span>
								{token.label}
							</Badge>
						))}
					</div>
					<p className="text-xs text-nova-text-muted">
						Keep each reference token once. Prefix a token-looking literal or a
						backslash with <span className="font-mono">\</span>.
					</p>
				</div>
			)}
			{error !== undefined && (
				<p role="alert" className="mt-2 text-xs text-nova-rose">
					{error}
				</p>
			)}
		</div>
	);
}
