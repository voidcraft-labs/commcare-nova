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
import { withNavigationWidth } from "@/lib/preview/engine/previewDevice";
import { loadEntryPointOtherCasesAction } from "@/lib/preview/entryPointLaunchAction";
import {
	useEntryPointLaunch,
	useEntryPointPreviewSetup,
} from "@/lib/preview/hooks/useEntryPointLaunch";
import { useReloadableResource } from "@/lib/preview/hooks/useReloadableResource";
import {
	useAppId,
	usePreviewClaimedCaseIds,
	usePreviewDevice,
	usePreviewPersonaUuid,
	usePreviewPlatformRules,
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
					Preview uses this worker’s cases, including ones they chose from a
					search.
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
	/* A claimed case is held, so the picker offers it like any other. */
	const claimedCaseIds = usePreviewClaimedCaseIds(props.personaUuid);
	const device = usePreviewDevice();
	const reloadToken = useMemo(
		() => [
			appId,
			epoch,
			props.caseType,
			props.personaUuid,
			parentKey,
			page,
			claimedCaseIds,
			device.platform,
		],
		[
			appId,
			epoch,
			props.caseType,
			props.personaUuid,
			parentKey,
			page,
			claimedCaseIds,
			device.platform,
		],
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
								claimedCaseIds: [...claimedCaseIds],
								parentCase: props.parentCase,
								page: { offset: page * 50, limit: 50 },
								device: withNavigationWidth(device),
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
	/* The Project's open cases of this type that the worker's restore does
	 * not hold: Web Apps claims one chosen here, and Android opens the form
	 * without its saved values, as each platform does with a case the
	 * worker's device lacks. */
	const platformRules = usePreviewPlatformRules();
	const [otherPage, setOtherPage] = useState(0);
	const otherReloadToken = useMemo(
		() => [...reloadToken, otherPage],
		[reloadToken, otherPage],
	);
	const { state: otherState } = useReloadableResource<State>({
		prepare: () =>
			appId
				? {
						fetch: () =>
							loadEntryPointOtherCasesAction({
								appId,
								caseType: props.caseType,
								personaUuid: props.personaUuid,
								claimedCaseIds: [...claimedCaseIds],
								parentCase: props.parentCase,
								page: { offset: otherPage * 50, limit: 50 },
								device: withNavigationWidth(device),
							}),
					}
				: { notReady: { kind: "loading" } },
		loading: { kind: "loading" },
		toError: () => ({
			kind: "error",
			message: "We could not load these cases. Try again.",
		}),
		keepStale: () => false,
		reloadToken: otherReloadToken,
	});
	const otherRows = otherState.kind === "rows" ? otherState.rows : [];
	const otherId = useId();
	const names = new Map(
		[...rows, ...otherRows].map((row) => [row.case_id, row.case_name]),
	);
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
			{otherRows.length > 0 || otherPage > 0 ? (
				<div className="space-y-2">
					<FieldLabel htmlFor={otherId}>
						Cases this worker doesn't have
					</FieldLabel>
					<Select
						value={null}
						disabled={
							props.disabled ||
							otherState.kind !== "rows" ||
							props.selected.length >= props.maximum
						}
						onValueChange={(value) => {
							if (typeof value === "string" && !props.selected.includes(value))
								props.onChange([...props.selected, value]);
						}}
					>
						<SelectTrigger id={otherId}>
							<SelectValue placeholder="Choose a case" />
						</SelectTrigger>
						<SelectContent>
							{otherRows
								.filter((row) => !props.selected.includes(row.case_id))
								.map((row) => (
									<SelectItem key={row.case_id} value={row.case_id}>
										{row.case_name || row.case_id}
									</SelectItem>
								))}
						</SelectContent>
					</Select>
					<FieldDescription>
						{platformRules.entryPointCaseNotHeld === "claimed"
							? "Choosing one claims it for this worker, as Web Apps does"
							: "The phone doesn't have these, so the form opens without their saved values"}
					</FieldDescription>
					<div className="flex gap-2">
						<Button
							variant="ghost"
							disabled={props.disabled || otherPage === 0}
							onClick={() => setOtherPage(otherPage - 1)}
						>
							Previous cases
						</Button>
						<Button
							variant="ghost"
							disabled={props.disabled || otherRows.length < 50}
							onClick={() => setOtherPage(otherPage + 1)}
						>
							More cases
						</Button>
					</div>
				</div>
			) : null}
		</Field>
	);
}
