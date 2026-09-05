"use client";

import { useId, useMemo, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Field, FieldDescription, FieldLabel } from "@/components/shadcn/field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { Uuid } from "@/lib/domain";
import { loadCasesAction } from "@/lib/preview/engine/caseDataBinding";
import type {
	LoadCasesResult,
	ParentCaseSelection,
} from "@/lib/preview/engine/caseDataBindingTypes";
import {
	useEntryPointLaunch,
	useEntryPointPreviewSetup,
} from "@/lib/preview/hooks/useEntryPointLaunch";
import { useReloadableResource } from "@/lib/preview/hooks/useReloadableResource";
import {
	useAppId,
	usePreviewPersonaUuid,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";

export function EntryPointPreviewLaunch({
	entryPointUuid,
}: {
	entryPointUuid: Uuid;
}) {
	const { item, personas, requirements } =
		useEntryPointPreviewSetup(entryPointUuid);
	const currentPersona = usePreviewPersonaUuid();
	const [persona, setPersona] = useState(currentPersona ?? "me");
	const [selections, setSelections] = useState<
		Record<string, readonly string[]>
	>({});
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState<string>();
	const launch = useEntryPointLaunch();

	const id = useId();
	if (!item || !requirements) return null;
	return (
		<div className="space-y-4">
			<Field>
				<FieldLabel htmlFor={id}>Preview worker</FieldLabel>
				<Select
					value={persona}
					onValueChange={(value) => {
						if (value) {
							setPersona(value);
							setSelections({});
							setMessage(undefined);
						}
					}}
					disabled={pending}
				>
					<SelectTrigger id={id}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="me">Me</SelectItem>
						{personas.map((persona) => (
							<SelectItem key={persona.uuid} value={persona.uuid}>
								{persona.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<FieldDescription>
					Preview uses this worker’s real cases. It does not claim or sync cases
					from HQ.
				</FieldDescription>
			</Field>
			{requirements.map((requirement) => {
				const parentType = requirement.parentCaseType;
				const parentIds = requirement.parentModuleUuid
					? (selections[requirement.parentModuleUuid] ?? [])
					: undefined;
				return (
					<EntryPointCasePicker
						key={`${entryPointUuid}:${persona}:${requirement.moduleUuid}`}
						moduleUuid={requirement.moduleUuid}
						caseType={requirement.caseType}
						maximum={requirement.maximum}
						name={requirement.name}
						personaUuid={persona === "me" ? undefined : persona}
						selected={selections[requirement.moduleUuid] ?? []}
						disabled={pending}
						parentCase={
							parentType && parentIds
								? { caseType: parentType, caseIds: parentIds }
								: undefined
						}
						onChange={(caseIds) =>
							setSelections((previous) => ({
								...previous,
								[requirement.moduleUuid]: caseIds,
							}))
						}
					/>
				);
			})}
			{message && (
				<p role="alert" className="text-sm text-destructive">
					{message}
				</p>
			)}
			<Button
				disabled={
					pending ||
					requirements.some(
						(requirement) => !selections[requirement.moduleUuid]?.length,
					)
				}
				onClick={async () => {
					setPending(true);
					setMessage(undefined);
					try {
						const result = await launch(
							entryPointUuid,
							requirements.map((requirement) => ({
								moduleUuid: requirement.moduleUuid,
								caseIds: selections[requirement.moduleUuid] ?? [],
							})),
							persona === "me" ? undefined : persona,
						);
						if (result.kind === "refused") setMessage(result.message);
					} catch {
						setMessage("We could not open this entry point. Try again.");
					} finally {
						setPending(false);
					}
				}}
			>
				{pending ? "Opening Preview" : "Test in Preview"}
			</Button>
		</div>
	);
}

function EntryPointCasePicker(props: {
	moduleUuid: Uuid;
	caseType: string;
	maximum: number;
	name: string;
	personaUuid?: string;
	selected: readonly string[];
	parentCase?: ParentCaseSelection;
	disabled: boolean;
	onChange: (ids: readonly string[]) => void;
}) {
	const appId = useAppId();
	const epoch = useProjectScopeEpoch();
	const id = useId();
	const [page, setPage] = useState(0);
	const parentKey = JSON.stringify(props.parentCase);
	const reloadToken = useMemo(
		() => [appId, epoch, props.caseType, props.personaUuid, parentKey, page],
		[appId, epoch, props.caseType, props.personaUuid, parentKey, page],
	);
	type State = LoadCasesResult | { kind: "loading" };
	const { state, reload } = useReloadableResource<State>({
		prepare: () =>
			appId
				? {
						fetch: () =>
							loadCasesAction({
								appId,
								caseType: props.caseType,
								personaUuid: props.personaUuid,
								parentCase: props.parentCase,
								page: { offset: page * 50, limit: 50 },
							}),
					}
				: { notReady: { kind: "loading" } },
		loading: { kind: "loading" },
		toError: () => ({
			kind: "error",
			message: "We could not load these cases. Try again.",
		}),
		keepStale: () => false,
		reloadToken,
	});
	const rows = state.kind === "rows" ? state.rows : [];
	const names = new Map(rows.map((row) => [row.case_id, row.case_name]));
	return (
		<Field>
			<FieldLabel htmlFor={id}>{props.name} cases</FieldLabel>
			<Select
				value={null}
				disabled={
					props.disabled ||
					state.kind !== "rows" ||
					props.selected.length >= props.maximum
				}
				onValueChange={(value) => {
					if (typeof value === "string" && !props.selected.includes(value))
						props.onChange([...props.selected, value]);
				}}
			>
				<SelectTrigger id={id}>
					<SelectValue
						placeholder={
							state.kind === "loading" ? "Loading cases" : "Choose a case"
						}
					/>
				</SelectTrigger>
				<SelectContent>
					{rows
						.filter((row) => !props.selected.includes(row.case_id))
						.map((row) => (
							<SelectItem key={row.case_id} value={row.case_id}>
								{row.case_name || row.case_id}
							</SelectItem>
						))}
				</SelectContent>
			</Select>
			<FieldDescription>
				{props.maximum === 1
					? "Choose one case."
					: `Choose up to ${props.maximum} cases. They open in the order selected.`}
			</FieldDescription>
			{props.selected.length > 0 && (
				<ol className="space-y-1">
					{props.selected.map((caseId) => (
						<li
							key={caseId}
							className="flex items-center justify-between gap-2"
						>
							<span className="text-sm break-all">
								{names.get(caseId) || caseId}
							</span>
							<Button
								variant="ghost"
								disabled={props.disabled}
								onClick={() =>
									props.onChange(props.selected.filter((id) => id !== caseId))
								}
							>
								Remove
							</Button>
						</li>
					))}
				</ol>
			)}
			{state.kind === "rows" && rows.length === 0 && (
				<p className="text-sm text-muted-foreground">
					No cases are available to this worker here.
				</p>
			)}
			{state.kind !== "rows" && state.kind !== "loading" && (
				<div role="alert">
					<p className="text-sm">
						{"message" in state ? state.message : "Sign in to load cases."}
					</p>
					<Button variant="ghost" onClick={() => void reload()}>
						Try again
					</Button>
				</div>
			)}
			<div className="flex gap-2">
				<Button
					variant="ghost"
					disabled={props.disabled || page === 0}
					onClick={() => setPage(page - 1)}
				>
					Previous cases
				</Button>
				<Button
					variant="ghost"
					disabled={props.disabled || rows.length < 50}
					onClick={() => setPage(page + 1)}
				>
					More cases
				</Button>
			</div>
		</Field>
	);
}
