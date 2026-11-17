/**
 * The account: everything a read found that keeps the app from coming in,
 * grouped by where it lives in the app, each with a plain label, never as an
 * error. A read that cannot bring an app in names every reason at once, and
 * the person can copy the list, check again once something changed, or
 * leave.
 *
 * Every group, line, label and count is `bringInModel.ts`'s and the words
 * are `lib/publish`'s. `AccountFindings` is the account's body alone, the
 * labels, groups and the lines under them, for a surface that heads it
 * itself.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import Link from "next/link";
import {
	type ReactElement,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { keptDateText } from "@/components/builder/keptListModel";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import { Textarea } from "@/components/shadcn/textarea";
import { reportClientError } from "@/lib/clientErrorReporter";
import {
	type AccountAnswer,
	hqPlaceUrl,
	type ReadingKey,
} from "@/lib/deployment";
import {
	accountHeadingLine,
	accountLead,
	BRING_IN_ACTIONS,
	CLIPBOARD_REFUSED_LINE,
	foldedRunLine,
	NAMED_IN_HQ_LEAD,
} from "@/lib/publish/bringInCopy";
import {
	ACCOUNT_CHECK_AGAIN_LINE,
	type CircumstanceContext,
	circumstanceBlock,
	FINDING_LABELS,
	FINDING_NEXT_STEPS,
	findingLine,
} from "@/lib/publish/hqFindingCopy";
import type { Finding, FindingStanding } from "@/lib/publish/hqFindings";
import { moreFindingsLine } from "@/lib/publish/hqReadingCopy";
import { MEDIA_CHECKED_LATER } from "@/lib/publish/managedData";
import { useDeferredFocus } from "@/lib/ui/hooks/useDeferredFocus";
import { BringInScreenLayout } from "./BringInScreenLayout";
import {
	type AccountGroup,
	type AccountItem,
	accountAsText,
	accountGroups,
	accountHeading,
	accountStandings,
	answerSourceOf,
	type BringInEvent,
	type BringInModel,
	countLine,
} from "./bringInModel";

/** The badge of each label. Every label is a word; none is rose. */
const STANDING_BADGE: Readonly<
	Record<FindingStanding, "violet" | "muted" | "amber">
> = {
	"not-yet": "violet",
	never: "muted",
	"fix-in-hq": "amber",
};

/** How long Copy the list reads Copied. */
const COPIED_MS = 2000;

function StandingBadge({
	standing,
}: {
	readonly standing: FindingStanding;
}): ReactElement {
	return (
		<Badge variant={STANDING_BADGE[standing]} className="w-fit">
			{FINDING_LABELS[standing]}
		</Badge>
	);
}

/** "In CommCare HQ: {name}", on a line of its own, the name in monospace. */
function NamedLine({ name }: { readonly name: string }): ReactElement {
	return (
		<p className="text-[13px] text-nova-text-secondary">
			{NAMED_IN_HQ_LEAD}{" "}
			<span className="font-mono text-nova-text [overflow-wrap:anywhere]">
				{name}
			</span>
		</p>
	);
}

/** The path a question's or a file's line begins with. */
function Prefix({ path }: { readonly path: string | null }): ReactNode {
	if (path === null) return null;
	return (
		<>
			<span className="font-mono text-nova-text [overflow-wrap:anywhere]">
				{path}
			</span>{" "}
		</>
	);
}

function FindingItem({
	finding,
	prefix,
	context,
}: {
	readonly finding: Finding;
	readonly prefix: string | null;
	readonly context: CircumstanceContext;
}): ReactElement {
	const { sentence, named } = findingLine(finding);
	const standing = finding.standing as FindingStanding;
	if (finding.subject !== null) {
		return (
			<li className="flex flex-col gap-1">
				<p className="text-sm leading-relaxed text-nova-text-secondary">
					<Prefix path={prefix} />
					{sentence}
				</p>
				{named !== null ? <NamedLine name={named} /> : null}
				<StandingBadge standing={standing} />
			</li>
		);
	}
	const block = circumstanceBlock(finding, context);
	return (
		<li className="flex flex-col gap-1">
			<p className="text-sm font-medium text-nova-text">
				<Prefix path={prefix} />
				{block.title}
			</p>
			<p className="text-sm leading-relaxed text-nova-text-secondary">
				{block.body}
			</p>
			{named !== null ? <NamedLine name={named} /> : null}
			<p className="text-sm leading-relaxed text-nova-text-secondary">
				{block.next}
			</p>
			<StandingBadge standing={standing} />
		</li>
	);
}

function FoldItem({
	item,
}: {
	readonly item: Extract<AccountItem, { kind: "fold" }>;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const [first] = item.findings;
	const named = first === undefined ? null : findingLine(first).named;
	return (
		<li className="flex flex-col gap-1">
			<p className="text-sm leading-relaxed text-nova-text-secondary">
				{item.sentence}
			</p>
			{named !== null ? <NamedLine name={named} /> : null}
			<Collapsible open={open} onOpenChange={setOpen}>
				<p className="text-[13px] text-nova-text-secondary">
					{foldedRunLine(item.findings.length)}
				</p>
				<CollapsibleTrigger render={<Button variant="ghost" />}>
					{open
						? BRING_IN_ACTIONS.hideTheQuestions
						: BRING_IN_ACTIONS.showTheQuestions}
				</CollapsibleTrigger>
				<CollapsibleContent>
					<ul className="flex flex-col gap-0.5 pl-1">
						{item.findings.map((finding) => (
							<li
								key={
									finding.place.kind === "question" ? finding.place.path : ""
								}
								className="font-mono text-[13px] text-nova-text [overflow-wrap:anywhere]"
							>
								{finding.place.kind === "question" ? finding.place.path : null}
							</li>
						))}
					</ul>
				</CollapsibleContent>
			</Collapsible>
			<StandingBadge standing={item.standing} />
		</li>
	);
}

function GroupSection({
	group,
	target,
	context,
}: {
	readonly group: AccountGroup;
	readonly target: Pick<ReadingKey, "server" | "domain" | "remoteAppId">;
	readonly context: CircumstanceContext;
}): ReactElement {
	const headingId = useId();
	const url = hqPlaceUrl(target, group.place);
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center justify-between gap-x-3">
				<h2
					id={headingId}
					className="text-base font-semibold text-nova-text [overflow-wrap:anywhere]"
				>
					{group.heading}
				</h2>
				{url !== null ? (
					<a
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						className="nova-focusable inline-flex h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-nova-violet-bright hover:underline"
					>
						{BRING_IN_ACTIONS.openInCommCareHq}
						<Icon
							icon={tablerExternalLink}
							className="size-4"
							aria-hidden="true"
						/>
						<span className="sr-only"> (opens CommCare HQ in a new tab)</span>
					</a>
				) : null}
			</div>
			<ul className="flex flex-col gap-4">
				{group.items.map((item) =>
					item.kind === "fold" ? (
						<FoldItem
							key={`fold:${item.sentence}:${item.standing}`}
							item={item}
						/>
					) : (
						<FindingItem
							key={`${item.finding.code}:${JSON.stringify(item.finding.place)}:${item.finding.detail.name ?? ""}`}
							finding={item.finding}
							prefix={item.prefix}
							context={context}
						/>
					),
				)}
			</ul>
		</section>
	);
}

/**
 * The account's body: the labels it holds a finding of with their next
 * steps, each group of findings with its link to CommCare HQ, and the lines
 * under the groups. A surface that heads the account itself draws this.
 */
export function AccountFindings({
	answer,
	target,
	context,
}: {
	readonly answer: AccountAnswer;
	/** The HQ app the account is about, for the groups' links. */
	readonly target: Pick<ReadingKey, "server" | "domain" | "remoteAppId">;
	/** What a circumstance's block is filled from. */
	readonly context: CircumstanceContext;
}): ReactElement {
	const standings = accountStandings(answer.counts);
	const groups = accountGroups(answer.findings);
	return (
		<div className="flex flex-col gap-6" data-account-findings>
			{standings.length > 0 ? (
				<dl className="flex flex-col gap-3">
					{standings.map((standing) => (
						<div key={standing} className="flex flex-col gap-1">
							<dt>
								<StandingBadge standing={standing} />
							</dt>
							<dd className="text-sm leading-relaxed text-nova-text-secondary">
								{FINDING_NEXT_STEPS[standing]}
							</dd>
						</div>
					))}
				</dl>
			) : null}
			{groups.map((group) => (
				<GroupSection
					key={group.key}
					group={group}
					target={target}
					context={context}
				/>
			))}
			<div className="flex flex-col gap-1 text-sm leading-relaxed text-nova-text-secondary">
				<p>{ACCOUNT_CHECK_AGAIN_LINE}</p>
				{answer.more > 0 ? <p>{moreFindingsLine(answer.more)}</p> : null}
				{!answer.mediaChecked ? <p>{MEDIA_CHECKED_LATER}</p> : null}
			</div>
		</div>
	);
}

/**
 * Copy the list: the whole account as text on the clipboard, Copied for two
 * seconds, and where the browser refuses the clipboard the same text,
 * selected, to copy by hand.
 */
function useCopyList(text: string): {
	readonly copied: boolean;
	readonly refused: boolean;
	readonly copy: () => void;
} {
	const [state, setState] = useState<"idle" | "copied" | "refused">("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
		},
		[],
	);
	const copy = () => {
		const refuse = () => setState("refused");
		if (typeof navigator.clipboard?.writeText !== "function") {
			refuse();
			return;
		}
		navigator.clipboard.writeText(text).then(() => {
			setState("copied");
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = setTimeout(() => {
				timer.current = null;
				setState((now) => (now === "copied" ? "idle" : now));
			}, COPIED_MS);
		}, refuse);
	};
	return { copied: state === "copied", refused: state === "refused", copy };
}

function RefusedClipboard({ text }: { readonly text: string }): ReactElement {
	const lineId = useId();
	const ref = useRef<HTMLTextAreaElement>(null);
	const focusLater = useDeferredFocus();
	useEffect(
		() =>
			focusLater(() => {
				ref.current?.focus();
				ref.current?.select();
			}),
		[focusLater],
	);
	return (
		<div className="flex flex-col gap-2">
			<p
				id={lineId}
				className="text-sm leading-relaxed text-nova-text-secondary"
			>
				{CLIPBOARD_REFUSED_LINE}
			</p>
			<Textarea
				ref={ref}
				readOnly
				value={text}
				aria-labelledby={lineId}
				autoComplete="off"
				data-1p-ignore
				className="max-h-40 overflow-y-auto font-mono text-[13px]"
			/>
		</div>
	);
}

export function BringInAccount({
	model,
	readingKey,
	answer,
	context,
	dispatch,
}: {
	/** The flow's model: the lead of a create that ended here, and when the read answered. */
	readonly model: BringInModel;
	/** The app's address: the HQ app the groups link to. */
	readonly readingKey: ReadingKey;
	/** The `account` screen's answer (`screenOf`). */
	readonly answer: AccountAnswer;
	/** What a circumstance's block is filled from (`circumstanceContextOf`). */
	readonly context: CircumstanceContext;
	readonly dispatch: (event: BringInEvent) => void;
}): ReactElement {
	const heading = accountHeading(answer.findings);
	const counts = countLine(answer.counts);
	const now = new Date();
	const date = keptDateText(
		(model.answeredAt === null
			? now
			: new Date(model.answeredAt)
		).toISOString(),
		now,
	);
	const text = accountAsText(answer, context, date);
	const { copied, refused, copy } = useCopyList(text);

	/* A read answers an account only where it met a finding. */
	useEffect(() => {
		if (answer.findings.length > 0) return;
		reportClientError({
			message:
				"[bring-in] account with no findings. A read answered an account that holds no finding. An account is answered only where a read met one. Look at lib/deployment/reading/gather.ts::gatherReading.",
			source: "manual",
			url: "",
			diagnostics: {
				component: "bring-in-account",
				operation: "account",
				failureKind: "no-findings",
			},
		});
	}, [answer]);

	return (
		<BringInScreenLayout
			title={accountHeadingLine(heading, answer.appName)}
			icon="info"
			lead={model.lead}
			status={
				<span className="sr-only">{copied ? BRING_IN_ACTIONS.copied : ""}</span>
			}
			description={accountLead(heading, answerSourceOf(model))}
			focusKey={String(model.answeredAt)}
			footer={
				<>
					<Button nativeButton={false} render={<Link href="/" />}>
						{BRING_IN_ACTIONS.done}
					</Button>
					<Button
						variant="outline"
						onClick={() => dispatch({ type: "read-asked" })}
					>
						{BRING_IN_ACTIONS.checkAgain}
					</Button>
					<Button variant="outline" onClick={copy}>
						{copied ? BRING_IN_ACTIONS.copied : BRING_IN_ACTIONS.copyTheList}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-6" data-bring-in-screen="account">
				{counts !== "" ? (
					<p className="text-sm font-medium text-nova-text">{counts}</p>
				) : null}
				<AccountFindings
					answer={answer}
					target={readingKey}
					context={context}
				/>
				{refused ? <RefusedClipboard text={text} /> : null}
			</div>
		</BringInScreenLayout>
	);
}
