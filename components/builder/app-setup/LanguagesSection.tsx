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
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@/components/shadcn/combobox";
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
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { Textarea } from "@/components/shadcn/textarea";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	type AppLanguage,
	CLASSIC_LANGUAGE_OPTIONS,
	type ClassicLanguageOption,
	canonicalProseTemplate,
	collectLocalizedTranslationUnits,
	collectTranslationCoverageDiagnostics,
	effectiveAppLocalization,
	type LanguageCode,
	type LocalizedTranslationUnit,
	type LocalizedValue,
	languageCodeSchema,
	type ProsePart,
	type ProseReferencePart,
	type ProseTemplate,
	projectProseTemplate,
	suggestedAppLanguage,
	type TranslationStatus,
} from "@/lib/domain";
import { useNavigate } from "@/lib/routing/hooks";
import {
	useBuilderLanguage,
	useTranslationUnitEditor,
} from "../localization/BuilderLocalizationProvider";

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

export function LanguagesSection() {
	const doc = useBlueprintDoc((value) => value);
	const localization = effectiveAppLocalization(doc.localization);
	const languageState = useBuilderLanguage();
	const { inline } = useBlueprintMutations();
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState<TranslationStatusFilter>("all");
	const [message, setMessage] = useState<string>();
	const selectedLanguage = localization.languages[languageState.language];
	const selectedUnits = useMemo(
		() => collectLocalizedTranslationUnits(doc, languageState.language),
		[doc, languageState.language],
	);
	const coverageDiagnostics = useMemo(
		() => collectTranslationCoverageDiagnostics(doc),
		[doc],
	);
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const visibleUnits = selectedUnits.filter((unit) => {
		if (status !== "all" && unit.status !== status) return false;
		if (normalizedQuery === "") return true;
		return `${unit.breadcrumb.join(" ")} ${unit.role} ${JSON.stringify(unit.source)}`
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
			<header className="flex flex-col gap-4 @xl:flex-row @xl:items-start @xl:justify-between">
				<div className="max-w-2xl">
					<h2
						id="languages-heading"
						className="font-display text-xl font-semibold tracking-tight text-nova-text"
					>
						Languages
					</h2>
					<p className="mt-2 text-sm leading-relaxed text-nova-text-secondary">
						Add any language CommCare Classic accepts, then review every
						worker-facing string in one place. Missing and out-of-date values
						safely show the current source text until they are translated.
					</p>
				</div>
				<AddLanguageDialog
					doc={doc}
					languages={localization.languageOrder.map(
						(code) => localization.languages[code],
					)}
					onCommit={commit}
					onAdded={languageState.selectLanguage}
				/>
			</header>

			<div className="grid gap-3 @xl:grid-cols-2">
				{localization.languageOrder.map((code) => {
					const language = localization.languages[code];
					const units = collectLocalizedTranslationUnits(doc, code);
					const counts = coverageCounts(units);
					const source = code === localization.sourceLanguage;
					const active = code === languageState.language;
					return (
						<article
							key={code}
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
									onClick={() => languageState.selectLanguage(code)}
								>
									<span className="block truncate font-medium text-nova-text">
										{language.name}
									</span>
									<span className="mt-0.5 block font-mono text-xs text-nova-text-muted">
										{code} · {language.direction.toUpperCase()}
									</span>
								</button>
								<div className="flex flex-wrap justify-end gap-1.5">
									{source && <Badge variant="violet">Source</Badge>}
									{code === localization.defaultLanguage && (
										<Badge variant="emerald">Default</Badge>
									)}
								</div>
							</div>
							{source ? (
								<p className="mt-4 text-xs text-nova-text-muted">
									{units.length} canonical source{" "}
									{units.length === 1 ? "string" : "strings"}
								</p>
							) : (
								<div className="mt-4 flex flex-wrap gap-1.5">
									<Badge variant="emerald">{counts.ready} ready</Badge>
									{counts["needs-review"] > 0 && (
										<Badge variant="amber">
											{counts["needs-review"]} review
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
								</div>
							)}
							<div className="mt-4 flex flex-wrap gap-2">
								<LanguageSettingsDialog
									language={language}
									soleSource={source && localization.languageOrder.length === 1}
									onCommit={commit}
								/>
								{code !== localization.defaultLanguage && (
									<Button
										type="button"
										variant="ghost"
										onClick={() =>
											commit([{ kind: "setDefaultLanguage", code }])
										}
									>
										Make default
									</Button>
								)}
								{!source && code !== localization.defaultLanguage && (
									<RemoveLanguageDialog
										language={language}
										onRemove={() => {
											if (commit([{ kind: "removeLanguage", code }])) {
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
							Coverage notes
						</h3>
						<p className="mt-1 text-sm text-nova-text-secondary">
							These app features remain valid, but their text or media does not
							use the static worker-language overlay.
						</p>
					</div>
					<div className="grid gap-3 @xl:grid-cols-2">
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
									{diagnostic.affectedCount} affected{" "}
									{diagnostic.affectedCount === 1 ? "carrier" : "carriers"}
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
				<div className="flex flex-col gap-3 @xl:flex-row @xl:items-end @xl:justify-between">
					<div>
						<h3 className="font-display text-lg font-semibold tracking-tight text-nova-text">
							{selectedLanguage.name} strings
						</h3>
						<p className="mt-1 max-w-2xl text-sm text-nova-text-secondary">
							{languageState.isSource
								? "This is the canonical content. Edit it in the Builder where it appears; use this inventory to find every worker-facing string."
								: `Manual editing and copy are available for every language. Automatic translation from ${localization.languages[localization.sourceLanguage].name} to ${selectedLanguage.name} is not offered until that exact direction passes Nova's quality evaluation.`}
						</p>
					</div>
					<div className="flex flex-col gap-2 @md:flex-row">
						<div className="relative block min-w-64">
							<span className="sr-only">Search translatable strings</span>
							<Icon
								icon={tablerSearch}
								width="16"
								height="16"
								className="pointer-events-none absolute left-3.5 top-3.5 text-nova-text-muted"
							/>
							<Input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Search strings or context"
								className="pl-10"
							/>
						</div>
						<Select
							value={status}
							onValueChange={(value) =>
								value !== null && setStatus(value as TranslationStatusFilter)
							}
						>
							<SelectTrigger
								aria-label="Filter by translation status"
								className="w-44"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All statuses</SelectItem>
								{Object.entries(STATUS_LABELS).map(([value, label]) => (
									<SelectItem key={value} value={value}>
										{label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>

				<p className="mt-4 text-xs text-nova-text-muted">
					Showing {visibleUnits.length} of {selectedUnits.length} strings
				</p>
				<div className="mt-3 space-y-3">
					{visibleUnits.map((unit) => (
						<TranslationUnitRow
							key={`${languageState.language}:${unit.id}:${unit.sourceFingerprint}:${JSON.stringify(unit.explicit ?? null)}`}
							doc={doc}
							unit={unit}
							isSource={languageState.isSource}
						/>
					))}
					{visibleUnits.length === 0 && (
						<div className="rounded-xl border border-dashed border-nova-border px-5 py-10 text-center text-sm text-nova-text-muted">
							No strings match this search and status filter.
						</div>
					)}
				</div>
			</div>
		</section>
	);
}

function AddLanguageDialog({
	doc,
	languages,
	onCommit,
	onAdded,
}: {
	readonly doc: BlueprintDoc;
	readonly languages: readonly AppLanguage[];
	readonly onCommit: (mutations: Mutation[]) => boolean;
	readonly onAdded: (language: LanguageCode) => void;
}) {
	const [open, setOpen] = useState(false);
	const [code, setCode] = useState("");
	const [name, setName] = useState("");
	const [direction, setDirection] = useState<AppLanguage["direction"]>("ltr");
	const [copyFrom, setCopyFrom] = useState<LanguageCode>(
		languages[0]?.code ?? "en",
	);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string>();
	const existing = new Set(languages.map((language) => language.code));
	const copySource =
		languages.find((language) => language.code === copyFrom) ?? languages[0];
	const copySourceCode = copySource?.code;
	useEffect(() => {
		if (copySourceCode !== undefined && copySourceCode !== copyFrom) {
			setCopyFrom(copySourceCode);
		}
	}, [copyFrom, copySourceCode]);
	const options = CLASSIC_LANGUAGE_OPTIONS.filter(
		(option) => !existing.has(option.code),
	);

	const applyCode = (nextCode: string) => {
		const normalized = nextCode.trim().toLowerCase();
		setCode(normalized);
		const parsed = languageCodeSchema.safeParse(normalized);
		if (!parsed.success) return;
		const suggestion = suggestedAppLanguage(parsed.data);
		setName(suggestion.name);
		setDirection(suggestion.direction);
	};

	const reset = () => {
		setCode("");
		setName("");
		setDirection("ltr");
		setCopyFrom(languages[0]?.code ?? "en");
		setQuery("");
		setError(undefined);
	};

	const add = () => {
		const parsedCode = languageCodeSchema.safeParse(code.trim().toLowerCase());
		if (!parsedCode.success) {
			setError(
				parsedCode.error.issues[0]?.message ?? "Enter a valid language code.",
			);
			return;
		}
		if (existing.has(parsedCode.data)) {
			setError("That language already belongs to this app.");
			return;
		}
		if (name.trim() === "") {
			setError("Enter the worker-facing language name.");
			return;
		}
		if (copySource === undefined) {
			setError("Add a source language before copying strings.");
			return;
		}
		const language: AppLanguage = {
			code: parsedCode.data,
			name: name.trim(),
			direction,
		};
		const mutations: Mutation[] = [{ kind: "addLanguage", language }];
		for (const unit of collectLocalizedTranslationUnits(doc, copySource.code)) {
			mutations.push({
				kind: "setTranslation",
				language: language.code,
				unitId: unit.id,
				entry: {
					value: structuredClone(unit.effective),
					sourceFingerprint: unit.sourceFingerprint,
					origin: "copied",
					review: "needs-review",
					translatedFrom: copySource.code,
				},
			});
		}
		if (!onCommit(mutations)) return;
		onAdded(language.code);
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
			<DialogTrigger render={<Button type="button" />}>
				<Icon icon={tablerPlus} aria-hidden="true" />
				Add language
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Add a language</DialogTitle>
					<DialogDescription>
						Choose any Classic catalog language or enter another wire-valid
						code. Nova copies every current string from an existing language and
						marks the result for review.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="space-y-4">
					<div>
						<p className="mb-1.5 block text-xs font-medium text-nova-text-secondary">
							Classic language catalog
						</p>
						<Combobox
							items={options}
							inputValue={query}
							onInputValueChange={(value, details) =>
								setQuery(details.reason === "item-press" ? "" : value)
							}
							onValueChange={(option: ClassicLanguageOption | null) => {
								if (option !== null) applyCode(option.code);
							}}
							itemToStringLabel={(option: ClassicLanguageOption) =>
								option.englishName
							}
							itemToStringValue={(option: ClassicLanguageOption) => option.code}
							filter={(option: ClassicLanguageOption, currentQuery) =>
								`${option.englishName} ${option.code} ${option.iso6391 ?? ""} ${option.iso6392}`
									.toLocaleLowerCase()
									.includes(currentQuery.trim().toLocaleLowerCase())
							}
							autoHighlight
						>
							<ComboboxInput
								aria-label="Search the Classic language catalog"
								placeholder="Search by name or ISO code"
								showClear={query !== ""}
								onClear={() => setQuery("")}
							/>
							<ComboboxContent>
								<ComboboxEmpty>No matching catalog language</ComboboxEmpty>
								<ComboboxList>
									{(option) => (
										<ComboboxItem key={option.code} value={option}>
											<span className="min-w-0 flex-1 truncate">
												{option.englishName}
											</span>
											<span className="font-mono text-xs text-nova-text-muted">
												{option.code}
											</span>
										</ComboboxItem>
									)}
								</ComboboxList>
							</ComboboxContent>
						</Combobox>
					</div>
					<div className="grid gap-4 @md:grid-cols-2">
						<div className="block">
							<span className="mb-1.5 block text-xs font-medium text-nova-text-secondary">
								Language code
							</span>
							<Input
								aria-label="Language code"
								value={code}
								onChange={(event) => applyCode(event.target.value)}
								placeholder="es or es-mx"
								className="font-mono"
							/>
						</div>
						<div className="block">
							<span className="mb-1.5 block text-xs font-medium text-nova-text-secondary">
								Worker-facing name
							</span>
							<Input
								aria-label="Worker-facing language name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="Español"
							/>
						</div>
					</div>
					<div className="grid gap-4 @md:grid-cols-2">
						<div className="block">
							<span className="mb-1.5 block text-xs font-medium text-nova-text-secondary">
								Text direction
							</span>
							<Select
								value={direction}
								onValueChange={(value) =>
									value !== null &&
									setDirection(value as AppLanguage["direction"])
								}
							>
								<SelectTrigger aria-label="Text direction" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="ltr">Left to right</SelectItem>
									<SelectItem value="rtl">Right to left</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="block">
							<span className="mb-1.5 block text-xs font-medium text-nova-text-secondary">
								Start with strings from
							</span>
							<Select
								key={copySourceCode ?? "no-copy-source"}
								value={copySource?.code ?? null}
								onValueChange={(value) => value !== null && setCopyFrom(value)}
							>
								<SelectTrigger
									aria-label="Start with strings from"
									className="w-full"
								>
									<SelectValue>
										{copySource === undefined
											? "No source language"
											: `${copySource.name} (${copySource.code})`}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{languages.map((language) => (
										<SelectItem key={language.code} value={language.code}>
											{language.name} ({language.code})
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					{error !== undefined && (
						<p role="alert" className="text-sm text-nova-rose">
							{error}
						</p>
					)}
				</DialogBody>
				<DialogFooter showCloseButton>
					<Button type="button" onClick={add}>
						Add and copy strings
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function LanguageSettingsDialog({
	language,
	soleSource,
	onCommit,
}: {
	readonly language: AppLanguage;
	readonly soleSource: boolean;
	readonly onCommit: (mutations: Mutation[]) => boolean;
}) {
	const [open, setOpen] = useState(false);
	/* A missing draft property follows the current document value. This keeps an
	 * untouched control live when a multiplayer peer edits it, while preserving
	 * only the property this user is actively drafting. */
	const [draft, setDraft] = useState<Partial<AppLanguage>>({});
	const [error, setError] = useState<string>();
	const code = soleSource ? (draft.code ?? language.code) : language.code;
	const name = draft.name ?? language.name;
	const direction = draft.direction ?? language.direction;
	const setDialogOpen = (nextOpen: boolean) => {
		setOpen(nextOpen);
		setDraft({});
		setError(undefined);
	};
	const save = () => {
		const parsedCode = languageCodeSchema.safeParse(code.trim().toLowerCase());
		if (!parsedCode.success) {
			setError(
				parsedCode.error.issues[0]?.message ?? "Enter a valid language code.",
			);
			return;
		}
		if (name.trim() === "") {
			setError("Enter the worker-facing language name.");
			return;
		}
		const next: AppLanguage = {
			code: parsedCode.data,
			name: name.trim(),
			direction,
		};
		const mutation: Mutation | undefined =
			soleSource && next.code !== language.code
				? { kind: "relabelSourceLanguage", language: next }
				: draft.name !== undefined || draft.direction !== undefined
					? {
							kind: "updateLanguage",
							code: language.code,
							patch: {
								...(draft.name !== undefined && next.name !== language.name
									? { name: next.name }
									: {}),
								...(draft.direction !== undefined &&
								next.direction !== language.direction
									? { direction: next.direction }
									: {}),
							},
						}
					: undefined;
		if (
			mutation !== undefined &&
			mutation.kind === "updateLanguage" &&
			Object.keys(mutation.patch).length === 0
		) {
			setDialogOpen(false);
			return;
		}
		if (mutation !== undefined && !onCommit([mutation])) return;
		setDialogOpen(false);
	};
	return (
		<Dialog open={open} onOpenChange={setDialogOpen}>
			<DialogTrigger render={<Button type="button" variant="ghost" />}>
				Settings
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Language settings</DialogTitle>
					<DialogDescription>
						The name appears in the worker language picker. Locale identity can
						only be relabeled before a second language is added.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="block">
						<span className="mb-1.5 block text-xs font-medium text-nova-text-secondary">
							Language code
						</span>
						<Input
							aria-label="Language code"
							value={code}
							disabled={!soleSource}
							onChange={(event) =>
								setDraft((current) => ({
									...current,
									code: event.target.value.toLowerCase(),
								}))
							}
							className="font-mono"
						/>
					</div>
					<div className="block">
						<span className="mb-1.5 block text-xs font-medium text-nova-text-secondary">
							Worker-facing name
						</span>
						<Input
							aria-label="Worker-facing language name"
							value={name}
							onChange={(event) =>
								setDraft((current) => ({
									...current,
									name: event.target.value,
								}))
							}
						/>
					</div>
					<div className="block">
						<span className="mb-1.5 block text-xs font-medium text-nova-text-secondary">
							Text direction
						</span>
						<Select
							value={direction}
							onValueChange={(value) => {
								if (value === null) return;
								setDraft((current) => ({
									...current,
									direction: value as AppLanguage["direction"],
								}));
							}}
						>
							<SelectTrigger aria-label="Text direction" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="ltr">Left to right</SelectItem>
								<SelectItem value="rtl">Right to left</SelectItem>
							</SelectContent>
						</Select>
					</div>
					{error !== undefined && (
						<p role="alert" className="text-sm text-nova-rose">
							{error}
						</p>
					)}
				</div>
				<DialogFooter showCloseButton>
					<Button type="button" onClick={save}>
						Save settings
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function RemoveLanguageDialog({
	language,
	onRemove,
}: {
	readonly language: AppLanguage;
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
					<AlertDialogTitle>Remove {language.name}?</AlertDialogTitle>
					<AlertDialogDescription>
						This removes every explicit {language.code} translation. The source
						content and other languages are unchanged.
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
	const [error, setError] = useState<string>();
	const changed = JSON.stringify(draft) !== JSON.stringify(initial);
	const save = () => {
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
						{unit.role.replaceAll("-", " ")}
						{unit.context.fieldKind !== undefined
							? ` · ${unit.context.fieldKind} input`
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
					<div className="min-h-11 whitespace-pre-wrap rounded-lg border border-nova-border bg-black/10 px-3.5 py-2.5 text-sm leading-relaxed text-nova-text-secondary">
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
							/>
						)}
						<div className="mt-2 flex flex-wrap items-center justify-end gap-2">
							{unit.explicit !== undefined && (
								<Button
									type="button"
									variant="ghost-destructive"
									onClick={clear}
								>
									Use source fallback
								</Button>
							)}
							{unit.explicit !== undefined &&
								unit.status !== "ready" &&
								!changed && (
									<Button type="button" variant="outline" onClick={review}>
										<Icon icon={tablerCheck} aria-hidden="true" />
										Keep and review
									</Button>
								)}
							<Button type="button" disabled={!changed} onClick={save}>
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
}: {
	readonly doc: BlueprintDoc;
	readonly source: ProseTemplate;
	readonly value: ProseTemplate;
	readonly onChange: (value: ProseTemplate) => void;
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
