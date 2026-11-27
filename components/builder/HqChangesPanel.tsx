/**
 * What changed in CommCare HQ to an app Nova publishes there, and the ways
 * on: bring the changes in, use CommCare HQ's version, publish over it, or
 * stop publishing here. One component, drawn in the publish dialog's stop on
 * a change to the app and in the Publishing card's dialog.
 *
 * It reads its review once it mounts and sends what the person presses, each
 * a plain request to a route that answers a stream of stages
 * (`hqChangesClient.ts`, sent by `hqChangesRequester.ts`). Every state, every
 * choice it offers and every word of it is `hqChangesPanelModel.ts`'s, from
 * `lib/publish/hqChangesCopy.ts`; this draws what `panelView` returns and
 * hands the surface around it what a choice or an answer means for it.
 *
 * A bring-in's commit reloads the app in this tab too, and the reload closes
 * every dialog. So a bring-in that answers once the panel is gone, and a
 * panel that leaves during a reload while it shows the changes are in, hold
 * the answer in the session (`HqChangesBroughtIn`), where the surface that
 * asked opens on it again once the reload lands.
 */
"use client";

import {
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useReducer,
	useRef,
	useState,
} from "react";
import { AccountFindings } from "@/components/bring-in/BringInAccount";
import { BringInStopBlock } from "@/components/bring-in/BringInStop";
import { ReviewOwnerRuleChoice } from "@/components/bring-in/ReviewOwnerRuleChoice";
import { ReviewTableChoice } from "@/components/bring-in/ReviewTableChoice";
import {
	postHqChangesBringIn,
	postHqChangesReview,
} from "@/components/builder/hqChangesClient";
import {
	bothListsText,
	type HqChangesPanelEvent,
	type HqChangesPanelHome,
	type HqChangesPanelState,
	type HqChangesSettled,
	initialHqChangesPanel,
	type ListsView,
	type ListView,
	nextRequest,
	type PanelView,
	panelView,
	publishOverDiscard,
	reduceHqChangesPanel,
	shownChanges,
} from "@/components/builder/hqChangesPanelModel";
import {
	createHqChangesRequester,
	type HqChangesRequester,
} from "@/components/builder/hqChangesRequester";
import {
	StopPublishingDialog,
	type StopPublishingTarget,
} from "@/components/builder/StopPublishingDialog";
import { Button } from "@/components/shadcn/button";
import { Spinner } from "@/components/shadcn/spinner";
import { useAuth } from "@/lib/auth/hooks/useAuth";
import { useReconcilerContext } from "@/lib/collab/context";
import { type CommCareServer, deploymentServerLabel } from "@/lib/deployment";
import type { StoppedPublishingView } from "@/lib/deployment/actions";
import { hqChangesBatchId } from "@/lib/deployment/hqChanges/batchId";
import type { HqChangesOutcome } from "@/lib/deployment/hqChanges/types";
import type { RemoteChangeDiscard } from "@/lib/deployment/types";
import { languageTag } from "@/lib/domain/localization";
import { DRIFT_STOP_EDITOR_LINE } from "@/lib/publish/bringInCopy";
import { madeByLine } from "@/lib/publish/documentChangeCopy";
import {
	type DriftReference,
	viewerDriftDate,
} from "@/lib/publish/driftReference";
import {
	CHECK_AGAIN_ACTION,
	COPY_BOTH_LISTS_ACTION,
	HQ_CHANGES_STILL_READING,
	LISTS_COPIED_LINE,
	LISTS_NOT_COPIED_LINE,
	NEXT_PUBLISH_GOES_AHEAD,
	NEXT_PUBLISH_LEAD,
	PUBLISH_OVER_HQ_ACTION,
	showAllAction,
} from "@/lib/publish/hqChangesCopy";
import type { CircumstanceContext } from "@/lib/publish/hqFindingCopy";
import { OWNER_RULE_OTHERWISE } from "@/lib/publish/ownerRuleCopy";
import {
	STOP_PUBLISHING_ACTION,
	STOP_PUBLISHING_HELPER,
} from "@/lib/publish/stopPublishing";
import type { HqChangesBroughtIn } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";

/** How long a request runs before the stage row keeps the person company. */
const SLOW_AFTER_MS = 10_000;

/** How long the line that both lists were copied stays. */
const COPIED_MS = 4_000;

export interface HqChangesPanelProps {
	readonly home: HqChangesPanelHome;
	/** The deployment: the app and the project space it publishes to. */
	readonly target: {
		readonly appId: string;
		readonly server: CommCareServer;
		readonly domain: string;
	};
	/**
	 * The deployment's id, which the bring-in's batch id is derived from so
	 * this tab says nothing of the reload its own bring-in forces. Null where
	 * the record is not held yet.
	 */
	readonly deploymentId: string | null;
	/**
	 * What the surface knows the change is measured against: the refused
	 * change's own, or the card's record's. A review that names its own is
	 * read by it instead.
	 */
	readonly since: DriftReference;
	/** The HQ app's id, for an account's links into CommCare HQ; null where none is mapped. */
	readonly remoteAppId: string | null;
	/** A member who may delete the Project's apps can stop publishing here. */
	readonly canStop: boolean;
	/** The panel settled: nothing to bring in, or the changes are in. */
	readonly onSettled: (settled: HqChangesSettled) => void;
	/** Publish over CommCare HQ's changes, with the discard that names them as the review read them. */
	readonly onPublishOver: (discard: RemoteChangeDiscard) => void;
	/**
	 * On the card, under a state whose sentence names publishing over with no
	 * digest to name it by (`PanelView.waysOn`): open the Publish dialog on
	 * the project space, where the publish stops on the change with its own
	 * Publish over this. Absent in the publish dialog, whose item is that.
	 */
	readonly onOpenPublish?: () => void;
	/** Publishing here stopped, from the panel's own Stop publishing here. */
	readonly onStopped: (next: StoppedPublishingView) => void;
	/**
	 * The stop answered anything else, or its answer was lost: the surface
	 * reads its records again, since a lost answer may follow a stop that
	 * landed (`StopPublishingDialog`'s `onRecordsStale`).
	 */
	readonly onRecordsStale: () => void;
	/**
	 * The app's change as the publish dialog draws it without the panel: its
	 * parts, its Publish over this and the stop block. Drawn under the panel
	 * where the panel offers no choice of its own.
	 */
	readonly item?: ReactNode;
}

/** True once the request that began at `startedAt` has run ten seconds. */
function useSlowWait(startedAt: number | null): boolean {
	const [reachedFor, setReachedFor] = useState<number | null>(null);
	useEffect(() => {
		if (startedAt === null) return;
		const remaining = startedAt + SLOW_AFTER_MS - Date.now();
		if (remaining <= 0) {
			setReachedFor(startedAt);
			return;
		}
		const timer = setTimeout(() => setReachedFor(startedAt), remaining);
		return () => clearTimeout(timer);
	}, [startedAt]);
	return startedAt !== null && reachedFor === startedAt;
}

export function HqChangesPanel({
	home,
	target,
	deploymentId,
	since,
	remoteAppId,
	canStop,
	onSettled,
	onPublishOver,
	onStopped,
	onRecordsStale,
	onOpenPublish,
	item,
}: HqChangesPanelProps): ReactElement {
	const [state, dispatch] = useReducer(reduceHqChangesPanel, null, () =>
		initialHqChangesPanel(Date.now()),
	);
	const reconciler = useReconcilerContext();
	const session = useBuilderSessionApi();
	const { user } = useAuth();
	const memberId = user?.id ?? null;
	const { appId, server, domain } = target;

	/* What a bring-in that lands means once the panel that sent it is gone:
	 * the answer is held for this panel's surface to show. Read through a
	 * ref, so the requester built once reads this render's values. */
	const holdRef = useRef<
		(outcome: HqChangesOutcome, projectId: string) => void
	>(() => undefined);
	holdRef.current = (outcome, projectId) => {
		if (outcome.kind !== "brought-in") return;
		session.getState().holdHqChangesBroughtIn({
			home,
			server,
			domain,
			projectId,
			deployment: outcome.deployment,
			discarded: outcome.discarded,
		});
	};
	const beforeBringInRef = useRef<(reviewDigest: string) => void>(
		() => undefined,
	);
	beforeBringInRef.current = (reviewDigest) => {
		/* The reload this bring-in forces says nothing in this tab, which
		 * shows its own answer. */
		if (deploymentId !== null && memberId !== null) {
			reconciler?.registerOwnHqChangesBatch?.(
				hqChangesBatchId({ deploymentId, reviewDigest, memberId }),
			);
		}
	};
	/* The Project a bring-in was sent in, which its answer is held under. */
	const sentInProject = useRef<string | undefined>(undefined);
	const [requester] = useState<HqChangesRequester>(() =>
		createHqChangesRequester({
			postReview: postHqChangesReview,
			postBringIn: postHqChangesBringIn,
			dispatch,
			beforeBringIn: (request) => {
				sentInProject.current = session.getState().projectId;
				beforeBringInRef.current(request.reviewDigest);
			},
			answeredAfterStop: (outcome) => {
				const projectId = sentInProject.current;
				if (projectId !== undefined) holdRef.current(outcome, projectId);
			},
		}),
	);

	/* The changes are in, as this panel shows them: what it hands the
	 * session where it leaves while the app reloads. */
	const shownBroughtIn = useRef<HqChangesBroughtIn | null>(null);
	const { phase } = state;
	const projectId = session.getState().projectId;
	shownBroughtIn.current =
		phase.kind === "settled" &&
		phase.outcome?.kind === "brought-in" &&
		projectId !== undefined
			? {
					home,
					server,
					domain,
					projectId,
					deployment: phase.outcome.deployment,
					discarded: phase.outcome.discarded,
				}
			: null;

	/* Started while mounted. A panel that leaves while app access is being
	 * refreshed (the reload its own bring-in forced closes every dialog)
	 * holds the answer it showed, so its surface shows it again. */
	useEffect(() => {
		requester.start();
		return () => {
			requester.stop();
			const shown = shownBroughtIn.current;
			if (shown !== null && session.getState().accessPhase !== "authorized") {
				session.getState().holdHqChangesBroughtIn(shown);
			}
		};
	}, [requester, session]);

	/* Each request is named once by the model and sent once by the requester. */
	const request = nextRequest(state);
	useEffect(() => {
		if (request !== null) requester.send(request, { appId, server, domain });
	}, [request, requester, appId, server, domain]);

	/* What the surface does once the panel settles, once per settling. */
	const onSettledRef = useRef(onSettled);
	onSettledRef.current = onSettled;
	const lastSettled = useRef(0);
	useEffect(() => {
		const { settled } = state;
		if (settled === null || settled.id <= lastSettled.current) return;
		lastSettled.current = settled.id;
		onSettledRef.current(settled);
	}, [state]);

	/* Both lists copied: the line stays four seconds. */
	useEffect(() => {
		if (state.copy !== "copied") return;
		const timer = setTimeout(
			() => dispatch({ type: "copy-cleared" }),
			COPIED_MS,
		);
		return () => clearTimeout(timer);
	}, [state.copy]);

	const live = useRef(true);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
		};
	}, []);
	const copyBoth = useCallback(() => {
		const review = shownChanges(state);
		if (review === null) return;
		if (typeof navigator.clipboard?.writeText !== "function") {
			dispatch({ type: "copy-refused" });
			return;
		}
		navigator.clipboard.writeText(bothListsText(review)).then(
			() => {
				if (live.current) dispatch({ type: "copied" });
			},
			() => {
				if (live.current) dispatch({ type: "copy-refused" });
			},
		);
	}, [state]);

	const publishOver = useCallback(() => {
		const discard = publishOverDiscard(state, appId);
		if (discard !== null) onPublishOver(discard);
	}, [state, appId, onPublishOver]);

	const checkAgain = useCallback(
		() => dispatch({ type: "check", at: Date.now() }),
		[],
	);

	const view = panelView(state, {
		home,
		domain,
		since,
		dateOptions: viewerDriftDate(),
	});
	const context: CircumstanceContext = {
		server: deploymentServerLabel(server),
		space: domain,
		app: null,
		formatDate: (iso) =>
			new Date(iso).toLocaleDateString(undefined, {
				day: "numeric",
				month: "long",
				year: "numeric",
			}),
	};

	return (
		<div
			className="mt-3 flex flex-col gap-3 text-left"
			data-hq-changes-panel={home}
		>
			{view.moved !== null ? (
				<p role="status" className="text-[13px] leading-relaxed text-nova-text">
					{view.moved}
				</p>
			) : null}
			<PanelBody
				view={view}
				state={state}
				target={target}
				remoteAppId={remoteAppId}
				context={context}
				canStop={canStop}
				dispatch={dispatch}
				onCheckAgain={checkAgain}
				onCopyBoth={copyBoth}
				onPublishOver={publishOver}
				onStopped={onStopped}
				onRecordsStale={onRecordsStale}
			/>
			{view.stage !== null ? <StageRow stage={view.stage} /> : null}
			{view.drawsItem ? item : null}
			{view.waysOn ? (
				<CardWaysOn
					target={stopTargetOf(target, remoteAppId)}
					canStop={canStop}
					onOpenPublish={onOpenPublish}
					onStopped={onStopped}
					onRecordsStale={onRecordsStale}
				/>
			) : null}
		</div>
	);
}

/**
 * On the card, the two ways on a state's sentence names: publishing over,
 * which opens the Publish dialog on the project space, and stopping
 * publishing here (or, for a member who may not, who can).
 */
/** The stop a surface offers: the deployment and the HQ app it maps, or none where it maps none. */
function stopTargetOf(
	target: HqChangesPanelProps["target"],
	remoteAppId: string | null,
): StopPublishingTarget | null {
	return remoteAppId === null ? null : { ...target, hqAppId: remoteAppId };
}

function CardWaysOn({
	target,
	canStop,
	onOpenPublish,
	onStopped,
	onRecordsStale,
}: {
	/** Null where the deployment maps no HQ app, so there is nothing to stop. */
	readonly target: StopPublishingTarget | null;
	readonly canStop: boolean;
	readonly onOpenPublish: (() => void) | undefined;
	readonly onStopped: (next: StoppedPublishingView) => void;
	readonly onRecordsStale: () => void;
}): ReactElement {
	const stopHelperId = useId();
	const [stopOpen, setStopOpen] = useState(false);
	return (
		<div className="flex flex-col gap-3" data-hq-changes-ways-on>
			{onOpenPublish !== undefined ? (
				<Button
					type="button"
					variant="outline"
					className="self-start"
					onClick={onOpenPublish}
				>
					{PUBLISH_OVER_HQ_ACTION}
				</Button>
			) : null}
			{target === null ? null : canStop ? (
				<div className="flex flex-col gap-1">
					<Button
						type="button"
						variant="ghost"
						className="self-start"
						aria-describedby={stopHelperId}
						onClick={() => setStopOpen(true)}
					>
						{STOP_PUBLISHING_ACTION}
					</Button>
					<p
						id={stopHelperId}
						className="text-[13px] leading-relaxed text-nova-text-secondary"
					>
						{STOP_PUBLISHING_HELPER}
					</p>
					<StopPublishingDialog
						open={stopOpen}
						onOpenChange={setStopOpen}
						target={target}
						onStopped={onStopped}
						onRecordsStale={onRecordsStale}
					/>
				</div>
			) : (
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					{DRIFT_STOP_EDITOR_LINE}
				</p>
			)}
		</div>
	);
}

/** The stage row: one spinner, the stage the stream names, and patient company after ten seconds. */
function StageRow({
	stage,
}: {
	readonly stage: NonNullable<PanelView["stage"]>;
}): ReactElement {
	const slow = useSlowWait(stage.startedAt);
	return (
		<div className="flex flex-col gap-1" data-hq-changes-stage>
			<p
				role="status"
				className="flex items-start gap-2 text-[13px] text-nova-text-secondary"
			>
				<Spinner
					role="presentation"
					aria-label={undefined}
					aria-hidden="true"
					className="mt-0.5 size-4 shrink-0 text-nova-text-muted"
				/>
				<span aria-hidden="true">{stage.label}</span>
				<span className="sr-only">{stage.announced}</span>
			</p>
			{slow ? (
				<p className="pl-6 text-[13px] text-nova-text-secondary">
					{HQ_CHANGES_STILL_READING}
				</p>
			) : null}
		</div>
	);
}

function Lines({
	list,
	label,
	onShowAll,
}: {
	readonly list: ListView;
	readonly label: string;
	readonly onShowAll: () => void;
}): ReactElement {
	return (
		<>
			<ul
				aria-label={label}
				className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed text-nova-text-secondary [overflow-wrap:anywhere]"
			>
				{list.shown.map((line, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: two lines can read alike, so the text is no key.
					<li key={index}>{line}</li>
				))}
			</ul>
			{list.showAll !== null ? (
				<Button
					type="button"
					variant="ghost"
					className="self-start"
					onClick={onShowAll}
				>
					{showAllAction(list.showAll)}
				</Button>
			) : null}
		</>
	);
}

interface BodyProps {
	readonly view: PanelView;
	readonly state: HqChangesPanelState;
	readonly target: HqChangesPanelProps["target"];
	readonly remoteAppId: string | null;
	readonly context: CircumstanceContext;
	readonly canStop: boolean;
	readonly dispatch: (event: HqChangesPanelEvent) => void;
	readonly onCheckAgain: () => void;
	readonly onCopyBoth: () => void;
	readonly onPublishOver: () => void;
	readonly onStopped: (next: StoppedPublishingView) => void;
	readonly onRecordsStale: () => void;
}

function CheckAgain({ onPress }: { readonly onPress: () => void }) {
	return (
		<Button
			type="button"
			variant="outline"
			className="self-start"
			onClick={onPress}
		>
			{CHECK_AGAIN_ACTION}
		</Button>
	);
}

function NextPublish({ lines }: { readonly lines: readonly string[] }) {
	if (lines.length === 0) return null;
	return (
		<div className="text-[13px] leading-relaxed text-nova-text-secondary">
			<p className="text-nova-text">{NEXT_PUBLISH_LEAD}</p>
			<ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
				{lines.map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
		</div>
	);
}

function PanelBody(props: BodyProps): ReactNode {
	const { view, target, remoteAppId, context, onCheckAgain } = props;
	const { body } = view;
	switch (body.kind) {
		case "loading":
			return null;
		case "lists":
			return <ListsBody {...props} lists={body} />;
		case "nothing":
			return (
				<div className="flex flex-col gap-2">
					<p
						role="status"
						className="text-[13px] leading-relaxed text-nova-text"
					>
						{body.line}
						{body.goesAhead ? ` ${NEXT_PUBLISH_GOES_AHEAD}` : ""}
					</p>
					{body.hqChanges.length > 0 ? (
						<ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed text-nova-text-secondary">
							{body.hqChanges.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
					) : null}
					<NextPublish lines={body.publishChanges} />
				</div>
			);
		case "brought-in":
			return (
				<p role="status" className="text-[13px] leading-relaxed text-nova-text">
					{body.line}
				</p>
			);
		case "line":
			return (
				<div className="flex flex-col gap-2">
					<p
						role={body.role}
						className="text-[13px] leading-relaxed text-nova-text"
					>
						{body.line}
					</p>
					{body.translation && (
						<a
							href={`/build/${encodeURIComponent(props.target.appId)}/setup/languages?lang=${encodeURIComponent(languageTag(body.translation.language))}#${encodeURIComponent(body.translation.unitId)}`}
							className="nova-focusable inline-flex min-h-11 w-fit items-center rounded-lg text-sm font-medium text-nova-text underline underline-offset-4"
							target="_blank"
							rel="noreferrer"
						>
							Review translation
						</a>
					)}
					{body.checkAgain ? <CheckAgain onPress={onCheckAgain} /> : null}
				</div>
			);
		case "stop":
			return (
				<BringInStopBlock finding={body.finding} context={context}>
					<CheckAgain onPress={onCheckAgain} />
				</BringInStopBlock>
			);
		case "account":
			return (
				<section className="flex flex-col gap-3" data-hq-changes-account>
					<h4 className="text-sm font-semibold text-nova-text">
						{body.heading}
					</h4>
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						{body.lead}
					</p>
					{body.tooLarge !== null ? (
						<BringInStopBlock finding={body.tooLarge} context={context} />
					) : (
						<>
							<AccountFindings
								answer={{
									kind: "account",
									appName: null,
									findings: body.account.findings,
									more: body.account.more,
									counts: body.account.counts,
									mediaChecked: true,
								}}
								target={{
									server: target.server,
									domain: target.domain,
									remoteAppId: remoteAppId ?? "",
								}}
								context={context}
							/>
							<CheckAgain onPress={onCheckAgain} />
						</>
					)}
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						{body.otherWays}
					</p>
				</section>
			);
	}
}

function ListsBody({
	lists,
	state,
	target,
	remoteAppId,
	canStop,
	dispatch,
	onCheckAgain,
	onCopyBoth,
	onPublishOver,
	onStopped,
	onRecordsStale,
}: BodyProps & { readonly lists: ListsView }): ReactElement {
	const hqHeadingId = useId();
	const novaHeadingId = useId();
	const { choices, nova } = lists;
	return (
		<div className="flex flex-col gap-3" data-hq-changes-lists>
			<section aria-labelledby={hqHeadingId} className="flex flex-col gap-1.5">
				<h4 id={hqHeadingId} className="text-sm font-semibold text-nova-text">
					{lists.hqHeading}
				</h4>
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					{lists.hqLead}
				</p>
				<Lines
					list={lists.hqList}
					label={lists.hqHeading}
					onShowAll={() => dispatch({ type: "show-all", list: "hq" })}
				/>
				{lists.caseData.map((line) => (
					<p key={line} className="text-[13px] leading-relaxed text-nova-text">
						{line}
					</p>
				))}
				<NextPublish lines={lists.publishChanges} />
			</section>
			{nova !== null ? (
				<section
					aria-labelledby={novaHeadingId}
					className="flex flex-col gap-1.5"
				>
					<h4
						id={novaHeadingId}
						className="text-sm font-semibold text-nova-text"
					>
						{nova.heading}
					</h4>
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						{nova.lead}
					</p>
					{nova.madeBy.length > 0 ? (
						<p className="text-[13px] leading-relaxed text-nova-text-secondary">
							{madeByLine(nova.madeBy)}
						</p>
					) : null}
					<Lines
						list={nova.list}
						label={nova.heading}
						onShowAll={() => dispatch({ type: "show-all", list: "nova" })}
					/>
				</section>
			) : null}
			{lists.copyBoth ? (
				<div className="flex flex-wrap items-center gap-x-3">
					<Button type="button" variant="ghost" onClick={onCopyBoth}>
						{COPY_BOTH_LISTS_ACTION}
					</Button>
					<p role="status" className="text-[13px] text-nova-text-secondary">
						{state.copy === "copied"
							? LISTS_COPIED_LINE
							: state.copy === "refused"
								? LISTS_NOT_COPIED_LINE
								: ""}
					</p>
				</div>
			) : null}
			{lists.tables.map((table) => (
				<ReviewTableChoice
					key={table.tag}
					table={table}
					project={lists.projectName}
					domain={target.domain}
					value={state.tableChoices[table.tag] ?? null}
					onValueChange={(choice) =>
						dispatch({ type: "table-chosen", tag: table.tag, choice })
					}
					needsChoice={
						state.tableChoices[table.tag] === undefined
							? state.needsChoice
							: null
					}
				/>
			))}
			{lists.ownerRules.map((rule) => (
				<ReviewOwnerRuleChoice
					key={rule.level}
					rule={rule}
					domain={target.domain}
					value={state.ownerRuleChoices[rule.level] ?? null}
					onValueChange={(choice) =>
						dispatch({ type: "owner-rule-chosen", level: rule.level, choice })
					}
					needsChoice={
						state.ownerRuleChoices[rule.level] === undefined
							? state.needsChoice
							: null
					}
				/>
			))}
			{lists.ownerRules.length > 0 ? (
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					{OWNER_RULE_OTHERWISE}
				</p>
			) : null}
			{lists.notice !== null ? (
				<div
					role={lists.notice.role}
					className="rounded-lg border border-nova-amber/40 bg-nova-amber/10 px-3 py-2.5 text-[13px] leading-relaxed text-nova-text"
				>
					{lists.notice.lines.map((line, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a finding's sentence can repeat another's.
						<p key={index}>{line}</p>
					))}
					{lists.notice.checkAgain ? (
						<div className="mt-2">
							<CheckAgain onPress={onCheckAgain} />
						</div>
					) : null}
				</div>
			) : null}
			{choices !== null ? (
				<Choices
					choices={choices}
					target={stopTargetOf(target, remoteAppId)}
					canStop={canStop}
					dispatch={dispatch}
					onCheckAgain={onCheckAgain}
					onPublishOver={onPublishOver}
					onStopped={onStopped}
					onRecordsStale={onRecordsStale}
				/>
			) : null}
		</div>
	);
}

function Choices({
	choices,
	target,
	canStop,
	dispatch,
	onCheckAgain,
	onPublishOver,
	onStopped,
	onRecordsStale,
}: {
	readonly choices: NonNullable<ListsView["choices"]>;
	/** Null where the deployment maps no HQ app, so there is nothing to stop. */
	readonly target: StopPublishingTarget | null;
	readonly canStop: boolean;
	readonly dispatch: BodyProps["dispatch"];
	readonly onCheckAgain: () => void;
	readonly onPublishOver: () => void;
	readonly onStopped: (next: StoppedPublishingView) => void;
	readonly onRecordsStale: () => void;
}): ReactElement {
	const bringInHelperId = useId();
	const publishOverHelperId = useId();
	const stopHelperId = useId();
	const [stopOpen, setStopOpen] = useState(false);
	const { bringIn, renamed, publishOver } = choices;
	return (
		<div className="flex flex-col gap-3" data-hq-changes-choices>
			{bringIn !== null ? (
				<div className="flex flex-col gap-1">
					<Button
						type="button"
						className="self-start"
						aria-describedby={
							bringIn.helper !== null ? bringInHelperId : undefined
						}
						onClick={() =>
							dispatch({
								type: "bring-in-pressed",
								discard: bringIn.discard,
								at: Date.now(),
							})
						}
					>
						{bringIn.label}
					</Button>
					{bringIn.helper !== null ? (
						<p
							id={bringInHelperId}
							className="text-[13px] leading-relaxed text-nova-text-secondary"
						>
							{bringIn.helper}
						</p>
					) : null}
				</div>
			) : null}
			{renamed !== null ? (
				<div className="flex flex-col gap-1">
					<p className="text-[13px] leading-relaxed text-nova-text">
						{renamed}
					</p>
					<CheckAgain onPress={onCheckAgain} />
				</div>
			) : null}
			{publishOver !== null ? (
				<div className="flex flex-col gap-1">
					{publishOver.lead !== null ? (
						<p className="text-[13px] leading-relaxed text-nova-text-secondary">
							{publishOver.lead}
						</p>
					) : null}
					<Button
						type="button"
						variant={publishOver.lead !== null ? "ghost" : "outline"}
						className="self-start"
						aria-describedby={
							publishOver.helper !== null ? publishOverHelperId : undefined
						}
						onClick={onPublishOver}
					>
						{publishOver.label}
					</Button>
					{publishOver.helper !== null ? (
						<p
							id={publishOverHelperId}
							className="text-[13px] leading-relaxed text-nova-text-secondary"
						>
							{publishOver.helper}
						</p>
					) : null}
				</div>
			) : null}
			{choices.stop && target !== null ? (
				canStop ? (
					<div className="flex flex-col gap-1">
						<Button
							type="button"
							variant="ghost"
							className="self-start"
							aria-describedby={stopHelperId}
							onClick={() => setStopOpen(true)}
						>
							{STOP_PUBLISHING_ACTION}
						</Button>
						<p
							id={stopHelperId}
							className="text-[13px] leading-relaxed text-nova-text-secondary"
						>
							{STOP_PUBLISHING_HELPER}
						</p>
						<StopPublishingDialog
							open={stopOpen}
							onOpenChange={setStopOpen}
							target={target}
							onStopped={onStopped}
							onRecordsStale={onRecordsStale}
						/>
					</div>
				) : (
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						{DRIFT_STOP_EDITOR_LINE}
					</p>
				)
			) : null}
		</div>
	);
}
