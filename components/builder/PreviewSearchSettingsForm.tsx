"use client";

import { useEffect, useId, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { Button } from "@/components/shadcn/button";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { Textarea } from "@/components/shadcn/textarea";
import { savePreviewSearchSettingsAction } from "@/lib/deployment/previewSearchActions";
import {
	type PreviewSearchProfile,
	type PreviewSearchValues,
	previewSearchValuesSchema,
} from "@/lib/preview/searchSettings";

import {
	describePreviewSearchChanges,
	previewSearchChangesSchema,
	rebasePreviewSearchValues,
} from "@/lib/preview/searchSettingsEdit";

const rulesPerPage = 8;
type RuleRow = { key: string; caseType: string; property: string } & (
	| { kind: "match"; fuzzy: boolean }
	| { kind: "ignore"; literal: string }
);

function formValues(values: PreviewSearchValues) {
	const config = values.propertyMatchers;
	const rows: RuleRow[] = [
		...(config?.fuzzyProperties ?? []).map((r, i) => ({
			...r,
			kind: "match" as const,
			key: `fuzzy-${i}`,
		})),
		...(config?.ignoredText ?? []).map((r, i) => ({
			...r,
			kind: "ignore" as const,
			key: `text-${i}`,
		})),
	];
	return {
		timeZone: values.timeZone ?? "",
		maximum: values.maximum,
		caseListMap: values.caseListMap ?? null,
		confirmed: config !== null,
		rows,
	};
}
type FormValues = ReturnType<typeof formValues>;
function persistedValues(data: FormValues): PreviewSearchValues {
	return {
		maximum: data.maximum,
		timeZone: data.timeZone.trim() || null,
		...(data.caseListMap === null ? {} : { caseListMap: data.caseListMap }),
		propertyMatchers: data.confirmed
			? {
					fuzzyProperties: data.rows.flatMap((r) =>
						r.kind === "match"
							? [{ caseType: r.caseType, property: r.property, fuzzy: r.fuzzy }]
							: [],
					),
					ignoredText: data.rows.flatMap((r) =>
						r.kind === "ignore"
							? [
									{
										caseType: r.caseType,
										property: r.property,
										literal: r.literal,
									},
								]
							: [],
					),
				}
			: null,
	};
}

export function SearchSettingChoice({
	label,
	value,
	options,
	change,
	disabled,
}: {
	label: string;
	value: string;
	options: readonly (readonly [string, string])[];
	change: (v: string) => void;
	disabled?: boolean;
}) {
	const id = useId();
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Select
				value={value}
				disabled={disabled}
				onValueChange={(v) => {
					if (v !== null) change(v);
				}}
			>
				<SelectTrigger id={id}>
					<SelectValue>
						{options.find(([key]) => key === value)?.[1]}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{options.map(([key, text]) => (
						<SelectItem key={key} value={key}>
							{text}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</Field>
	);
}

function ruleText(profile: PreviewSearchProfile) {
	const rules = profile.values.propertyMatchers;
	if (!rules) return "Property matching has not been recorded.";
	const fuzzy = rules.fuzzyProperties
		.filter((r) => r.fuzzy)
		.map((r) => `${r.caseType} / ${r.property}`);
	const ignored = rules.ignoredText.map(
		(r) => `${r.caseType} / ${r.property}: “${r.literal}”`,
	);
	return [
		fuzzy.length
			? `Fuzzy matching for ${fuzzy.join(", ")}.`
			: "Exact matching for every property.",
		ignored.length
			? `Text ignored in order: ${ignored.join(", ")}.`
			: "No text is ignored.",
	].join(" ");
}

export function PreviewSearchSettingsForm({
	appId,
	projectId,
	profile,
	canEdit,
	onSaved,
}: {
	appId: string;
	projectId: string;
	profile: PreviewSearchProfile;
	canEdit: boolean;
	onSaved: () => void;
}) {
	const id = useId();
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const [draft, setDraft] = useState<{
		base: PreviewSearchProfile;
		data: FormValues;
	}>();
	const [conflictRevision, setConflictRevision] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [pages, setPages] = useState({ match: 0, ignore: 0 });
	const [error, setError] = useState("");
	// The stream is authoritative for clean forms. A failed CAS can reveal a
	// newer revision before its frame arrives, never after a later revision.
	const latest = profile;
	const waiting =
		conflictRevision !== undefined &&
		BigInt(conflictRevision) > BigInt(profile.revision);
	const base = draft?.base ?? latest;
	const data = draft?.data ?? formValues(latest.values);
	const stale = Boolean(
		draft && (waiting || base.revision !== latest.revision),
	);
	const locked = busy || !canEdit;
	function change(patch: Partial<FormValues>) {
		const next = { ...data, ...patch };
		const unchanged =
			JSON.stringify(persistedValues(next)) ===
				JSON.stringify(persistedValues(formValues(base.values))) &&
			next.timeZone === (base.values.timeZone ?? "");
		setDraft(unchanged ? undefined : { base, data: next });
		setError("");
	}
	/** Carry the edits onto the team's revision: each setting this person
	 * changed keeps their value, and the rest take the team's. */
	function keepEdits() {
		const values = rebasePreviewSearchValues(
			base.values,
			persistedValues(data),
			latest.values,
		);
		const next = formValues(values);
		const unchanged =
			JSON.stringify(persistedValues(next)) ===
			JSON.stringify(persistedValues(formValues(latest.values)));
		setDraft(unchanged ? undefined : { base: latest, data: next });
		setConflictRevision(undefined);
		setError("");
	}
	function editRow(row: RuleRow) {
		change({ rows: data.rows.map((r) => (r.key === row.key ? row : r)) });
	}
	function moveLiteral(key: string, direction: number) {
		const literals = data.rows.filter((r) => r.kind === "ignore");
		const index = literals.findIndex((row) => row.key === key);
		const other = index + direction;
		if (index < 0 || other < 0 || other >= literals.length) return;
		[literals[index], literals[other]] = [literals[other], literals[index]];
		change({
			rows: [...data.rows.filter((r) => r.kind === "match"), ...literals],
		});
	}
	async function save() {
		const values = previewSearchValuesSchema.safeParse(persistedValues(data));
		if (!values.success) {
			setError(
				values.error.issues[0]?.message ?? "Review the search settings.",
			);
			return;
		}
		const changes = previewSearchChangesSchema.safeParse(
			describePreviewSearchChanges(base.values, values.data),
		);
		if (!changes.success) {
			setError(changes.error.issues[0].message);
			return;
		}
		setBusy(true);
		setError("");
		try {
			const saved = await savePreviewSearchSettingsAction({
				appId,
				projectId,
				target: profile.target,
				expectedRevision: base.revision,
				changes: changes.data,
			});
			if (!mounted.current) return;
			if (saved.kind === "saved") {
				onSaved();
				return;
			}
			if (saved.kind === "invalid" || saved.kind === "unavailable") {
				setError(saved.message);
				return;
			}
			if (saved.kind === "changed") {
				if (saved.revision) setConflictRevision(saved.revision);
			} else
				setError(
					"This destination changed. Choose an available destination to continue.",
				);
		} catch {
			if (mounted.current)
				setError("Nova couldn't save these settings. You can try again.");
		} finally {
			if (mounted.current) setBusy(false);
		}
	}
	return (
		<FieldGroup>
			<p className="text-sm text-nova-text-muted">
				{base.revision !== "0"
					? "Supplied by your team. You can update these settings when the project space changes."
					: profile.target.kind === "local"
						? "Local Preview starts in UTC, uses exact matching, and returns up to 500 records."
						: "These settings haven't been recorded. Your team can confirm the settings it uses in this project space."}
			</p>
			{stale && (
				<div role="status" className="space-y-2">
					<p>
						A teammate updated these settings. Your edits are still here, and
						you can keep them over the team’s settings.
					</p>
					{waiting ? (
						<p>Waiting for the latest team settings.</p>
					) : (
						<details>
							<summary>Review team settings</summary>
							<p>
								Time zone: {latest.values.timeZone ?? "Not recorded"}. Maximum
								results: {latest.values.maximum ?? "Not recorded"}. Web Apps
								record map:{" "}
								{latest.values.caseListMap == null
									? "Not recorded"
									: latest.values.caseListMap
										? "Available"
										: "Unavailable"}
								. {ruleText(latest)}
							</p>
						</details>
					)}
					<Button
						type="button"
						variant="outline"
						disabled={waiting || !canEdit}
						onClick={keepEdits}
					>
						Keep my edits
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={waiting}
						onClick={() => {
							setDraft(undefined);
							setConflictRevision(undefined);
							setError("");
						}}
					>
						Use latest settings
					</Button>
				</div>
			)}
			<Field>
				<FieldLabel htmlFor={id}>Project space time zone</FieldLabel>
				<Input
					id={id}
					value={data.timeZone}
					disabled={locked}
					placeholder="Not recorded"
					onChange={(e) => change({ timeZone: e.target.value })}
				/>
			</Field>
			<SearchSettingChoice
				label="Web Apps record map"
				value={
					data.caseListMap === null
						? "unknown"
						: data.caseListMap
							? "available"
							: "unavailable"
				}
				disabled={locked}
				options={[
					["unknown", "Not recorded"],
					["available", "Available"],
					["unavailable", "Unavailable"],
				]}
				change={(value) =>
					change({
						caseListMap: value === "unknown" ? null : value === "available",
					})
				}
			/>
			<SearchSettingChoice
				label="Maximum results"
				value={data.maximum?.toString() ?? "unknown"}
				disabled={locked}
				options={[
					["unknown", "Not recorded"],
					["500", "500 records"],
					["1500", "1,500 records"],
				]}
				change={(v) =>
					change({ maximum: v === "500" ? 500 : v === "1500" ? 1500 : null })
				}
			/>
			<SearchSettingChoice
				label="Property matching"
				disabled={locked}
				value={data.confirmed ? "recorded" : "unknown"}
				options={[
					["unknown", "Not recorded"],
					["recorded", "Exact unless a rule says otherwise"],
				]}
				change={(v) => change({ confirmed: v === "recorded" })}
			/>
			{data.confirmed &&
				(["match", "ignore"] as const).map((kind) => {
					const rows = data.rows.filter((r) => r.kind === kind);
					const page = Math.min(
						pages[kind],
						Math.max(0, Math.ceil(rows.length / rulesPerPage) - 1),
					);
					const start = page * rulesPerPage;
					return (
						<div className="space-y-3" key={kind}>
							{kind === "ignore" && rows.length > 0 && (
								<p className="text-sm text-nova-text-muted">
									Ignored text is removed from top to bottom across the record
									types in the search.
								</p>
							)}
							{rows.length > rulesPerPage && (
								<div className="flex flex-wrap items-center gap-2">
									<Button
										type="button"
										variant="outline"
										disabled={!page}
										onClick={() => setPages({ ...pages, [kind]: page - 1 })}
									>
										Previous rules
									</Button>
									<span>
										{start + 1} to {Math.min(start + rulesPerPage, rows.length)}{" "}
										of {rows.length}
									</span>
									<Button
										type="button"
										variant="outline"
										disabled={start + rulesPerPage >= rows.length}
										onClick={() => setPages({ ...pages, [kind]: page + 1 })}
									>
										Next rules
									</Button>
								</div>
							)}
							{rows.slice(start, start + rulesPerPage).map((r, index) => (
								<fieldset
									className="space-y-3 rounded-md border p-3"
									key={r.key}
								>
									<legend>
										{kind === "match" ? "Matching rule" : "Ignored text"}{" "}
										{start + index + 1}
									</legend>
									<Field>
										<FieldLabel htmlFor={`${id}-type-${r.key}`}>
											Record type
										</FieldLabel>
										<Input
											id={`${id}-type-${r.key}`}
											value={r.caseType}
											disabled={locked}
											onChange={(e) =>
												editRow({ ...r, caseType: e.target.value })
											}
										/>
									</Field>
									<Field>
										<FieldLabel htmlFor={`${id}-prop-${r.key}`}>
											Property name
										</FieldLabel>
										<Input
											id={`${id}-prop-${r.key}`}
											value={r.property}
											disabled={locked}
											onChange={(e) =>
												editRow({ ...r, property: e.target.value })
											}
										/>
									</Field>
									{r.kind === "match" ? (
										<SearchSettingChoice
											label="Match"
											disabled={locked}
											value={r.fuzzy ? "fuzzy" : "exact"}
											options={[
												["exact", "Exact"],
												["fuzzy", "Fuzzy"],
											]}
											change={(v) => editRow({ ...r, fuzzy: v === "fuzzy" })}
										/>
									) : (
										<Field>
											<FieldLabel htmlFor={`${id}-text-${r.key}`}>
												Text to ignore
											</FieldLabel>
											<Textarea
												id={`${id}-text-${r.key}`}
												value={r.literal}
												disabled={locked}
												onChange={(e) =>
													editRow({ ...r, literal: e.target.value })
												}
											/>
										</Field>
									)}
									{canEdit && (
										<div className="flex flex-wrap gap-2">
											{kind === "ignore" && (
												<>
													<Button
														type="button"
														variant="outline"
														disabled={busy || start + index === 0}
														onClick={() => moveLiteral(r.key, -1)}
													>
														Move earlier
													</Button>
													<Button
														type="button"
														variant="outline"
														disabled={busy || start + index === rows.length - 1}
														onClick={() => moveLiteral(r.key, 1)}
													>
														Move later
													</Button>
												</>
											)}
											<Button
												type="button"
												variant="ghost"
												disabled={busy}
												onClick={() =>
													change({
														rows: data.rows.filter((row) => row.key !== r.key),
													})
												}
											>
												{kind === "match"
													? "Remove rule"
													: "Remove ignored text"}
											</Button>
										</div>
									)}
								</fieldset>
							))}
							{canEdit && (
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => {
										setPages({
											...pages,
											[kind]: Math.floor(rows.length / rulesPerPage),
										});
										change({
											rows: [
												...data.rows,
												{
													key: uuid(),
													caseType: "",
													property: "",
													...(kind === "match"
														? { kind, fuzzy: true }
														: { kind, literal: "" }),
												},
											],
										});
									}}
								>
									{kind === "match"
										? "Add matching rule"
										: "Add text to ignore"}
								</Button>
							)}
						</div>
					);
				})}
			{error && <FieldError>{error}</FieldError>}
			{canEdit && (
				<Button type="button" onClick={save} disabled={busy || stale}>
					Save settings
				</Button>
			)}
		</FieldGroup>
	);
}
