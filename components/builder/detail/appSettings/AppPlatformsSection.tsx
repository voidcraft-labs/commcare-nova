"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import tablerArrowsSplit from "@iconify-icons/tabler/arrows-split";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Spinner } from "@/components/shadcn/spinner";
import { useReconcilerContext } from "@/lib/collab/context";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import {
	type StructuredCommitFinding,
	useBlueprintMutations,
} from "@/lib/doc/hooks/useBlueprintMutations";
import { useConnectType } from "@/lib/doc/hooks/useConnectType";
import { useDeclaredPlatforms } from "@/lib/doc/hooks/useDeclaredPlatforms";
import { platformChangePreflightAction } from "@/lib/doc/platformChangePreflight";
import type {
	PlatformChangeFindingRow,
	PlatformChangeMediaRow,
} from "@/lib/doc/platformChangePreflightTypes";
import type { Mutation } from "@/lib/doc/types";
import type { Uuid } from "@/lib/domain";
import {
	PLATFORM_DECLARATION_LABELS,
	PLATFORM_LABELS,
	PLATFORMS,
	type Platform,
	platformPickerLine,
	platformRefusal,
} from "@/lib/domain/platforms";
import { useNavigate, useSelect } from "@/lib/routing/hooks";
import { useAppId, useCanEdit } from "@/lib/session/hooks";
import { selectableSegmentCls } from "@/lib/styles";
import { cn } from "@/lib/utils";
import {
	announceDatetimeSplit,
	SPLIT_DATETIME_LABEL,
	SPLIT_DATETIME_REFUSAL_LEAD,
} from "../../shared/datetimeSplitNotice";
import {
	findingOpenAction,
	findingTargetName,
	mediaLocationOpenAction,
	mediaLocationTargetName,
} from "../../shared/findingDestination";

/** A choice of the section: both platforms, or one. */
type PlatformChoice = "both" | Platform;

const CHOICES: readonly {
	readonly choice: PlatformChoice;
	readonly line: string;
}[] = [
	{
		choice: "both",
		line: "In a browser on CommCare HQ, and in the CommCare app on phones and tablets",
	},
	{ choice: "web-apps", line: "In a browser on CommCare HQ" },
	{ choice: "android", line: "In the CommCare app on phones and tablets" },
];

const ANNOUNCEMENTS: Readonly<Record<PlatformChoice, string>> = {
	both: "This app now runs in Web Apps and on Android",
	"web-apps": "This app now runs only in Web Apps",
	android: "This app now runs only on Android",
};

export const CHECKING_LINE = "Checking this app…";
const BARRIER_LINE =
	"Nova couldn't check this change while your edits were saving. You can try again in a moment.";
const MOVED_LINE =
	"This app changed while Nova was checking. You can choose again.";
const UNREACHABLE_LINE =
	"Nova couldn't reach this app. You can reload the page and try again.";
const THROWN_LINE =
	"Nova couldn't check this change. You can try again in a moment.";

function platformsOf(choice: PlatformChoice): readonly Platform[] {
	return choice === "both" ? PLATFORMS : [choice];
}

function choiceOf(runsOnlyOn: Platform | undefined): PlatformChoice {
	return runsOnlyOn ?? "both";
}

/** What stands in the way of one choice, row by row. */
type Refusal =
	| { readonly kind: "line"; readonly text: string }
	| {
			readonly kind: "rows";
			/** The platform the change adds, when it adds one. */
			readonly added: Platform | undefined;
			readonly target: PlatformChoice;
			readonly findings: readonly PlatformChangeFindingRow[];
			readonly media: readonly PlatformChangeMediaRow[];
	  };

/** The rows a client gate refusal gives: each line beside its finding. */
function findingRows(outcome: {
	readonly messages: readonly string[];
	readonly findings?: readonly StructuredCommitFinding[];
}): PlatformChangeFindingRow[] {
	const findings = outcome.findings ?? [];
	return outcome.messages.map((line, index) => ({
		line,
		finding: findings[index] ?? {
			code: "UNLOCATED",
			scope: "app",
			location: {},
		},
	}));
}

/**
 * Where workers use this app: Web Apps and Android, Web Apps only, or
 * Android only (`appSettings.runsOnlyOn`). First in App settings, because the
 * declaration decides what every other section and picker offers.
 *
 * A choice that only removes a platform commits through the client gate. A
 * choice that adds one first waits for the reconciler's save barrier, asks
 * the server what the committed app holds that the new declaration can't run
 * (content and media, from one snapshot), and commits only when that answer
 * read the sequence on screen. A refusal lists each use beside the choices,
 * each with an Open link that keeps App settings open, so the list is the
 * person's checklist. No confirmation dialog: each choice says what it means
 * before it is made.
 */
export function AppPlatformsSection() {
	const runsOnlyOn = useAppSettings().runsOnlyOn;
	const connectType = useConnectType();
	const platforms = useDeclaredPlatforms();
	const current = choiceOf(runsOnlyOn);
	const mutations = useBlueprintMutations();
	const reconciler = useReconcilerContext()?.reconciler;
	const appId = useAppId();
	const canEdit = useCanEdit();
	const navigate = useNavigate();
	const select = useSelect();
	const groupName = useId();
	const headingId = useId();
	const [pending, setPending] = useState<PlatformChoice>();
	const [refusal, setRefusal] = useState<Refusal>();
	const [announcement, setAnnouncement] = useState("");
	const [splitRefusals, setSplitRefusals] = useState<
		Readonly<Record<string, string>>
	>({});
	const generation = useRef(0);

	// A choice still checking when the section closes is abandoned.
	useEffect(
		() => () => {
			generation.current += 1;
		},
		[],
	);

	const commit = (
		next: PlatformChoice,
		mutation: Mutation,
		added?: Platform,
	) => {
		const committed = mutations.inline.commitMany([mutation]);
		if (!committed.ok) {
			setRefusal({
				kind: "rows",
				added,
				target: next,
				findings: findingRows(committed),
				media: [],
			});
			return;
		}
		setRefusal(undefined);
		setAnnouncement(ANNOUNCEMENTS[next]);
	};

	const choose = async (next: PlatformChoice) => {
		if (!canEdit || next === current) return;
		const sequence = ++generation.current;
		setRefusal(undefined);
		setSplitRefusals({});
		const mutation: Mutation = {
			kind: "setAppSettings",
			settings: { runsOnlyOn: next === "both" ? null : next },
		};
		const added = platformsOf(next).find(
			(platform) => !platforms.includes(platform),
		);
		if (added === undefined) {
			setPending(undefined);
			const reviewed = mutations.inline.reviewMany([mutation]);
			if (!reviewed.ok) {
				setRefusal({
					kind: "rows",
					added: undefined,
					target: next,
					findings: findingRows(reviewed),
					media: [],
				});
				return;
			}
			commit(next, mutation);
			return;
		}
		setPending(next);
		try {
			if (reconciler === undefined || appId === undefined) {
				setRefusal({ kind: "line", text: BARRIER_LINE });
				return;
			}
			const saved = await reconciler.waitForHumanSaveBarrier();
			if (sequence !== generation.current) return;
			if (saved.kind !== "saved") {
				setRefusal({ kind: "line", text: BARRIER_LINE });
				return;
			}
			const result = await platformChangePreflightAction({
				appId,
				runsOnlyOn: next === "both" ? null : next,
			});
			if (sequence !== generation.current) return;
			if (result.kind === "refused") {
				setRefusal({
					kind: "rows",
					added,
					target: next,
					findings: result.findings,
					media: result.media,
				});
				return;
			}
			if (result.kind !== "ok") {
				setRefusal({ kind: "line", text: UNREACHABLE_LINE });
				return;
			}
			if (reconciler.getSnapshot().baseSeq !== result.mutationSeq) {
				setRefusal({ kind: "line", text: MOVED_LINE });
				return;
			}
			commit(next, mutation, added);
		} catch {
			if (sequence === generation.current)
				setRefusal({ kind: "line", text: THROWN_LINE });
		} finally {
			if (sequence === generation.current) setPending(undefined);
		}
	};

	/** Split a refused date-and-time question in place; the row leaves on
	 *  success, and a block left with no row closes. */
	const split = (finding: StructuredCommitFinding, key: string) => {
		const fieldUuid = finding.location.fieldUuid as Uuid | undefined;
		if (fieldUuid === undefined) return;
		const outcome = mutations.inline.splitDatetimeQuestion(fieldUuid);
		if (!outcome.ok) {
			setSplitRefusals((held) => ({
				...held,
				[key]:
					`${SPLIT_DATETIME_REFUSAL_LEAD} ${outcome.messages[0] ?? ""}`.trim(),
			}));
			return;
		}
		select(outcome.dateUuid);
		announceDatetimeSplit();
		setRefusal((held) => {
			if (held?.kind !== "rows") return held;
			const findings = held.findings.filter((row) => row.finding !== finding);
			return findings.length === 0 && held.media.length === 0
				? undefined
				: { ...held, findings };
		});
	};

	return (
		<div>
			<span
				id={headingId}
				className="text-xs font-medium text-nova-text-secondary mb-1.5 block"
			>
				Where workers use this app
			</span>
			<fieldset
				aria-labelledby={headingId}
				className="grid gap-1 rounded-2xl bg-nova-deep/50 p-1"
			>
				<legend className="sr-only">Where workers use this app</legend>
				{CHOICES.map(({ choice, line }) => {
					const selected = choice === current;
					const connectRefusal =
						connectType === null
							? undefined
							: platformRefusal("connect-app", platformsOf(choice));
					const disabled = !canEdit || connectRefusal !== undefined;
					return (
						<label
							key={choice}
							data-platform-choice={choice}
							className={cn(
								selectableSegmentCls(selected),
								"h-auto flex-col items-start justify-start gap-0.5 py-2 text-left whitespace-normal has-[input:focus-visible]:border-nova-ring has-[input:focus-visible]:shadow-(--focus-ring)",
								disabled && "cursor-not-allowed opacity-(--disabled-opacity)",
							)}
						>
							<input
								type="radio"
								name={groupName}
								value={choice}
								checked={selected}
								disabled={disabled}
								onChange={() => void choose(choice)}
								className="sr-only"
							/>
							<span className="flex w-full items-center gap-2 text-xs font-medium">
								<span className="flex-1">
									{PLATFORM_DECLARATION_LABELS[choice]}
								</span>
								{pending === choice && <Spinner className="size-3.5" />}
							</span>
							<span className="text-xs leading-snug text-nova-text-muted">
								{pending === choice
									? CHECKING_LINE
									: connectRefusal !== undefined
										? platformPickerLine(connectRefusal)
										: line}
							</span>
						</label>
					);
				})}
			</fieldset>
			<p className="mt-1.5 text-xs leading-snug text-nova-text-muted">
				Each choice decides which features Nova offers.
			</p>
			<p role="status" aria-live="polite" className="sr-only">
				{announcement}
			</p>
			{refusal !== undefined && (
				<RefusalBlock
					refusal={refusal}
					splitRefusals={splitRefusals}
					onOpenFinding={(finding) => findingOpenAction(finding, navigate)}
					onOpenMedia={(row) => mediaLocationOpenAction(row.location, navigate)}
					onSplit={split}
				/>
			)}
		</div>
	);
}

function RefusalBlock({
	refusal,
	splitRefusals,
	onOpenFinding,
	onOpenMedia,
	onSplit,
}: {
	readonly refusal: Refusal;
	readonly splitRefusals: Readonly<Record<string, string>>;
	readonly onOpenFinding: (
		finding: StructuredCommitFinding,
	) => (() => void) | undefined;
	readonly onOpenMedia: (
		row: PlatformChangeMediaRow,
	) => (() => void) | undefined;
	readonly onSplit: (finding: StructuredCommitFinding, key: string) => void;
}) {
	if (refusal.kind === "line") {
		return (
			<div
				role="alert"
				className="mt-2 flex gap-2 rounded-xl border border-nova-rose/25 bg-nova-rose/[0.06] px-3 py-2.5 text-xs leading-relaxed text-nova-text-secondary"
			>
				<Icon
					icon={tablerAlertCircle}
					width="16"
					height="16"
					className="mt-0.5 shrink-0 text-nova-rose"
				/>
				<span>{refusal.text}</span>
			</div>
		);
	}
	const count = refusal.findings.length + refusal.media.length;
	const subject =
		refusal.added === undefined
			? `“${PLATFORM_DECLARATION_LABELS[refusal.target]}”`
			: PLATFORM_LABELS[refusal.added];
	const title =
		count === 1
			? `${subject} can't run one thing this app uses`
			: `${subject} can't run ${count} things this app uses`;
	const line =
		count === 1
			? `You can change it here, then choose “${PLATFORM_DECLARATION_LABELS[refusal.target]}” again.`
			: `You can change each one here, then choose “${PLATFORM_DECLARATION_LABELS[refusal.target]}” again.`;
	return (
		<div
			role="alert"
			data-platform-refusal=""
			className="mt-2 rounded-xl border border-nova-rose/25 bg-nova-rose/[0.06] px-3 py-2.5 text-xs leading-relaxed text-nova-text-secondary"
		>
			<div className="flex gap-2">
				<Icon
					icon={tablerAlertCircle}
					width="16"
					height="16"
					className="mt-0.5 shrink-0 text-nova-rose"
				/>
				<div className="min-w-0 flex-1">
					<p className="font-medium text-nova-text">{title}</p>
					<p>{line}</p>
				</div>
			</div>
			<ul className="mt-2 space-y-2">
				{refusal.findings.map((row, index) => {
					const key = `finding:${row.finding.code}:${index}`;
					const open = onOpenFinding(row.finding);
					const splittable =
						row.finding.code === "PLATFORM_FEATURE_UNAVAILABLE" &&
						row.finding.details?.feature === "datetime-question" &&
						row.finding.location.fieldUuid !== undefined;
					return (
						<li key={key} className="space-y-1">
							<p>{row.line}</p>
							<div className="flex flex-wrap gap-1">
								{open !== undefined && (
									<Button type="button" variant="ghost-action" onClick={open}>
										Open {findingTargetName(row.finding.location)}
										<Icon icon={tablerArrowRight} width="14" height="14" />
									</Button>
								)}
								{splittable && (
									<Button
										type="button"
										variant="ghost-action"
										onClick={() => onSplit(row.finding, key)}
									>
										<Icon icon={tablerArrowsSplit} width="14" height="14" />
										{SPLIT_DATETIME_LABEL}
									</Button>
								)}
							</div>
							{splitRefusals[key] !== undefined && (
								<p className="text-nova-rose">{splitRefusals[key]}</p>
							)}
						</li>
					);
				})}
				{refusal.media.map((row) => {
					const open = onOpenMedia(row);
					return (
						<li
							key={`media:${JSON.stringify(row.location)}`}
							className="space-y-1"
						>
							<p>{row.line}</p>
							{open !== undefined && (
								<Button type="button" variant="ghost-action" onClick={open}>
									Open {mediaLocationTargetName(row.location)}
									<Icon icon={tablerArrowRight} width="14" height="14" />
								</Button>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
