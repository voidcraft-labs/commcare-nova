"use client";

import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerTrash from "@iconify-icons/tabler/trash";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { RefLabelInput } from "@/components/builder/RefLabelInput";
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
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useLocalizedTranslationUnit } from "@/lib/doc/hooks/useLocalization";
import { useLocalizationWorkspace } from "@/lib/doc/hooks/useLocalizationWorkspace";
import {
	addLanguageMutation,
	heldLanguageWireCodes,
	relabelSourceLanguageMutation,
} from "@/lib/doc/languageMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	type AppLanguageIdentity,
	type EffectiveAppLocalization,
	fieldRegistry,
	hasGeneratedWording,
	type LanguageDirection,
	type LanguageTag,
	type LocalizedTranslationUnit,
	type LocalizedValue,
	languageTag,
	languageWireCodeSchema,
	type ProseTemplate,
	parseLanguageTag,
	type TranslationCoverageDiagnosticCode,
	type TranslationStatus,
	type TranslationUnitRole,
	unitsCopiedToANewLanguage,
} from "@/lib/domain";
import {
	languageDirection,
	languageDisplayLabel,
	languageEnglishName,
} from "@/lib/domain/languageRegistry";
import type { LanguageRegistrySearch } from "@/lib/domain/languageRegistry/load";
import {
	authoredTranslationValueMode,
	translationUnitProseSlot,
} from "@/lib/domain/translationUnits";
import { CurrentFormScope } from "@/lib/references/ReferenceContext";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { automaticTranslationCapability } from "@/lib/translation/capabilityPolicy";
import { cn } from "@/lib/utils";
import {
	useBuilderLanguage,
	useTranslationUnitEditor,
} from "../localization/BuilderLocalizationProvider";
import { useLanguageRegistrySearch } from "../localization/useLanguageRegistrySearch";
import { InstallationProfilesSection } from "./InstallationProfilesSection";
import { LanguagePickerFields } from "./languagePicker/LanguagePickerFields";
import {
	duplicateLanguageRefusal,
	EMPTY_LANGUAGE_CHOICE,
	type LanguagePickerChoice,
	resolvedLanguageSelection,
} from "./languagePicker/pickerModel";
import {
	createProtectedProseDraft,
	editProtectedProseDraft,
} from "./protectedProse";
import { reviewTranslationMutation } from "./translationReviewModel";

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
	"menu-badge": "Menu badge",
	"form-name": "Form name",
	"form-submit-label": "Submit button",
	"case-list-registration-label": "Register action label",
	"case-list-menu-item-label": "Case list entry label",
	"field-label": "Field label",
	"field-hint": "Field hint",
	"field-help": "Field help",
	"field-validation-message": "Validation message",
	"field-extended-text": "Extended text",
	"field-qr-code": "QR code",
	"field-spoken-text": "Spoken text",
	"field-first-add-label": "First entry button",
	"field-add-label": "Another entry button",
	"select-option-label": "Option label",
	"case-list-header": "Case list header",
	"case-detail-tab-title": "Case detail tab",
	"case-list-sort-label": "Name in Sort by",
	"case-list-calculation-text": "Case list calculated text",
	"case-list-image-description": "Case list image description",
	"case-list-mapping-label": "Case list value label",
	"case-list-interval-text": "Case list interval text",
	"case-list-empty-text": "Empty case list text",
	"case-list-select-text": "Case list Continue button",
	"search-input-label": "Search field label",
	"search-input-hint": "Search field hint",
	"search-input-required-message": "Search field required message",
	"search-input-validation-message": "Search field check message",
	"search-screen-title": "Search screen title",
	"search-screen-subtitle": "Search screen subtitle",
	"search-runtime-validation-message": "Search validation message",
	"generated-wording": "Worker wording",
	"case-property-option-label": "Case property option label",
};

/* What one affected thing is called, per coverage diagnostic: the counts mean
 * different things (fields, forms, files, automations) and a generic word
 * would hide that. */
const COVERAGE_COUNT_NOUNS: Readonly<
	Record<TranslationCoverageDiagnosticCode, readonly [string, string]>
> = {
	"lookup-labels-need-localized-data": ["field", "fields"],
	"case-labels-need-localized-data": ["field", "fields"],
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
	localization?: EffectiveAppLocalization,
): LanguageDisplay {
	const identity = parseLanguageTag(tag);
	const direction = languageDirection(identity, localization);
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
	const languageState = useBuilderLanguage();
	const canEdit = useCanEdit();
	const {
		localization,
		selectedTag,
		selectedUnits,
		coverageDiagnostics,
		unitsForLanguage,
		projectValue,
	} = useLocalizationWorkspace(languageState.language);
	const { inline } = useBlueprintMutations();
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState<TranslationStatusFilter>("all");
	const [message, setMessage] = useState<string>();

	const isSource = selectedTag === localization.sourceLanguage;

	// The baked common set labels most languages statically; the full registry
	// chunk loads only when an app language falls outside it.
	const needsResolver = localization.languageOrder.some(
		(tag) =>
			languageDisplayLabel(tag) === undefined ||
			(!tag.startsWith("project:") && languageEnglishName(tag) === undefined),
	);
	const resolver = useLanguageRegistrySearch(needsResolver).data;
	const displays = useMemo(
		() =>
			new Map(
				localization.languageOrder.map((tag) => [
					tag,
					languageDisplay(tag, resolver, localization),
				]),
			),
		[localization, resolver],
	);
	const selectedDisplay =
		displays.get(selectedTag) ??
		languageDisplay(selectedTag, resolver, localization);
	const sourceDisplay =
		displays.get(localization.sourceLanguage) ??
		languageDisplay(localization.sourceLanguage, resolver, localization);
	const sourceName =
		sourceDisplay.englishName ?? sourceDisplay.label ?? "the source language";
	const selectedName =
		selectedDisplay.englishName ?? selectedDisplay.label ?? "this language";
	const languageName = (display: LanguageDisplay) =>
		display.englishName ?? display.label ?? display.tag;

	const automaticTranslation = isSource
		? null
		: automaticTranslationCapability(
				sourceDisplay.identity,
				selectedDisplay.identity,
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
					see in one place. Workers start in the first language on this list.
				</p>
			</header>

			<div>
				<div className="grid gap-3 @xl:grid-cols-2">
					{localization.languageOrder.map((tag, index) => {
						const display =
							displays.get(tag) ?? languageDisplay(tag, resolver, localization);
						const units = unitsForLanguage(tag);
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
								{canEdit && (
									<div className="mt-4 flex flex-wrap gap-2">
										{display.identity.kind === "project" && (
											<Button
												type="button"
												variant="ghost"
												onClick={() =>
													commit([
														{
															kind: "setProjectLanguageDirection",
															code: tag,
															direction:
																display.direction === "rtl" ? "ltr" : "rtl",
														},
													])
												}
											>
												{display.direction === "rtl"
													? "Use left-to-right text"
													: "Use right-to-left text"}
											</Button>
										)}
										{source && localization.languageOrder.length === 1 && (
											<ChangeLanguageDialog
												currentTag={tag}
												onCommit={commit}
											/>
										)}
										{index > 1 && (
											<Button
												type="button"
												variant="ghost"
												aria-label={`Move ${languageName(display)} earlier`}
												onClick={() =>
													commit([
														{
															kind: "moveLanguage",
															code: tag,
															after: localization.languageOrder[index - 2],
														},
													])
												}
											>
												Move earlier
											</Button>
										)}
										{index + 1 < localization.languageOrder.length && (
											<Button
												type="button"
												variant="ghost"
												aria-label={`Move ${languageName(display)} later`}
												onClick={() =>
													commit([
														{
															kind: "moveLanguage",
															code: tag,
															after: localization.languageOrder[index + 1],
														},
													])
												}
											>
												Move later
											</Button>
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
								)}
							</article>
						);
					})}
				</div>
				{canEdit && (
					<AddLanguageDialog
						unitsForLanguage={unitsForLanguage}
						languages={localization.languageOrder.map(
							(tag) =>
								displays.get(tag) ??
								languageDisplay(tag, resolver, localization),
						)}
						onCommit={commit}
						onAdded={languageState.selectLanguage}
					/>
				)}
			</div>

			<InstallationProfilesSection
				languages={localization.languageOrder}
				label={(tag) =>
					languageName(displays.get(tag) ?? languageDisplay(tag, resolver))
				}
				commit={(installationProfile) =>
					commit([
						{ kind: "setAppSettings", settings: { installationProfile } },
					])
				}
			/>
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
							projectValue={projectValue}
							unit={unit}
							isSource={isSource}
							filledFromName={
								unit.filledFrom === undefined
									? undefined
									: languageName(
											displays.get(unit.filledFrom) ??
												languageDisplay(
													unit.filledFrom,
													resolver,
													localization,
												),
										)
							}
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

function languagePickerSelection(
	choice: LanguagePickerChoice,
	projectCode: string | null,
) {
	if (projectCode === null) return resolvedLanguageSelection(choice);
	const parsed = languageWireCodeSchema.safeParse(projectCode);
	if (!parsed.success) return undefined;
	const identity = { kind: "project", language: parsed.data } as const;
	return { identity, tag: languageTag(identity) };
}

function LanguageIdentityPicker({
	code,
	onCodeChange,
	children,
}: {
	readonly code: string | null;
	readonly onCodeChange: (code: string | null) => void;
	readonly children: ReactNode;
}) {
	const id = useId();
	return (
		<>
			{code === null ? (
				children
			) : (
				<Field>
					<FieldLabel htmlFor={id}>Project language code</FieldLabel>
					<Input
						id={id}
						value={code}
						onChange={(event) => onCodeChange(event.target.value)}
						aria-invalid={
							Boolean(code) && !languageWireCodeSchema.safeParse(code).success
						}
						aria-describedby={`${id}-hint`}
					/>
					<p id={`${id}-hint`} className="text-xs text-nova-text-muted">
						Use two or three lowercase letters, with an optional hyphen and
						lowercase suffix. Your app keeps this code for its translations.
					</p>
				</Field>
			)}
			<Button
				type="button"
				variant="ghost"
				onClick={() => onCodeChange(code === null ? "" : null)}
			>
				{code === null
					? "Use a project language code"
					: "Choose from the language list"}
			</Button>
		</>
	);
}

function AddLanguageDialog({
	unitsForLanguage,
	languages,
	onCommit,
	onAdded,
}: {
	readonly unitsForLanguage: (
		language: LanguageTag,
	) => readonly LocalizedTranslationUnit[];
	readonly languages: readonly LanguageDisplay[];
	readonly onCommit: (mutations: Mutation[]) => boolean;
	readonly onAdded: (language: LanguageTag) => void;
}) {
	const [open, setOpen] = useState(false);
	const docApi = useBlueprintDocApi();
	const registry = useLanguageRegistrySearch(open);
	const [choice, setChoice] = useState<LanguagePickerChoice>(
		EMPTY_LANGUAGE_CHOICE,
	);
	const [pickerQuery, setPickerQuery] = useState("");
	const [projectCode, setProjectCode] = useState<string | null>(null);
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
	const selection = languagePickerSelection(choice, projectCode);
	const duplicate =
		projectCode === null && data !== undefined && selection !== undefined
			? duplicateLanguageRefusal(data, selection, existingTags)
			: undefined;

	const reset = () => {
		setChoice(EMPTY_LANGUAGE_CHOICE);
		setPickerQuery("");
		setProjectCode(null);
		setCopyFrom(languages[0]?.tag);
		setError(undefined);
	};

	const add = () => {
		if (
			(data === undefined && projectCode === null) ||
			selection === undefined ||
			duplicate !== undefined
		) {
			return;
		}
		if (copySource === undefined) {
			setError("Choose a language to copy text from");
			return;
		}
		const held = heldLanguageWireCodes(docApi.getState());
		if (
			selection.identity.kind === "project" &&
			held.has(selection.identity.language)
		) {
			setError("This app already has a language with that code");
			return;
		}
		const mutations: Mutation[] = [
			addLanguageMutation(held, selection.identity),
		];
		for (const unit of unitsCopiedToANewLanguage(
			unitsForLanguage(copySource.tag),
		)) {
			mutations.push({
				kind: "setTranslation",
				language: selection.tag,
				unitId: unit.id,
				entry: {
					value: structuredClone(unit.effective),
					...authoredTranslationValueMode(unit, unit.effective),
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
					<LanguageIdentityPicker
						code={projectCode}
						onCodeChange={(code) => {
							setProjectCode(code);
							setError(undefined);
						}}
					>
						{data === undefined ? (
							<RegistryLoadFallback
								failed={registry.failed}
								onRetry={registry.retry}
							/>
						) : (
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
						)}
					</LanguageIdentityPicker>
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
												data?.resolvedLanguageDisplayLabel(copySource.identity)}
										</bdi>
									)}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{languages.map((language) => {
									const label =
										language.label ??
										data?.resolvedLanguageDisplayLabel(language.identity);
									const englishName =
										language.englishName ??
										data?.resolvedLanguageEnglishName(language.identity);
									return (
										<SelectItem key={language.tag} value={language.tag} wrap>
											<span className="flex min-w-0 flex-col">
												<bdi dir={language.direction}>{label}</bdi>
												{englishName !== undefined && englishName !== label && (
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
							(data === undefined && projectCode === null) ||
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
	const [chosenProjectCode, setProjectCode] = useState<string | null>();
	const [draftQuery, setDraftQuery] = useState<string>();

	const data = registry.data;
	const currentIdentity = parseLanguageTag(currentTag);
	const projectCode =
		chosenProjectCode === undefined
			? currentIdentity.kind === "project"
				? currentIdentity.language
				: null
			: chosenProjectCode;
	const currentChoice: LanguagePickerChoice =
		currentIdentity.kind === "project"
			? EMPTY_LANGUAGE_CHOICE
			: {
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
	const query =
		draftQuery ?? (currentIdentity.kind === "project" ? "" : currentLabel);
	const selection = languagePickerSelection(choice, projectCode);

	const setDialogOpen = (nextOpen: boolean) => {
		setOpen(nextOpen);
		setDraftChoice(undefined);
		setDraftQuery(undefined);
		setProjectCode(undefined);
	};
	const save = () => {
		if (selection === undefined) return;
		if (selection.tag !== currentTag) {
			if (!onCommit([relabelSourceLanguageMutation(selection.identity)])) {
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
					<LanguageIdentityPicker
						code={projectCode}
						onCodeChange={setProjectCode}
					>
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
					</LanguageIdentityPicker>
				</DialogBody>
				<DialogFooter showCloseButton>
					<Button
						type="button"
						onClick={save}
						disabled={
							(data === undefined && projectCode === null) ||
							selection === undefined
						}
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

function TranslationUnitRow({
	projectValue: projectAnyValue,
	unit,
	isSource,
	filledFromName,
}: {
	readonly projectValue: (
		value: LocalizedValue,
		unit?: LocalizedTranslationUnit,
	) => string;
	readonly unit: LocalizedTranslationUnit;
	readonly isSource: boolean;
	/** The name of the language workers read here while this translation is
	 * blank (`unit.filledFrom`). */
	readonly filledFromName?: string;
}) {
	const generated = hasGeneratedWording(unit);
	const canEdit = useCanEdit();
	const editable = canEdit && (!isSource || generated);
	const { inline } = useBlueprintMutations();
	const navigate = useNavigate();
	const editor = useTranslationUnitEditor(unit.id);
	/* A calculated value shows as its formula, printed in this unit's slot. */
	const projectValue = (value: LocalizedValue) => projectAnyValue(value, unit);
	/* A blank translation beside text shows workers another language's text
	 * (the form builder's fill); its stored value there is that text. */
	const filledFrom = useLocalizedTranslationUnit(
		unit.filledFrom ?? unit.language,
		unit.id,
	);
	const filledText =
		unit.filledFrom === undefined || filledFrom === undefined
			? undefined
			: projectValue(filledFrom.effective);
	const { direction, sourceDirection, sourceLanguage } = useBuilderLanguage();
	const proseSlot = translationUnitProseSlot(unit);
	const initial = unit.explicit?.value ?? unit.effective;
	const [draft, setDraft] = useState<LocalizedValue>(() =>
		structuredClone(initial),
	);
	const [draftValid, setDraftValid] = useState(true);
	const [error, setError] = useState<string>();
	const changed = JSON.stringify(draft) !== JSON.stringify(initial);
	const save = () => {
		if (!draftValid) return;
		const refusal = firstRefusal(editor.saveTarget(draft));
		setError(refusal);
	};
	const review = () => {
		const mutation = reviewTranslationMutation(unit, sourceLanguage);
		if (mutation === undefined) return;
		setError(firstRefusal(inline.commitMany([mutation])));
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
		<article
			id={unit.id}
			className="rounded-xl border border-nova-border bg-white/[0.025] p-4"
		>
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
					{editable && (
						<Badge variant={STATUS_VARIANTS[unit.status]}>
							{STATUS_LABELS[unit.status]}
						</Badge>
					)}
				</div>
			</div>
			<div className={`mt-4 grid gap-4 ${editable ? "@xl:grid-cols-2" : ""}`}>
				<div>
					<p className="mb-1.5 text-xs font-medium text-nova-text-secondary">
						{isSource && generated ? "Default wording" : "Source"}
					</p>
					<div
						dir={sourceDirection}
						className="min-h-11 whitespace-pre-wrap rounded-lg border border-nova-border bg-black/10 px-3.5 py-2.5 text-sm leading-relaxed text-nova-text-secondary"
					>
						{projectValue(
							(isSource ? unit.defaultText : undefined) ?? unit.source,
						) || (
							<span className="italic text-nova-text-muted">
								{unit.generated?.role === "promptValidation"
									? "This field has no check yet."
									: "Empty"}
							</span>
						)}
					</div>
				</div>
				{!canEdit && (!isSource || generated) && (
					<div dir={direction}>
						<p className="mb-1.5 text-xs font-medium text-nova-text-secondary">
							Worker wording
						</p>
						<p className="whitespace-pre-wrap text-sm text-nova-text">
							{projectValue(unit.effective)}
						</p>
					</div>
				)}
				{editable && (
					<div dir={direction}>
						{(proseSlot === undefined || generated) && (
							<p className="mb-1.5 text-xs font-medium text-nova-text-secondary">
								{generated ? "Worker wording" : "Translation"}
							</p>
						)}
						{typeof draft === "string" ? (
							<Textarea
								value={draft}
								onChange={(event) => setDraft(event.target.value)}
								aria-label={`Translation for ${unit.breadcrumb.join(" › ")}`}
							/>
						) : proseSlot !== undefined &&
							(unit.owner.kind === "field" ||
								unit.owner.kind === "select-option") ? (
							<CurrentFormScope formUuid={unit.owner.formUuid}>
								<RefLabelInput
									label="Translation"
									value={draft}
									multiline
									proseSlot={proseSlot}
									savesOnCommit={false}
									{...(filledText !== undefined && {
										placeholder: filledText,
									})}
									onChange={setDraft}
									onSave={(value) => {
										setDraft(value);
										return undefined;
									}}
								/>
							</CurrentFormScope>
						) : (
							<ProtectedProseEditor
								projectValue={projectValue}
								source={unit.source as ProseTemplate}
								value={draft}
								onChange={setDraft}
								onValidityChange={setDraftValid}
								placeholder={filledText}
							/>
						)}
						{unit.status === "out-of-date" && (
							<p className="mt-1.5 text-xs text-nova-text-muted">
								Workers currently see “{projectValue(unit.effective)}”. Your
								earlier translation is here to review.
							</p>
						)}
						{filledText !== undefined && filledFromName !== undefined && (
							<p className="mt-1.5 text-xs text-nova-text-muted">
								Workers see the {filledFromName} text here until this is
								translated.
							</p>
						)}
						<div className="mt-2 flex flex-wrap items-center justify-end gap-2">
							{unit.explicit !== undefined && (
								<Button
									type="button"
									variant="ghost-destructive"
									onClick={clear}
								>
									{generated ? "Use default wording" : "Use the original text"}
								</Button>
							)}
							{unit.explicit !== undefined &&
								unit.status !== "ready" &&
								unit.status !== "missing" &&
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

function ProtectedProseEditor({
	projectValue,
	source,
	value,
	onChange,
	onValidityChange,
	placeholder,
}: {
	readonly projectValue: (value: LocalizedValue) => string;
	readonly source: ProseTemplate;
	readonly value: ProseTemplate;
	readonly onChange: (value: ProseTemplate) => void;
	readonly onValidityChange: (valid: boolean) => void;
	readonly placeholder?: string;
}) {
	/* Freeze collision-free markers for this editor instance. Parent draft
	 * updates must not change the marker alphabet midway through an edit; the
	 * row remounts when its persisted source or target value changes. */
	const [state, setState] = useState(() =>
		createProtectedProseDraft(source, value, projectValue),
	);
	const { tokens, draft, error } = state;
	return (
		<div>
			<Textarea
				value={draft}
				onChange={(event) => {
					const next = editProtectedProseDraft(state, event.target.value);
					setState(next);
					onValidityChange(next.error === undefined);
					if (next.value !== undefined) onChange(next.value);
				}}
				aria-label="Reference-safe translation"
				placeholder={placeholder}
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
