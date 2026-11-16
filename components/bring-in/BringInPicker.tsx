/**
 * Choosing what to bring in: the Project the app is added to, the project
 * space, and the app, in one screen.
 *
 * Everything shown is the model's: the project spaces are the connection's
 * (the reducer chooses a lone one), the list is what the picker's route
 * answered for the chosen project space, and a row Nova already holds cannot
 * be chosen and says why. Nothing is posted from here: Read this app pushes
 * the app's address, and the address starting the read is what moves the
 * screen on, so Back returns here with the list as the person left it.
 */
"use client";

import Link from "next/link";
import { useEffect, useId, useRef } from "react";
import { BringInScreenLayout } from "@/components/bring-in/BringInScreenLayout";
import {
	BringInStopBlock,
	StopActionControl,
} from "@/components/bring-in/BringInStop";
import {
	type BringInEvent,
	type BringInModel,
	pickerStopActions,
	type StopAction,
} from "@/components/bring-in/bringInModel";
import type { BringInSeed } from "@/components/bring-in/useBringIn";
import { useCommCareConnection } from "@/components/builder/CommCareConnectionContext";
import { HqNotConnected } from "@/components/builder/HqNotConnected";
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
	Field,
	FieldDescription,
	FieldLabel,
	FieldTitle,
} from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import { RadioGroup, RadioGroupItem } from "@/components/shadcn/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { Skeleton } from "@/components/shadcn/skeleton";
import type { HqAppPickerRow } from "@/lib/deployment";
import {
	BRING_IN_ACTIONS,
	BRING_IN_NOT_CONNECTED_BODY,
	BRING_IN_NOT_CONNECTED_TITLE,
	CONNECTION_CHECK_FAILED,
	PICKER_APP_FILTER_PLACEHOLDER,
	PICKER_APP_LABEL,
	PICKER_FOOTER_LINE,
	PICKER_HEADING,
	PICKER_LEAD,
	PICKER_PROJECT_LABEL,
	PICKER_READ_WAITS_LINE,
	PICKER_SPACE_LABEL,
	PICKER_SPACE_NO_MATCH,
	PICKER_SPACE_PLACEHOLDER,
	PICKER_SPACE_SELECT_PLACEHOLDER,
	pickerAppsLoadingLine,
	pickerListFailedLine,
	pickerNoAppsLine,
	pickerNoMatchLine,
	pickerOneSpaceLine,
	pickerProjectLine,
	UNNAMED_HQ_APP,
} from "@/lib/publish/bringInCopy";
import {
	HQ_APP_CLAIM_ELSEWHERE_LABEL,
	HQ_APP_CLAIM_OPEN_ACTION,
	HQ_APP_CLAIM_OPEN_LABEL,
} from "@/lib/publish/hqAppClaims";
import {
	alreadyInNovaNext,
	type CircumstanceContext,
	circumstanceBlock,
} from "@/lib/publish/hqFindingCopy";
import { READING_REFUSAL_COPY } from "@/lib/publish/hqReadingCopy";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { useDeferredFocus } from "@/lib/ui/hooks/useDeferredFocus";

/** Up to this many project spaces are a Select; more are searched. */
const SELECT_MOST_SPACES = 8;

/** Over this many apps, a filter stands above the list. */
const FILTER_OVER_APPS = 8;

const SKELETON_ROWS = ["a", "b", "c"] as const;

interface SpaceItem {
	readonly value: string;
	readonly label: string;
}

function rowName(row: HqAppPickerRow): string {
	return row.name.trim() === "" ? UNNAMED_HQ_APP : row.name;
}

/** The rows the filter leaves on screen: a case-insensitive match of the name. It never chooses. */
function shownRows(
	rows: readonly HqAppPickerRow[],
	filter: string,
): readonly HqAppPickerRow[] {
	const needle = filter.trim().toLocaleLowerCase();
	if (needle === "") return rows;
	return rows.filter((row) =>
		rowName(row).toLocaleLowerCase().includes(needle),
	);
}

export function BringInPicker({
	model,
	dispatch,
	seed,
	serverLabel,
	context,
	onReadApp,
}: {
	readonly model: BringInModel;
	readonly dispatch: (event: BringInEvent) => void;
	readonly seed: BringInSeed;
	/** The connection's server, as its label. */
	readonly serverLabel: string;
	/** What a stop met while choosing fills its block from. */
	readonly context: CircumstanceContext;
	/** Pushes the address of the chosen app, which starts its read. */
	readonly onReadApp: (remoteAppId: string) => void;
}) {
	const { picker } = model;
	const connection = useCommCareConnection();
	const ids = useId();
	const projectId = `${ids}-project`;
	const spaceId = `${ids}-space`;
	const appLabelId = `${ids}-app`;
	const readWaitsId = `${ids}-read-waits`;
	const spaceControlRef = useRef<HTMLElement | null>(null);
	const deferFocus = useDeferredFocus();

	const project = seed.projects.find((entry) => entry.id === picker.projectId);
	const loaded = picker.apps.kind === "loaded" ? picker.apps.picker : null;
	const notConnected =
		!connection.configured || loaded?.kind === "not-connected";

	/* When a check finds a connection, the fields come back and focus goes to
	 * the project space, where the person continues. */
	const awaitingConnection = useRef(false);
	const hasSpaces = picker.domains.length > 0;
	useEffect(() => {
		if (notConnected) {
			awaitingConnection.current = true;
			return;
		}
		if (!awaitingConnection.current || !hasSpaces) return;
		awaitingConnection.current = false;
		return deferFocus(() => spaceControlRef.current?.focus());
	}, [notConnected, hasSpaces, deferFocus]);
	const shown =
		loaded?.kind === "apps" ? shownRows(loaded.apps, picker.filter) : [];
	/* The app Read this app reads is the one the list shows as chosen: a chosen
	 * row the filter hides is no choice anyone can see. */
	const chosen =
		picker.remoteAppId !== null &&
		shown.some((row) => row.remoteAppId === picker.remoteAppId)
			? picker.remoteAppId
			: null;
	const appContext: CircumstanceContext = {
		...context,
		space: picker.domain ?? "",
		app: null,
	};
	/* What the screen's status region says of the App field: the list being
	 * read, then a stop met while reading it. Both arrive after the screen,
	 * so each is announced. */
	const appStatus =
		picker.domain === null || notConnected ? null : picker.apps.kind ===
			"loading" ? (
			<span className="sr-only">{pickerAppsLoadingLine(picker.domain)}</span>
		) : loaded?.kind === "stop" ? (
			<span className="sr-only">
				{circumstanceBlock(loaded.finding, appContext).title}
			</span>
		) : null;
	const spaceItems: readonly SpaceItem[] = picker.domains.map((name) => ({
		value: name,
		label:
			connection.availableDomains.find((domain) => domain.name === name)
				?.displayName ?? name,
	}));

	const footer = (
		<>
			{project !== undefined ? (
				<Button
					type="button"
					aria-disabled={chosen === null || undefined}
					aria-describedby={chosen === null ? readWaitsId : undefined}
					className="aria-disabled:cursor-not-allowed aria-disabled:opacity-(--disabled-opacity)"
					onClick={() => {
						if (chosen !== null) onReadApp(chosen);
					}}
				>
					{BRING_IN_ACTIONS.readThisApp}
				</Button>
			) : (
				<Button
					variant="outline"
					nativeButton={false}
					render={<Link href="/" />}
				>
					{BRING_IN_ACTIONS.goToYourApps}
				</Button>
			)}
			{project !== undefined ? (
				<Button type="button" variant="outline" onClick={() => onCancel()}>
					{BRING_IN_ACTIONS.cancel}
				</Button>
			) : null}
		</>
	);

	return (
		<BringInScreenLayout
			title={PICKER_HEADING}
			description={PICKER_LEAD}
			status={appStatus}
			footer={footer}
			footerNote={
				project !== undefined ? (
					<>
						{PICKER_FOOTER_LINE}
						<span id={readWaitsId} className="sr-only">
							{PICKER_READ_WAITS_LINE}
						</span>
					</>
				) : undefined
			}
		>
			{project === undefined ? (
				<p role="alert" className="text-sm leading-relaxed text-nova-text">
					{READING_REFUSAL_COPY.no_project_access}
				</p>
			) : (
				<div className="flex flex-col gap-5">
					<Field className="gap-1.5">
						{seed.projects.length > 1 ? (
							<>
								<FieldLabel htmlFor={projectId}>
									{PICKER_PROJECT_LABEL}
								</FieldLabel>
								<Select
									items={seed.projects.map((entry) => ({
										value: entry.id,
										label: entry.name,
									}))}
									value={project.id}
									onValueChange={(next) => {
										if (typeof next === "string")
											dispatch({ type: "picker-project", projectId: next });
									}}
								>
									<SelectTrigger id={projectId} className="w-full" wrapValue>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{seed.projects.map((entry) => (
											<SelectItem key={entry.id} value={entry.id}>
												{entry.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</>
						) : (
							<>
								<FieldTitle>{PICKER_PROJECT_LABEL}</FieldTitle>
								<p className="text-sm font-medium text-nova-text [overflow-wrap:anywhere]">
									{project.name}
								</p>
							</>
						)}
						<FieldDescription className="text-[13px] text-nova-text-muted">
							{pickerProjectLine(project)}
						</FieldDescription>
					</Field>

					{notConnected ? (
						<HqNotConnected
							title={BRING_IN_NOT_CONNECTED_TITLE}
							body={BRING_IN_NOT_CONNECTED_BODY}
							error={
								connection.refreshFailed ? CONNECTION_CHECK_FAILED : undefined
							}
							isRefreshing={connection.isRefreshing}
							onRefresh={() => {
								void connection.refresh();
							}}
						/>
					) : (
						<>
							<Field className="gap-1.5">
								{spaceItems.length === 1 ? (
									<>
										<FieldTitle>{PICKER_SPACE_LABEL}</FieldTitle>
										<p
											ref={(node) => {
												spaceControlRef.current = node;
											}}
											tabIndex={-1}
											className="text-sm text-nova-text [overflow-wrap:anywhere] focus:outline-none"
										>
											{pickerOneSpaceLine(spaceItems[0].value, serverLabel)}
										</p>
									</>
								) : spaceItems.length <= SELECT_MOST_SPACES ? (
									<>
										<FieldLabel htmlFor={spaceId}>
											{PICKER_SPACE_LABEL}
										</FieldLabel>
										<Select
											items={spaceItems}
											value={picker.domain}
											onValueChange={(next) => {
												if (typeof next === "string")
													dispatch({ type: "picker-domain", domain: next });
											}}
										>
											<SelectTrigger
												id={spaceId}
												ref={(node) => {
													spaceControlRef.current = node;
												}}
												className="w-full"
												wrapValue
											>
												<SelectValue
													placeholder={PICKER_SPACE_SELECT_PLACEHOLDER}
												/>
											</SelectTrigger>
											<SelectContent>
												{spaceItems.map((item) => (
													<SelectItem key={item.value} value={item.value}>
														{item.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</>
								) : (
									<>
										<FieldLabel htmlFor={spaceId}>
											{PICKER_SPACE_LABEL}
										</FieldLabel>
										<Combobox
											items={spaceItems}
											defaultValue={
												spaceItems.find(
													(item) => item.value === picker.domain,
												) ?? null
											}
											itemToStringLabel={(item: SpaceItem) => item.label}
											isItemEqualToValue={(
												a: SpaceItem | null,
												b: SpaceItem | null,
											) => a?.value === b?.value}
											onValueChange={(item: SpaceItem | null) => {
												if (item !== null)
													dispatch({
														type: "picker-domain",
														domain: item.value,
													});
											}}
										>
											<ComboboxInput
												id={spaceId}
												ref={(node: HTMLInputElement | null) => {
													spaceControlRef.current = node;
												}}
												placeholder={PICKER_SPACE_PLACEHOLDER}
												autoComplete="off"
												data-1p-ignore
											/>
											<ComboboxContent>
												<ComboboxEmpty>{PICKER_SPACE_NO_MATCH}</ComboboxEmpty>
												<ComboboxList>
													{(item: SpaceItem) => (
														<ComboboxItem key={item.value} value={item}>
															<span className="[overflow-wrap:anywhere]">
																{item.label}
															</span>
														</ComboboxItem>
													)}
												</ComboboxList>
											</ComboboxContent>
										</Combobox>
									</>
								)}
							</Field>

							{picker.domain !== null ? (
								<AppField
									model={model}
									dispatch={dispatch}
									labelId={appLabelId}
									context={appContext}
									shown={shown}
								/>
							) : null}
						</>
					)}
				</div>
			)}
		</BringInScreenLayout>
	);
}

/** Cancel: the composer and both ways of starting come back. */
function onCancel(): void {
	pushBuilderHistory("/build/new", true);
}

/**
 * The App field: its title, then the list, the wait for it, a list that could
 * not be read, or a stop met while reading it. The title stands through every
 * one of them, so Check again and Try again, whose own buttons leave with
 * the answer they act on, hand focus to it and keep it in the card.
 */
function AppField({
	model,
	dispatch,
	labelId,
	context,
	shown,
}: {
	readonly model: BringInModel;
	readonly dispatch: (event: BringInEvent) => void;
	readonly labelId: string;
	readonly context: CircumstanceContext;
	/** The rows the filter leaves on screen. */
	readonly shown: readonly HqAppPickerRow[];
}) {
	const { picker } = model;
	const domain = picker.domain ?? "";
	const filterId = useId();
	const titleRef = useRef<HTMLDivElement>(null);
	const deferFocus = useDeferredFocus();

	if (picker.apps.kind === "idle") return null;

	const reload = () => {
		dispatch({ type: "picker-reload" });
		deferFocus(() => titleRef.current?.focus());
	};
	const onStopAction = (action: StopAction) => {
		if (action.kind === "check-again") reload();
	};

	return (
		<div className="flex flex-col gap-2">
			<FieldTitle
				id={labelId}
				ref={titleRef}
				tabIndex={-1}
				className="outline-none"
			>
				{PICKER_APP_LABEL}
			</FieldTitle>
			<AppFieldBody
				model={model}
				domain={domain}
				labelId={labelId}
				filterId={filterId}
				context={context}
				shown={shown}
				dispatch={dispatch}
				onReload={reload}
				onStopAction={onStopAction}
			/>
		</div>
	);
}

function AppFieldBody({
	model,
	domain,
	labelId,
	filterId,
	context,
	shown,
	dispatch,
	onReload,
	onStopAction,
}: {
	readonly model: BringInModel;
	readonly domain: string;
	readonly labelId: string;
	readonly filterId: string;
	readonly context: CircumstanceContext;
	readonly shown: readonly HqAppPickerRow[];
	readonly dispatch: (event: BringInEvent) => void;
	readonly onReload: () => void;
	readonly onStopAction: (action: StopAction) => void;
}) {
	const { picker } = model;

	if (picker.apps.kind === "idle") return null;

	if (picker.apps.kind === "loading") {
		/* The screen's status region says this line; the drawn one is its
		 * place in the field. */
		return (
			<>
				<p className="text-[13px] text-nova-text-muted">
					{pickerAppsLoadingLine(domain)}
				</p>
				{SKELETON_ROWS.map((key) => (
					<Skeleton key={key} className="h-11 w-full rounded-lg" />
				))}
			</>
		);
	}

	if (picker.apps.kind === "failed") {
		return (
			<>
				<p role="alert" className="text-sm leading-relaxed text-nova-text">
					{pickerListFailedLine(domain)}
				</p>
				<div>
					<Button type="button" variant="outline" onClick={onReload}>
						{BRING_IN_ACTIONS.tryAgain}
					</Button>
				</div>
			</>
		);
	}

	const answer = picker.apps.picker;
	if (answer.kind === "not-connected") return null;
	if (answer.kind === "stop") {
		const actions = pickerStopActions(answer.finding);
		return (
			<BringInStopBlock
				finding={answer.finding}
				context={context}
				nothingChanged="read"
			>
				{actions.map((action, index) => (
					<StopActionControl
						key={action.kind}
						action={action}
						primary={index === 0}
						onAction={onStopAction}
					/>
				))}
			</BringInStopBlock>
		);
	}

	if (answer.apps.length === 0) {
		return (
			<p className="text-sm text-nova-text-muted">{pickerNoAppsLine(domain)}</p>
		);
	}

	return (
		<>
			{answer.apps.length > FILTER_OVER_APPS ? (
				<Input
					id={filterId}
					type="search"
					aria-label={PICKER_APP_FILTER_PLACEHOLDER}
					placeholder={PICKER_APP_FILTER_PLACEHOLDER}
					value={picker.filter}
					onChange={(event) =>
						dispatch({ type: "picker-filter", filter: event.target.value })
					}
					autoComplete="off"
					data-1p-ignore
				/>
			) : null}
			{shown.length === 0 ? (
				<p className="text-sm text-nova-text-muted">
					{pickerNoMatchLine(domain)}
				</p>
			) : (
				<RadioGroup
					aria-labelledby={labelId}
					value={picker.remoteAppId}
					onValueChange={(next) => {
						if (typeof next === "string")
							dispatch({ type: "picker-app", remoteAppId: next });
					}}
				>
					{shown.map((row) => (
						<AppRow key={row.remoteAppId} row={row} context={context} />
					))}
				</RadioGroup>
			)}
		</>
	);
}

function AppRow({
	row,
	context,
}: {
	readonly row: HqAppPickerRow;
	readonly context: CircumstanceContext;
}) {
	const name = rowName(row);
	const { claim } = row;
	if (claim === null) {
		return <RadioGroupItem value={row.remoteAppId}>{name}</RadioGroupItem>;
	}
	if (claim.kind === "open") {
		return (
			<div className="flex items-start gap-2">
				<RadioGroupItem
					value={row.remoteAppId}
					className="min-w-0 flex-1"
					unavailableReason={
						<Badge variant="violet">{HQ_APP_CLAIM_OPEN_LABEL}</Badge>
					}
				>
					{name}
				</RadioGroupItem>
				<Button
					variant="link"
					nativeButton={false}
					aria-label={`${HQ_APP_CLAIM_OPEN_ACTION} ${name}`}
					render={<Link href={`/build/${claim.appId}`} />}
				>
					{HQ_APP_CLAIM_OPEN_ACTION}
				</Button>
			</div>
		);
	}
	return (
		<RadioGroupItem
			value={row.remoteAppId}
			unavailableReason={
				<>
					<span className="block font-medium">
						{HQ_APP_CLAIM_ELSEWHERE_LABEL}
					</span>
					<span className="mt-0.5 block">
						{alreadyInNovaNext(claim, context.formatDate)}
					</span>
				</>
			}
		>
			{name}
		</RadioGroupItem>
	);
}
