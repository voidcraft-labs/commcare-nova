"use client";

import { useEffect, useId, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
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
	type PreviewSearchTarget,
	type PreviewSearchValues,
	previewSearchTargetKey,
	previewSearchValuesSchema,
} from "@/lib/preview/searchSettings";
import {
	useAppId,
	useProjectCanEdit,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";
import { usePreviewSearchConfiguration } from "./PreviewSearchConfiguration";

function targetLabel(target: PreviewSearchTarget) {
	if (target.kind === "local") return "Local Preview";
	const region = { production: "US", eu: "EU", india: "India" }[target.server];
	return `${target.domain} (${region})`;
}

function Choice({
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
					<SelectValue>{options.find(([k]) => k === value)?.[1]}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{options.map(([k, text]) => (
						<SelectItem key={k} value={k}>
							{text}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</Field>
	);
}

function SettingsForm({
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
	const [initial, setInitial] = useState(profile);
	const [zone, setZone] = useState(initial.values.timeZone ?? "");
	const [maximum, setMaximum] = useState(
		initial.values.maximum?.toString() ?? "unknown",
	);
	const [confirmed, setConfirmed] = useState(
		initial.values.propertyMatchers !== null,
	);
	const [rules, setRules] = useState(() =>
		(initial.values.propertyMatchers ?? []).map((r, index) => ({
			...r,
			key: String(index),
			literals: r.ignoreLiterals.map((text, i) => ({ key: String(i), text })),
		})),
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [conflict, setConflict] = useState<PreviewSearchProfile | null>(null);
	const locked = busy || !canEdit;
	function updateRule(key: string, changes: Partial<(typeof rules)[number]>) {
		setRules(rules.map((r) => (r.key === key ? { ...r, ...changes } : r)));
	}
	function reload(next: PreviewSearchProfile) {
		setInitial(next);
		setZone(next.values.timeZone ?? "");
		setMaximum(next.values.maximum?.toString() ?? "unknown");
		setConfirmed(next.values.propertyMatchers !== null);
		setRules(
			(next.values.propertyMatchers ?? []).map((r, index) => ({
				...r,
				key: String(index),
				literals: r.ignoreLiterals.map((text, i) => ({ key: String(i), text })),
			})),
		);
		setConflict(null);
		setError("");
	}
	async function save() {
		const values: PreviewSearchValues = {
			timeZone: zone.trim() || null,
			maximum: maximum === "500" ? 500 : maximum === "1500" ? 1500 : null,
			propertyMatchers: confirmed
				? rules.map((r) => ({
						caseType: r.caseType,
						property: r.property,
						fuzzy: r.fuzzy,
						ignoreLiterals: r.literals.map((l) => l.text),
					}))
				: null,
		};
		const result = previewSearchValuesSchema.safeParse(values);
		if (!result.success) {
			setError(result.error.issues[0]?.message ?? "Review the matching rules.");
			return;
		}
		setBusy(true);
		setError("");
		try {
			const saved = await savePreviewSearchSettingsAction({
				appId,
				projectId,
				target: profile.target,
				expectedRevision: initial.revision,
				values: result.data,
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
			if (saved.kind === "changed")
				setConflict(
					saved.catalog.profiles.find(
						(p) =>
							previewSearchTargetKey(p.target) ===
							previewSearchTargetKey(profile.target),
					) ?? null,
				);
			setError(
				saved.kind === "changed"
					? "A teammate updated these settings. Review their version before saving."
					: "This destination changed. Choose an available destination to continue.",
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
				{initial.revision !== "0"
					? "Supplied by your team. You can update these settings when the project space changes."
					: profile.target.kind === "local"
						? "Local Preview starts in UTC, uses exact matching, and returns up to 500 records."
						: "These settings haven't been recorded. Your team can confirm the settings it uses in this project space."}
			</p>
			<Field>
				<FieldLabel htmlFor={id}>Project space time zone</FieldLabel>
				<Input
					id={id}
					disabled={locked}
					value={zone}
					placeholder="Not recorded"
					onChange={(e) => setZone(e.target.value)}
				/>
			</Field>
			<Choice
				label="Maximum results"
				disabled={locked}
				value={maximum}
				change={setMaximum}
				options={[
					["unknown", "Not recorded"],
					["500", "500 records"],
					["1500", "1,500 records"],
				]}
			/>
			<Choice
				label="Property matching"
				disabled={locked}
				value={confirmed ? "recorded" : "unknown"}
				change={(v) => setConfirmed(v === "recorded")}
				options={[
					["unknown", "Not recorded"],
					["recorded", "Exact unless a rule says otherwise"],
				]}
			/>
			{confirmed &&
				rules.map((r, index) => (
					<fieldset className="space-y-3 rounded-md border p-3" key={r.key}>
						<legend>Matching rule {index + 1}</legend>
						<Field>
							<FieldLabel htmlFor={`${id}-type-${r.key}`}>
								Record type
							</FieldLabel>
							<Input
								id={`${id}-type-${r.key}`}
								value={r.caseType}
								disabled={locked}
								onChange={(e) =>
									updateRule(r.key, { caseType: e.target.value })
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
									updateRule(r.key, { property: e.target.value })
								}
							/>
						</Field>
						<Choice
							label="Match"
							disabled={locked}
							value={r.fuzzy ? "fuzzy" : "exact"}
							change={(v) => updateRule(r.key, { fuzzy: v === "fuzzy" })}
							options={[
								["exact", "Exact"],
								["fuzzy", "Fuzzy"],
							]}
						/>
						{r.literals.map((literal, n) => (
							<Field key={literal.key}>
								<FieldLabel htmlFor={`${id}-literal-${r.key}-${literal.key}`}>
									Text to ignore {n + 1}
								</FieldLabel>
								<Textarea
									id={`${id}-literal-${r.key}-${literal.key}`}
									value={literal.text}
									disabled={locked}
									onChange={(e) =>
										updateRule(r.key, {
											literals: r.literals.map((v) =>
												v.key === literal.key
													? { ...v, text: e.target.value }
													: v,
											),
										})
									}
								/>
								{canEdit && (
									<Button
										type="button"
										variant="ghost"
										disabled={busy}
										onClick={() =>
											updateRule(r.key, {
												literals: r.literals.filter(
													(v) => v.key !== literal.key,
												),
											})
										}
									>
										Remove ignored text {n + 1}
									</Button>
								)}
							</Field>
						))}
						{canEdit && (
							<Button
								type="button"
								variant="outline"
								disabled={busy}
								onClick={() =>
									updateRule(r.key, {
										literals: [...r.literals, { key: uuid(), text: "" }],
									})
								}
							>
								Add text to ignore
							</Button>
						)}
						{canEdit && (
							<Button
								type="button"
								variant="ghost"
								disabled={busy}
								onClick={() =>
									setRules(rules.filter((rule) => rule.key !== r.key))
								}
							>
								Remove rule
							</Button>
						)}
					</fieldset>
				))}
			{confirmed && canEdit && (
				<Button
					type="button"
					variant="outline"
					disabled={busy}
					onClick={() =>
						setRules([
							...rules,
							{
								key: uuid(),
								caseType: "",
								property: "",
								fuzzy: false,
								ignoreLiterals: [],
								literals: [],
							},
						])
					}
				>
					Add matching rule
				</Button>
			)}
			{error && <FieldError>{error}</FieldError>}
			{conflict && (
				<Button
					type="button"
					variant="outline"
					onClick={() => reload(conflict)}
				>
					Review latest settings
				</Button>
			)}
			{canEdit && (
				<Button
					type="button"
					onClick={save}
					disabled={busy || Boolean(conflict)}
				>
					Save settings
				</Button>
			)}
		</FieldGroup>
	);
}

export function PreviewSearchSettingsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { catalog, target, select } = usePreviewSearchConfiguration();
	const appId = useAppId();
	const canEdit = useProjectCanEdit();
	const epoch = useProjectScopeEpoch();
	const automatic =
		catalog?.profiles.length === 1 &&
		catalog.profiles[0]?.target.kind === "destination"
			? catalog.profiles[0].target
			: undefined;
	const active = target ?? automatic;
	const profile = catalog?.profiles.find(
		(p) =>
			active &&
			previewSearchTargetKey(p.target) === previewSearchTargetKey(active),
	);
	const options =
		catalog?.profiles.map(
			(p) => [previewSearchTargetKey(p.target), targetLabel(p.target)] as const,
		) ?? [];
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Preview search settings</DialogTitle>
					<DialogDescription>
						These settings tell Preview how your project space searches records.
						Publishing uses the settings in CommCare HQ.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					{catalog && appId ? (
						<FieldGroup>
							{!automatic && (
								<Choice
									label="Search destination"
									value={
										profile ? previewSearchTargetKey(profile.target) : "none"
									}
									options={[["none", "Choose a destination"], ...options]}
									change={(key) =>
										select(
											catalog.profiles.find(
												(p) => previewSearchTargetKey(p.target) === key,
											)?.target,
										)
									}
								/>
							)}
							{!active && catalog.profiles[0]?.target.kind === "local" && (
								<p className="text-sm text-nova-text-muted">
									Local Preview uses{" "}
									{catalog.profiles[0].revision === "0"
										? "UTC, exact matching, and a 500-record limit."
										: "the search settings your team saved for this Project."}
								</p>
							)}
							{automatic && (
								<p className="text-sm font-medium">{targetLabel(automatic)}</p>
							)}
							{active && !profile && (
								<p>
									This destination is no longer available.{" "}
									<Button
										type="button"
										variant="outline"
										onClick={() => select(undefined)}
									>
										Use available destinations
									</Button>
								</p>
							)}
							{profile && (
								<SettingsForm
									key={JSON.stringify([
										appId,
										catalog.projectId,
										epoch,
										previewSearchTargetKey(profile.target),
									])}
									appId={appId}
									projectId={catalog.projectId}
									canEdit={canEdit}
									profile={profile}
									onSaved={() => onOpenChange(false)}
								/>
							)}
						</FieldGroup>
					) : (
						<p>Waiting for this Project's search settings.</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button
						variant="outline"
						type="button"
						onClick={() => onOpenChange(false)}
					>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
