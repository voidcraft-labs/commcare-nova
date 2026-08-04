"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerCopy from "@iconify-icons/tabler/copy";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerTrash from "@iconify-icons/tabler/trash";
import {
	current,
	type Draft,
	isDraft,
	produce,
	type WritableDraft,
} from "immer";
import {
	type ComponentProps,
	cloneElement,
	type ReactElement,
	type ReactNode,
	type Ref,
	startTransition,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import { DatePicker } from "@/components/shadcn/date-picker";
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
	FieldDescription,
	FieldError,
	FieldLabel,
} from "@/components/shadcn/field";
import { Input as ShadcnInput } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { Spinner } from "@/components/shadcn/spinner";
import { Textarea as ShadcnTextarea } from "@/components/shadcn/textarea";
import { TimeField } from "@/components/shadcn/time-field";
import type { AutomationPreviewResult } from "@/lib/automations/actions";
import { previewAutomationAction } from "@/lib/automations/actions";
import type { AutomationFormChoice } from "@/lib/automations/formChoices";
import {
	useAutomationForms,
	useAutomations,
} from "@/lib/doc/hooks/useAutomationCollections";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useOrganizationLevels } from "@/lib/doc/hooks/useOrganizationCollections";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import {
	type Automation,
	type AutomationContent,
	type AutomationMessageTemplate,
	type AutomationRecipient,
	type AutomationSchedule,
	type AutomationTimedEvent,
	asUuid,
	automationMessageText,
	automationRecipientKindIsSingleton,
	automationRecipientSupportsConnect,
	automationSchema,
	automationTimedScheduleSetupForm,
	type CaseType,
	canonicalAutomationMessageTemplate,
	type Uuid,
} from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import { useOrganization } from "@/lib/organization/useOrganization";
import { useAppId, useCanEdit } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { formatClockTime, parseClockTime } from "@/lib/ui/clockTime";
import { EntryRow, SubsectionEmpty } from "./subsection";

type SavedPreview = Extract<AutomationPreviewResult, { success: true }>["data"];

function Input(props: ComponentProps<typeof ShadcnInput>) {
	return <ShadcnInput {...props} autoComplete="off" data-1p-ignore="" />;
}

function Textarea(props: ComponentProps<typeof ShadcnTextarea>) {
	return <ShadcnTextarea {...props} autoComplete="off" data-1p-ignore="" />;
}

function cloneEditableValue<T>(value: T): T {
	return structuredClone(isDraft(value) ? current(value as Draft<T>) : value);
}

const RECIPIENT_KINDS: readonly [AutomationRecipient["kind"], string][] = [
	["self", "The case"],
	["owner", "Case owner"],
	["last-submitting-user", "Last submitting user"],
	["parent-case", "Parent case"],
	["all-child-cases", "All child cases"],
	["case-property-username", "Username in a case property"],
	["case-property-user-id", "User ID in a case property"],
	["case-property-email", "Email in a case property"],
	["location", "Location"],
	["mobile-worker", "Mobile worker in CommCare HQ"],
	["user-group", "User group in CommCare HQ"],
	["case-group", "Case group in CommCare HQ"],
	["custom", "Registered custom recipient"],
];

const CONTENT_KINDS: readonly [AutomationContent["kind"], string][] = [
	["sms", "SMS"],
	["email", "Email"],
	["sms-survey", "SMS survey"],
	["ivr", "IVR (historical configurations only)"],
	["sms-callback", "SMS callback (historical configurations only)"],
	["connect-message", "Connect message"],
	["connect-survey", "Connect survey"],
	["custom", "Registered custom content"],
];

const WEEKDAY_NAMES = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
] as const;

const MONTHLY_EVENT_DAYS = [
	...Array.from({ length: 28 }, (_, index) => index + 1),
	-3,
	-2,
	-1,
] as const;

function monthlyDayLabel(day: number): string {
	if (day > 0) return `Day ${day}`;
	if (day === -1) return "Last day of the month";
	return `${Math.abs(day)}${day === -2 ? "nd" : "rd"}-to-last day of the month`;
}

function timedEventComparator(
	setupForm: "custom-daily" | "weekly" | "monthly",
	left: AutomationTimedEvent,
	right: AutomationTimedEvent,
): number {
	if (setupForm === "monthly") {
		const rank = (day: number) => (day > 0 ? day : 32 + day);
		return rank(left.day) - rank(right.day);
	}
	if (left.day !== right.day) return left.day - right.day;
	const minute = (event: AutomationTimedEvent) => {
		if (event.timing.kind === "case-property-time") return 0;
		const [hours = 0, minutes = 0] = event.timing.time.split(":").map(Number);
		return hours * 60 + minutes;
	};
	return minute(left) - minute(right);
}

export function localIsoDate(date = new Date()): string {
	return `${String(date.getFullYear()).padStart(4, "0")}-${String(
		date.getMonth() + 1,
	).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function weekdayIndexForIsoDate(date: string): number {
	return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

function remapWeeklyEventOffsets(
	schedule: WritableDraft<Extract<AutomationSchedule, { kind: "timed" }>>,
	startDayOfWeek: number,
): void {
	const previousStart = schedule.startDayOfWeek;
	for (const event of schedule.events) {
		const absoluteWeekday = (previousStart + event.day) % 7;
		event.day = (absoluteWeekday - startDayOfWeek + 7) % 7;
	}
	schedule.startDayOfWeek = startDayOfWeek;
	schedule.events.sort((left, right) =>
		timedEventComparator("weekly", left, right),
	);
}

function automationTimeText(value: string): string {
	if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return value;
	return formatClockTime(`${value}:00.000Z`) ?? value;
}

function uuid(): Uuid {
	return asUuid(crypto.randomUUID());
}

function newCaseUpdate(caseType: string): Automation {
	return {
		uuid: uuid(),
		kind: "case-update",
		name: "New case update",
		caseType,
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		updates: [],
		closeCase: true,
	};
}

function newAlert(caseType: string): Automation {
	return {
		uuid: uuid(),
		kind: "conditional-alert",
		name: "New conditional alert",
		caseType,
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		recipients: [{ uuid: uuid(), kind: "self" }],
		schedule: {
			kind: "immediate",
			events: [
				{
					uuid: uuid(),
					minutesToWait: 0,
					content: { kind: "sms", message: automationMessageText("Message") },
				},
			],
		},
		includeDescendantLocations: false,
		locationLevelUuids: [],
		userDataFilters: [],
		useUserCaseForFilter: false,
	};
}

function fingerprint(value: Automation): string {
	return JSON.stringify(value);
}

export function AutomationsSection() {
	const automations = useAutomations();
	const caseTypes = useEffectiveCaseTypes();
	const forms = useAutomationForms();
	const levels = useOrganizationLevels();
	const userProperties = useUserProperties();
	const canEdit = useCanEdit();
	const appId = useAppId() ?? "";
	const organization = useOrganization(appId);
	const [openUuid, setOpenUuid] = useState<Uuid | undefined>();
	const addButtonRef = useRef<HTMLButtonElement>(null);
	const [returnFocusToAdd, setReturnFocusToAdd] = useState(false);
	const [editor, setEditor] = useState<
		| { kind: "new"; automation: Automation }
		| { kind: "existing"; automation: Automation; opened: string }
	>();

	const openExisting = (automation: Automation) => {
		setEditor({
			kind: "existing",
			automation: cloneEditableValue(automation),
			opened: fingerprint(automation),
		});
	};

	useEffect(() => {
		if (!returnFocusToAdd || editor !== undefined) return;
		addButtonRef.current?.focus();
		setReturnFocusToAdd(false);
	}, [editor, returnFocusToAdd]);

	return (
		<section aria-labelledby="app-setup-automations-heading" className="pb-10">
			<h2 id="app-setup-automations-heading" className="sr-only">
				Automations
			</h2>
			<p className="mt-2 max-w-prose text-[13px] leading-relaxed text-nova-text-secondary">
				Describe case updates and messages that CommCare HQ should run. Nova can
				count currently matching cases and keep exact setup steps current, but
				it doesn't run or install these rules.
			</p>
			<aside className="mt-4 max-w-prose rounded-lg border border-nova-amber/35 bg-nova-amber/[0.06] px-3 py-3 text-[13px] leading-relaxed text-nova-text-secondary">
				Publishing the app won't activate these automations. Follow the
				generated guide in the target CommCare HQ project after publishing.
			</aside>

			<div className="mt-8 flex flex-col gap-2">
				{automations.length === 0 ? (
					<SubsectionEmpty>
						No automations yet. Add one when cases should change or send a
						message without a person submitting a form.
					</SubsectionEmpty>
				) : (
					automations.map((automation) => (
						<EntryRow
							key={automation.uuid}
							open={openUuid === automation.uuid}
							onOpenChange={(open) =>
								setOpenUuid(open ? automation.uuid : undefined)
							}
							summary={
								<span className="text-[13px] font-medium text-nova-text">
									{automation.name}
								</span>
							}
							detail={
								automation.kind === "case-update"
									? "Case update"
									: "Conditional alert"
							}
						>
							<AutomationSummary
								key={fingerprint(automation)}
								automation={automation}
								appId={appId}
								canEdit={canEdit}
								onEdit={() => openExisting(automation)}
							/>
						</EntryRow>
					))
				)}
				{canEdit && (
					<Button
						ref={addButtonRef}
						type="button"
						variant="ghost"
						className="nova-add-slot mt-1 w-full"
						disabled={caseTypes.length === 0}
						onClick={() =>
							setEditor({
								kind: "new",
								automation: newCaseUpdate(caseTypes[0]?.name ?? ""),
							})
						}
					>
						<Icon icon={tablerPlus} aria-hidden="true" />
						Add automation
					</Button>
				)}
				{canEdit && caseTypes.length === 0 && (
					<p className="text-[12px] text-nova-text-muted">
						Add a case type before adding an automation.
					</p>
				)}
			</div>

			{editor !== undefined && (
				<AutomationEditor
					key={`${editor.kind}:${editor.automation.uuid}`}
					state={editor}
					current={
						editor.kind === "existing"
							? automations.find(
									(automation) => automation.uuid === editor.automation.uuid,
								)
							: undefined
					}
					caseTypes={caseTypes}
					forms={forms}
					locations={organization.locations.filter(
						(location) => location.archivedAt === null,
					)}
					levels={levels}
					userProperties={userProperties}
					onChange={(automation) =>
						setEditor((current) =>
							current === undefined ? current : { ...current, automation },
						)
					}
					onClose={() => setEditor(undefined)}
					onRemoved={() => {
						setReturnFocusToAdd(true);
						setEditor(undefined);
					}}
				/>
			)}
		</section>
	);
}

function AutomationSummary({
	automation,
	appId,
	canEdit,
	onEdit,
}: {
	automation: Automation;
	appId: string;
	canEdit: boolean;
	onEdit: () => void;
}) {
	const [preview, setPreview] = useState<SavedPreview>();
	const [error, setError] = useState<string>();
	const [pending, setPending] = useState(false);
	const load = () => {
		setPending(true);
		setError(undefined);
		startTransition(async () => {
			const result = await previewAutomationAction({
				appId,
				automationUuid: automation.uuid,
				expectedAutomation: automation,
			});
			if (result.success) setPreview(result.data);
			else setError(result.message);
			setPending(false);
		});
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-2 text-[12px] text-nova-text-secondary @sm:grid-cols-2">
				<p>
					<span className="text-nova-text-muted">Case type</span>
					<br />
					<span className="font-mono text-nova-text">
						{automation.caseType}
					</span>
				</p>
				<p>
					<span className="text-nova-text-muted">Matching</span>
					<br />
					{automation.criteriaOperator === "all" ? "All" : "Any"} of{" "}
					{automation.criteria.length} locally countable condition
					{automation.criteria.length === 1 ? "" : "s"}
				</p>
			</div>
			<p className="rounded-lg border border-nova-violet/25 bg-nova-violet/[0.05] px-3 py-3 text-[12px] leading-relaxed text-nova-text-secondary">
				Nova never executes this automation. The count below is a read-only
				Preview of current cases, not a simulation of updates or messages.
			</p>
			{preview !== undefined && (
				<div
					aria-live="polite"
					className="rounded-lg border border-nova-border px-3 py-3"
				>
					<p className="text-2xl font-semibold text-nova-text">
						{preview.currentMatchCount}
					</p>
					<p className="text-[12px] text-nova-text-secondary">
						currently matching case{preview.currentMatchCount === 1 ? "" : "s"}
					</p>
					{preview.omittedCriteria.length > 0 && (
						<p className="mt-2 text-[12px] leading-relaxed text-nova-amber">
							Count excludes: {preview.omittedCriteria.join("; ")}
						</p>
					)}
				</div>
			)}
			{error !== undefined && (
				<p
					role="alert"
					className="rounded-lg border border-nova-red/40 bg-nova-red/[0.06] px-3 py-3 text-[13px] text-nova-text"
				>
					{error}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					onClick={load}
					disabled={pending || appId === ""}
				>
					{pending ? (
						<Spinner className="size-4" />
					) : (
						<Icon icon={tablerRefresh} aria-hidden="true" />
					)}
					{preview === undefined
						? "Count matching cases"
						: "Refresh count and guide"}
				</Button>
				{canEdit && (
					<Button type="button" variant="secondary" onClick={onEdit}>
						Edit automation
					</Button>
				)}
			</div>
			{preview !== undefined && <SetupGuide guide={preview.setupGuide} />}
		</div>
	);
}

function SetupGuide({ guide }: { guide: SavedPreview["setupGuide"] }) {
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState(false);
	const text = useMemo(
		() =>
			[
				guide.title,
				`Required plan: ${guide.requiredPlan}`,
				"",
				...guide.steps.map((step, index) => `${index + 1}. ${step}`),
				"",
				"Important:",
				...guide.caveats.map((caveat) => `- ${caveat}`),
			].join("\n"),
		[guide],
	);
	return (
		<div className="rounded-lg border border-nova-border bg-black/10 px-3 py-3">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h4 className="text-[13px] font-semibold text-nova-text">
						Setup guide
					</h4>
					<p className="mt-0.5 text-[12px] text-nova-text-muted">
						Required plan: {guide.requiredPlan}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost-action"
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(text);
							setCopied(true);
							setCopyError(false);
						} catch {
							setCopyError(true);
						}
					}}
				>
					<Icon icon={tablerCopy} aria-hidden="true" />
					{copied ? "Copied" : "Copy guide"}
				</Button>
			</div>
			{copyError && (
				<p role="alert" className="mt-2 text-[12px] text-nova-red">
					The browser couldn't copy the guide. Select the steps below instead.
				</p>
			)}
			<ol className="mt-3 list-decimal space-y-2 pl-5 text-[12px] leading-relaxed text-nova-text-secondary">
				{guide.steps.map((step) => (
					<li key={step}>{step}</li>
				))}
			</ol>
			<ul className="mt-3 list-disc space-y-1.5 pl-5 text-[12px] leading-relaxed text-nova-amber">
				{guide.caveats.map((caveat) => (
					<li key={caveat}>{caveat}</li>
				))}
			</ul>
		</div>
	);
}

interface EditorState {
	kind: "new" | "existing";
	automation: Automation;
	opened?: string;
}

function AutomationEditor({
	state,
	current,
	caseTypes,
	forms,
	locations,
	levels,
	userProperties,
	onChange,
	onClose,
	onRemoved,
}: {
	state: EditorState;
	current: Automation | undefined;
	caseTypes: readonly CaseType[];
	forms: readonly AutomationFormChoice[];
	locations: readonly StoredLocation[];
	levels: readonly { uuid: Uuid; name: string }[];
	userProperties: readonly { uuid: Uuid; label: string; slug: string }[];
	onChange: (automation: Automation) => void;
	onClose: () => void;
	onRemoved: () => void;
}) {
	const mutations = useBlueprintMutations();
	const session = useBuilderSessionApi();
	const nameRef = useRef<HTMLInputElement>(null);
	const [error, setError] = useState<string>();
	const [confirmRemove, setConfirmRemove] = useState(false);
	const peerConflict =
		state.kind === "existing" &&
		(current === undefined || fingerprint(current) !== state.opened);

	useEffect(() => nameRef.current?.focus(), []);

	const edit = (recipe: (draft: WritableDraft<Automation>) => void) => {
		onChange(produce(state.automation, recipe));
		setError(undefined);
	};
	const save = () => {
		if (!session.getState().canEdit) {
			setError(
				"You no longer have edit access. Close this editor to keep the saved version unchanged.",
			);
			return;
		}
		if (peerConflict) {
			setError(
				"This automation changed while you were editing it. Close and reopen it to review the latest version.",
			);
			return;
		}
		const parsed = automationSchema.safeParse(state.automation);
		if (!parsed.success) {
			setError(
				parsed.error.issues[0]?.message ??
					"Review the automation settings before saving.",
			);
			return;
		}
		const result =
			state.kind === "new"
				? mutations.inline.addAutomation(parsed.data)
				: mutations.inline.replaceAutomation(parsed.data, state.opened);
		if (!result.ok) {
			setError(
				result.messages[0] ??
					"Nova refused this automation because it would make the app invalid.",
			);
			return;
		}
		onClose();
	};
	const remove = () => {
		if (!session.getState().canEdit) {
			setError(
				"You no longer have edit access. Close this editor to keep the saved version unchanged.",
			);
			return;
		}
		if (peerConflict) {
			setError(
				"This automation changed while you were editing it. Close and reopen it to review the latest version.",
			);
			return;
		}
		const result = mutations.inline.removeAutomation(
			state.automation.uuid,
			state.opened,
		);
		if (result.ok) onRemoved();
		else
			setError(result.messages[0] ?? "Nova couldn't remove this automation.");
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>
						{state.kind === "new"
							? "Add automation"
							: `Edit ${state.automation.name}`}
					</DialogTitle>
					<DialogDescription>
						Nova saves a precise CommCare HQ setup definition. It won't run here
						or be installed when you publish.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="space-y-6 pb-2">
					{peerConflict && (
						<p
							role="alert"
							className="flex gap-2 rounded-lg border border-nova-amber/40 bg-nova-amber/[0.06] px-3 py-3 text-[13px] leading-relaxed text-nova-text"
						>
							<Icon
								icon={tablerAlertTriangle}
								className="mt-0.5 shrink-0"
								aria-hidden="true"
							/>
							A co-editor changed or removed this automation. Close and reopen
							it before saving.
						</p>
					)}
					<fieldset
						className="grid gap-4 @md:grid-cols-2"
						disabled={peerConflict}
					>
						<legend className="sr-only">Automation identity</legend>
						<Labeled label="Name">
							<Input
								ref={nameRef}
								value={state.automation.name}
								onChange={(event) =>
									edit((draft) => {
										draft.name = event.target.value;
									})
								}
							/>
						</Labeled>
						<Labeled label="Case type">
							<Choice
								value={state.automation.caseType}
								onChange={(caseType) =>
									edit((draft) => {
										draft.caseType = caseType;
										updateAutomationMessageReferenceCaseTypes(
											draft,
											caseTypes,
											caseType,
										);
									})
								}
								options={caseTypes.map((caseType) => [
									caseType.name,
									caseType.name,
								])}
							/>
						</Labeled>
						{state.kind === "new" && (
							<Labeled label="Automation type">
								<Choice
									value={state.automation.kind}
									onChange={(kind) =>
										onChange(
											kind === "case-update"
												? newCaseUpdate(state.automation.caseType)
												: newAlert(state.automation.caseType),
										)
									}
									options={[
										["case-update", "Automatic case update"],
										["conditional-alert", "Conditional alert"],
									]}
								/>
							</Labeled>
						)}
						<Labeled label="Match">
							<Choice
								value={state.automation.criteriaOperator}
								onChange={(value) =>
									edit((draft) => {
										draft.criteriaOperator = value as "all" | "any";
									})
								}
								options={[
									["all", "All conditions"],
									["any", "Any condition"],
								]}
							/>
						</Labeled>
					</fieldset>

					<ConditionsEditor automation={state.automation} onEdit={edit} />
					<SetupOnlyEditor automation={state.automation} onEdit={edit} />
					{state.automation.kind === "case-update" && (
						<OptionalNumber
							label="Only cases last changed on the server at least this many days ago"
							value={state.automation.serverModifiedBoundaryDays}
							onChange={(value) =>
								edit((draft) => {
									if (draft.kind !== "case-update") return;
									if (value === undefined)
										delete draft.serverModifiedBoundaryDays;
									else draft.serverModifiedBoundaryDays = value;
								})
							}
						/>
					)}

					{state.automation.kind === "case-update" ? (
						<CaseUpdateEditor automation={state.automation} onEdit={edit} />
					) : (
						<AlertEditor
							automation={state.automation}
							caseTypes={caseTypes}
							forms={forms}
							locations={locations}
							levels={levels}
							userProperties={userProperties}
							onEdit={edit}
						/>
					)}

					{error !== undefined && (
						<p
							role="alert"
							className="rounded-lg border border-nova-red/40 bg-nova-red/[0.06] px-3 py-3 text-[13px] leading-relaxed text-nova-text"
						>
							{error}
						</p>
					)}
					{state.kind === "existing" && (
						<fieldset
							disabled={peerConflict}
							className="rounded-lg border border-nova-red/25 bg-nova-red/[0.03] p-3 disabled:opacity-60"
						>
							<legend className="sr-only">Remove automation</legend>
							{confirmRemove ? (
								<div
									role="alert"
									className="flex flex-wrap items-center justify-between gap-3"
								>
									<p className="text-[13px] text-nova-text">
										Remove this Nova definition? A rule already set up in
										CommCare HQ won't be removed.
									</p>
									<div className="flex gap-2">
										<Button
											type="button"
											variant="ghost"
											onClick={() => setConfirmRemove(false)}
										>
											Cancel
										</Button>
										<Button
											type="button"
											variant="destructive"
											disabled={peerConflict}
											onClick={remove}
										>
											Remove automation
										</Button>
									</div>
								</div>
							) : (
								<Button
									type="button"
									variant="ghost-destructive"
									disabled={peerConflict}
									onClick={() => setConfirmRemove(true)}
								>
									<Icon icon={tablerTrash} aria-hidden="true" /> Remove
									automation
								</Button>
							)}
						</fieldset>
					)}
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button type="button" onClick={save} disabled={peerConflict}>
						Save automation
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function Section({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<section>
			<h3 className="text-sm font-semibold text-nova-text">{title}</h3>
			{description && (
				<p className="mt-1 text-[12px] leading-relaxed text-nova-text-secondary">
					{description}
				</p>
			)}
			<div className="mt-3 flex flex-col gap-3">{children}</div>
		</section>
	);
}

function Labeled({
	label,
	hint,
	error,
	children,
}: {
	label: string;
	hint?: string;
	error?: string;
	children: ReactNode;
}) {
	const id = useId();
	const descriptionId = hint === undefined ? undefined : `${id}-description`;
	const errorId = error === undefined ? undefined : `${id}-error`;
	return (
		<Field data-invalid={error === undefined ? undefined : true}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			{cloneElement(
				children as ReactElement<{
					id?: string;
					"aria-label"?: string;
					"aria-describedby"?: string;
				}>,
				{
					id,
					"aria-label": label,
					"aria-describedby":
						[descriptionId, errorId].filter(Boolean).join(" ") || undefined,
				},
			)}
			{hint && <FieldDescription id={descriptionId}>{hint}</FieldDescription>}
			<FieldError id={errorId}>{error}</FieldError>
		</Field>
	);
}

type ChoiceOption = readonly [value: string, label: string, disabled?: boolean];

function Choice({
	value,
	onChange,
	options,
	disabled = false,
	id,
	"aria-label": ariaLabel,
}: {
	value: string;
	onChange: (value: string) => void;
	options: readonly ChoiceOption[];
	disabled?: boolean;
	id?: string;
	"aria-label"?: string;
}) {
	return (
		<Select
			value={value}
			onValueChange={(next) => next !== null && onChange(next)}
			disabled={disabled}
		>
			<SelectTrigger
				id={id}
				aria-label={ariaLabel}
				className="w-full"
				wrapValue
			>
				<SelectValue>
					{(selected) =>
						options.find(([optionValue]) => optionValue === selected)?.[1] ??
						selected
					}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{options.map(([id, label, optionDisabled]) => (
					<SelectItem key={id} value={id} disabled={optionDisabled} wrap>
						{label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function automationMessageReferenceCaseType(
	caseTypes: readonly CaseType[],
	automationCaseType: string,
	scope: "case" | "parent" | "host",
): string {
	if (scope === "case") return automationCaseType;
	const source = caseTypes.find(
		(caseType) => caseType.name === automationCaseType,
	);
	if (source?.parent_type === undefined) return "";
	if (
		(scope === "host" && source.relationship === "extension") ||
		(scope === "parent" && source.relationship !== "extension")
	) {
		return source.parent_type;
	}
	return "";
}

function updateAutomationMessageReferenceCaseTypes(
	automation: WritableDraft<Automation>,
	caseTypes: readonly CaseType[],
	automationCaseType: string,
): void {
	if (automation.kind !== "conditional-alert") return;
	for (const event of automation.schedule.events) {
		const templates =
			event.content.kind === "email"
				? [
						event.content.subject,
						event.content.body.kind === "plain-text"
							? event.content.body.message
							: event.content.body.html,
					]
				: event.content.kind === "sms" ||
						event.content.kind === "sms-callback" ||
						event.content.kind === "connect-message"
					? [event.content.message]
					: [];
		for (const template of templates) {
			for (const part of template.parts) {
				if (part.kind !== "case-property") continue;
				part.caseType = automationMessageReferenceCaseType(
					caseTypes,
					automationCaseType,
					part.scope,
				);
			}
		}
	}
}

function AutomationMessageTemplateEditor({
	label,
	template,
	automationCaseType,
	caseTypes,
	hint,
	singleLine = false,
	onChange,
}: {
	label: string;
	template: AutomationMessageTemplate;
	automationCaseType: string;
	caseTypes: readonly CaseType[];
	hint?: string;
	singleLine?: boolean;
	onChange: (template: AutomationMessageTemplate) => void;
}) {
	const labelId = useId();
	const descriptionId = `${labelId}-description`;
	const addReferenceRef = useRef<HTMLButtonElement>(null);
	const removeRefs = useRef(new Map<number, HTMLButtonElement>());
	const [pendingRemovalFocus, setPendingRemovalFocus] = useState<number>();

	useLayoutEffect(() => {
		if (pendingRemovalFocus === undefined) return;
		const nextIndex = Math.min(pendingRemovalFocus, template.parts.length - 1);
		if (nextIndex >= 0) removeRefs.current.get(nextIndex)?.focus();
		else addReferenceRef.current?.focus();
		setPendingRemovalFocus(undefined);
	}, [pendingRemovalFocus, template.parts.length]);

	const replacePart = (
		index: number,
		part: AutomationMessageTemplate["parts"][number],
	) => {
		onChange({
			parts: template.parts.map((current, partIndex) =>
				partIndex === index ? part : current,
			),
		});
	};
	const removePart = (index: number) => {
		setPendingRemovalFocus(index);
		onChange(
			canonicalAutomationMessageTemplate(
				template.parts.filter((_, partIndex) => partIndex !== index),
			),
		);
	};

	return (
		<Field>
			<FieldLabel id={labelId}>{label}</FieldLabel>
			<FieldDescription id={descriptionId}>
				{hint === undefined ? "" : `${hint} `}Typed and pasted text is literal,
				including text like {"{case.foo}"}. Insert a case-property reference
				explicitly when HQ should substitute a value.
			</FieldDescription>
			<fieldset
				aria-labelledby={labelId}
				aria-describedby={descriptionId}
				className="flex flex-col gap-2"
			>
				{template.parts.map((part, index) => {
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: canonical ordered template parts have no independent identity
							key={index}
							className="grid min-w-0 gap-2 rounded-lg border border-nova-border bg-black/10 p-2 @md:grid-cols-[minmax(0,1fr)_auto]"
						>
							{part.kind === "text" ? (
								singleLine ? (
									<Input
										aria-label={
											template.parts.length === 1
												? label
												: `${label} literal text ${index + 1}`
										}
										value={part.text}
										placeholder="Enter literal text"
										onChange={(event) =>
											replacePart(index, {
												kind: "text",
												text: event.target.value,
											})
										}
									/>
								) : (
									<Textarea
										aria-label={
											template.parts.length === 1
												? label
												: `${label} literal text ${index + 1}`
										}
										value={part.text}
										placeholder="Enter literal text"
										onChange={(event) =>
											replacePart(index, {
												kind: "text",
												text: event.target.value,
											})
										}
									/>
								)
							) : (
								<div className="grid min-w-0 gap-2 @md:grid-cols-2">
									<Choice
										value={part.scope}
										aria-label={`${label} reference source ${index + 1}`}
										onChange={(scope) =>
											replacePart(index, {
												...part,
												scope: scope as typeof part.scope,
												caseType: automationMessageReferenceCaseType(
													caseTypes,
													automationCaseType,
													scope as typeof part.scope,
												),
											})
										}
										options={[
											["case", "Matching case"],
											["parent", "Parent case"],
											["host", "Host case"],
										]}
									/>
									<Input
										aria-label={`${label} reference property ${index + 1}`}
										value={part.property}
										placeholder="Enter the Nova property name"
										onChange={(event) =>
											replacePart(index, {
												...part,
												property: event.target.value,
											})
										}
									/>
								</div>
							)}
							<RemoveButton
								label={`Remove ${label.toLowerCase()} part ${index + 1}`}
								buttonRef={(node) => {
									if (node === null) removeRefs.current.delete(index);
									else removeRefs.current.set(index, node);
								}}
								onClick={() => removePart(index)}
							/>
						</div>
					);
				})}
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						disabled={template.parts.at(-1)?.kind === "text"}
						onClick={() =>
							onChange({
								parts: [...template.parts, { kind: "text", text: "" }],
							})
						}
					>
						<Icon icon={tablerPlus} aria-hidden="true" />
						Literal text
					</Button>
					<Button
						ref={addReferenceRef}
						type="button"
						variant="outline"
						onClick={() =>
							onChange({
								parts: [
									...template.parts,
									{
										kind: "case-property",
										scope: "case",
										caseType: automationCaseType,
										property: "",
									},
								],
							})
						}
					>
						<Icon icon={tablerPlus} aria-hidden="true" />
						Case property reference
					</Button>
				</div>
			</fieldset>
		</Field>
	);
}

function Toggle({
	checked,
	onChange,
	label,
	description,
	disabled = false,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
	description?: string;
	disabled?: boolean;
}) {
	const id = useId();
	return (
		<label
			htmlFor={id}
			className={`flex min-h-11 items-start gap-3 rounded-lg border border-white/[0.05] bg-black/10 px-3 py-2.5 ${disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer"}`}
		>
			<Checkbox
				id={id}
				checked={checked}
				onCheckedChange={onChange}
				disabled={disabled}
				className="mt-1"
			/>
			<span className="flex flex-col">
				<span className="text-[13px] text-nova-text">{label}</span>
				{description && (
					<span className="text-[11px] leading-relaxed text-nova-text-secondary">
						{description}
					</span>
				)}
			</span>
		</label>
	);
}

function OptionalNumber({
	label,
	value,
	onChange,
}: {
	label: string;
	value: number | undefined;
	onChange: (value: number | undefined) => void;
}) {
	return (
		<div className="flex flex-col gap-2">
			<Toggle
				checked={value !== undefined}
				onChange={(enabled) => onChange(enabled ? 0 : undefined)}
				label={label}
			/>
			{value !== undefined && (
				<Input
					type="number"
					min={0}
					value={value}
					aria-label="Days"
					onChange={(event) => onChange(Number(event.target.value))}
				/>
			)}
		</div>
	);
}

function RemoveButton({
	label,
	onClick,
	buttonRef,
}: {
	label: string;
	onClick: () => void;
	buttonRef?: Ref<HTMLButtonElement>;
}) {
	return (
		<Button
			ref={buttonRef}
			type="button"
			variant="ghost-destructive"
			onClick={onClick}
		>
			<Icon icon={tablerTrash} aria-hidden="true" />
			{label}
		</Button>
	);
}

function useRepeatedRowRemovalFocus(items: readonly { readonly uuid: Uuid }[]) {
	const addRef = useRef<HTMLButtonElement>(null);
	const removeRefs = useRef(new Map<Uuid, HTMLButtonElement>());
	const [pendingFocus, setPendingFocus] = useState<Uuid | "add">();

	useLayoutEffect(() => {
		if (pendingFocus === undefined) return;
		if (pendingFocus === "add") addRef.current?.focus();
		else removeRefs.current.get(pendingFocus)?.focus();
		setPendingFocus(undefined);
	}, [pendingFocus]);

	return {
		addRef,
		removeButtonRef: (uuid: Uuid) => (node: HTMLButtonElement | null) => {
			if (node === null) removeRefs.current.delete(uuid);
			else removeRefs.current.set(uuid, node);
		},
		removeAt: (index: number, remove: () => void) => {
			setPendingFocus(
				items[index + 1]?.uuid ?? items[index - 1]?.uuid ?? "add",
			);
			remove();
		},
	};
}

function ConditionsEditor({
	automation,
	onEdit,
}: {
	automation: Automation;
	onEdit: (recipe: (draft: WritableDraft<Automation>) => void) => void;
}) {
	const rowFocus = useRepeatedRowRemovalFocus(automation.criteria);
	const hasClosedParent = automation.criteria.some(
		(criterion) => criterion.kind === "closed-parent",
	);
	const add = (kind: "match-property" | "closed-parent") => {
		if (kind === "closed-parent" && hasClosedParent) return;
		onEdit((draft) => {
			if (draft.kind === "case-update") {
				draft.criteria.push(
					kind === "closed-parent"
						? { uuid: uuid(), kind }
						: {
								uuid: uuid(),
								kind,
								scope: "case",
								property: "case_name",
								matchType: "has-value",
							},
				);
			} else if (kind === "match-property") {
				draft.criteria.push({
					uuid: uuid(),
					kind,
					scope: "case",
					property: "case_name",
					matchType: "has-value",
				});
			}
		});
	};
	return (
		<Section
			title="Conditions"
			description={
				automation.kind === "case-update"
					? "The current-match count always excludes closed cases. Server-modified, UCR, and registered custom conditions are named separately because Nova can't count them locally."
					: "The current-match count always excludes closed cases. UCR and registered custom conditions are named separately because Nova can't count them locally."
			}
		>
			{automation.criteria.map((criterion, index) => (
				<div
					key={criterion.uuid}
					className="rounded-lg border border-nova-border bg-black/10 p-3"
				>
					<div className="grid gap-3 @md:grid-cols-2">
						<Labeled label={`Condition ${index + 1}`}>
							{automation.kind === "case-update" ? (
								<Choice
									value={criterion.kind}
									onChange={(kind) =>
										onEdit((draft) => {
											if (draft.kind !== "case-update") return;
											const current = draft.criteria[index];
											if (current === undefined) return;
											draft.criteria[index] =
												kind === "match-property"
													? {
															uuid: current.uuid,
															kind,
															scope: "case",
															property: "case_name",
															matchType: "has-value",
														}
													: {
															uuid: current.uuid,
															kind: "closed-parent",
														};
										})
									}
									options={[
										["match-property", "Case property"],
										[
											"closed-parent",
											"Closed parent",
											hasClosedParent && criterion.kind !== "closed-parent",
										],
									]}
								/>
							) : (
								<p className="flex h-9 items-center text-[13px] text-nova-text">
									Case property
								</p>
							)}
						</Labeled>
						{criterion.kind === "match-property" && (
							<>
								{automation.kind === "case-update" && (
									<Labeled label="Case source">
										<Choice
											value={criterion.scope}
											onChange={(scope) =>
												onEdit((draft) => {
													if (draft.kind !== "case-update") return;
													const item = draft.criteria[index];
													if (item?.kind === "match-property") {
														item.scope = scope as typeof item.scope;
													}
												})
											}
											options={[
												["case", "Matching case"],
												["parent", "Parent case"],
												["host", "Host case"],
											]}
										/>
									</Labeled>
								)}
								<Labeled
									label="Property"
									hint="Use the Nova name; setup guidance translates standard names for HQ. Case status is not representable here."
								>
									<Input
										value={criterion.property}
										onChange={(event) =>
											onEdit((draft) => {
												const item = draft.criteria[index];
												if (item?.kind === "match-property")
													item.property = event.target.value;
											})
										}
									/>
								</Labeled>
								<Labeled label="Comparison">
									<Choice
										value={criterion.matchType}
										onChange={(matchType) =>
											onEdit((draft) => {
												const item = draft.criteria[index];
												if (item?.kind !== "match-property") return;
												item.matchType = matchType as typeof item.matchType;
												if (["equal", "not-equal", "regex"].includes(matchType))
													item.value = matchType === "regex" ? ".*" : "value";
												else delete item.value;
												if (matchType.startsWith("date-")) item.days = 0;
												else delete item.days;
											})
										}
										options={[
											["equal", "Equals"],
											["not-equal", "Doesn't equal"],
											["has-value", "Has a value"],
											["has-no-value", "Has no value"],
											...(automation.kind === "conditional-alert"
												? ([["regex", "Matches regular expression"]] as const)
												: ([
														[
															"date-days-before",
															"Current date < property date + offset",
														],
														[
															"date-days-lte",
															"Current date ≤ property date + offset",
														],
														[
															"date-days-gt",
															"Current date > property date + offset",
														],
														[
															"date-days",
															"Current date ≥ property date + offset",
														],
													] as const)),
										]}
									/>
								</Labeled>
								{criterion.value !== undefined && (
									<Labeled
										label={
											criterion.matchType === "regex"
												? "Regular expression"
												: "Value"
										}
									>
										<Input
											value={criterion.value}
											onChange={(event) =>
												onEdit((draft) => {
													const item = draft.criteria[index];
													if (item?.kind === "match-property")
														item.value = event.target.value;
												})
											}
										/>
									</Labeled>
								)}
								{criterion.days !== undefined && (
									<Labeled
										label="Day offset"
										hint="HQ compares the current date with the property date plus this many days; use a negative number for minus."
									>
										<Input
											type="number"
											value={criterion.days}
											onChange={(event) =>
												onEdit((draft) => {
													const item = draft.criteria[index];
													if (item?.kind === "match-property")
														item.days = Number(event.target.value);
												})
											}
										/>
									</Labeled>
								)}
							</>
						)}
						{criterion.kind === "closed-parent" && (
							<p className="self-center text-[12px] leading-relaxed text-nova-text-secondary">
								CommCare HQ checks its standard parent link. Its setup form does
								not expose custom index names or extension relationships.
							</p>
						)}
					</div>
					<div className="mt-2">
						<RemoveButton
							label="Remove condition"
							buttonRef={rowFocus.removeButtonRef(criterion.uuid)}
							onClick={() =>
								rowFocus.removeAt(index, () =>
									onEdit((draft) => {
										draft.criteria.splice(index, 1);
									}),
								)
							}
						/>
					</div>
				</div>
			))}
			<div className="flex flex-wrap gap-2">
				<Button
					ref={rowFocus.addRef}
					type="button"
					variant="outline"
					onClick={() => add("match-property")}
				>
					<Icon icon={tablerPlus} />
					Property condition
				</Button>
				{automation.kind === "case-update" && (
					<Button
						type="button"
						variant="outline"
						disabled={hasClosedParent}
						onClick={() => add("closed-parent")}
					>
						<Icon icon={tablerPlus} />
						Closed parent
					</Button>
				)}
			</div>
		</Section>
	);
}

function SetupOnlyEditor({
	automation,
	onEdit,
}: {
	automation: Automation;
	onEdit: (recipe: (draft: WritableDraft<Automation>) => void) => void;
}) {
	const rowFocus = useRepeatedRowRemovalFocus(automation.setupOnlyCriteria);
	return (
		<Section
			title="HQ-only conditions"
			description="Use this for a UCR filter or a registered custom condition. Nova preserves the exact setup note and names it as omitted from the current-match count."
		>
			{automation.setupOnlyCriteria.map((criterion, index) => (
				<div key={criterion.uuid} className="flex items-start gap-2">
					<Textarea
						aria-label={`HQ-only condition ${index + 1}`}
						value={criterion.text}
						placeholder="Describe the exact CommCare HQ condition"
						onChange={(event) =>
							onEdit((draft) => {
								const item = draft.setupOnlyCriteria[index];
								if (item) item.text = event.target.value;
							})
						}
					/>
					<RemoveButton
						label="Remove"
						buttonRef={rowFocus.removeButtonRef(criterion.uuid)}
						onClick={() =>
							rowFocus.removeAt(index, () =>
								onEdit((draft) => {
									draft.setupOnlyCriteria.splice(index, 1);
								}),
							)
						}
					/>
				</div>
			))}
			<Button
				ref={rowFocus.addRef}
				type="button"
				variant="outline"
				onClick={() =>
					onEdit((draft) => {
						draft.setupOnlyCriteria.push({
							uuid: uuid(),
							text: "",
						});
					})
				}
			>
				<Icon icon={tablerPlus} />
				HQ-only condition
			</Button>
		</Section>
	);
}

function CaseUpdateEditor({
	automation,
	onEdit,
}: {
	automation: Extract<Automation, { kind: "case-update" }>;
	onEdit: (recipe: (draft: WritableDraft<Automation>) => void) => void;
}) {
	const rowFocus = useRepeatedRowRemovalFocus(automation.updates);
	return (
		<Section
			title="Case changes"
			description="A daily CommCare HQ sweep applies these changes. At least one property update or Close case is required."
		>
			<Toggle
				checked={automation.closeCase}
				onChange={(checked) =>
					onEdit((draft) => {
						if (draft.kind === "case-update") draft.closeCase = checked;
					})
				}
				label="Close the matching case"
			/>
			{automation.updates.map((update, index) => (
				<div
					key={update.uuid}
					className="rounded-lg border border-nova-border bg-black/10 p-3"
				>
					<div className="grid gap-3 @md:grid-cols-2">
						<Labeled label="Change">
							<Choice
								value={update.target.scope}
								onChange={(value) =>
									onEdit((draft) => {
										if (draft.kind === "case-update" && draft.updates[index])
											draft.updates[index].target.scope = value as
												| "case"
												| "parent"
												| "host";
									})
								}
								options={[
									["case", "Matching case"],
									["parent", "Parent case"],
									["host", "Host case"],
								]}
							/>
						</Labeled>
						<Labeled
							label="Property"
							hint="Use the Nova name; setup guidance translates supported standard targets for HQ."
						>
							<Input
								value={update.target.property}
								onChange={(event) =>
									onEdit((draft) => {
										if (draft.kind === "case-update" && draft.updates[index])
											draft.updates[index].target.property = event.target.value;
									})
								}
							/>
						</Labeled>
						<Labeled label="Value source">
							<Choice
								value={update.value.kind}
								onChange={(kind) =>
									onEdit((draft) => {
										if (draft.kind !== "case-update") return;
										const item = draft.updates[index];
										if (!item) return;
										item.value =
											kind === "literal"
												? { kind, value: "value" }
												: {
														kind: "case-property",
														source: { scope: "case", property: "case_name" },
													};
									})
								}
								options={[
									["literal", "Fixed value"],
									["case-property", "Another case property"],
								]}
							/>
						</Labeled>
						{update.value.kind === "literal" ? (
							<Labeled label="Fixed value">
								<Input
									value={update.value.value}
									onChange={(event) =>
										onEdit((draft) => {
											if (draft.kind === "case-update") {
												const item = draft.updates[index];
												if (item?.value.kind === "literal")
													item.value.value = event.target.value;
											}
										})
									}
								/>
							</Labeled>
						) : (
							<>
								<Labeled label="Read from">
									<Choice
										value={update.value.source.scope}
										onChange={(value) =>
											onEdit((draft) => {
												if (draft.kind === "case-update") {
													const item = draft.updates[index];
													if (item?.value.kind === "case-property")
														item.value.source.scope = value as
															| "case"
															| "parent"
															| "host";
												}
											})
										}
										options={[
											["case", "Matching case"],
											["parent", "Parent case"],
											["host", "Host case"],
										]}
									/>
								</Labeled>
								<Labeled
									label="Source property"
									hint="Use the Nova name; setup guidance translates standard names for HQ."
								>
									<Input
										value={update.value.source.property}
										onChange={(event) =>
											onEdit((draft) => {
												if (draft.kind === "case-update") {
													const item = draft.updates[index];
													if (item?.value.kind === "case-property")
														item.value.source.property = event.target.value;
												}
											})
										}
									/>
								</Labeled>
							</>
						)}
					</div>
					<RemoveButton
						label="Remove change"
						buttonRef={rowFocus.removeButtonRef(update.uuid)}
						onClick={() =>
							rowFocus.removeAt(index, () =>
								onEdit((draft) => {
									if (draft.kind === "case-update")
										draft.updates.splice(index, 1);
								}),
							)
						}
					/>
				</div>
			))}
			<Button
				ref={rowFocus.addRef}
				type="button"
				variant="outline"
				onClick={() =>
					onEdit((draft) => {
						if (draft.kind === "case-update")
							draft.updates.push({
								uuid: uuid(),
								target: { scope: "case", property: "case_name" },
								value: { kind: "literal", value: "value" },
							});
					})
				}
			>
				<Icon icon={tablerPlus} />
				Property change
			</Button>
		</Section>
	);
}

function recipientFor(
	kind: AutomationRecipient["kind"],
	locations: readonly StoredLocation[],
	existingRecipients: readonly AutomationRecipient[],
): AutomationRecipient | undefined {
	const id = uuid();
	if (
		[
			"self",
			"owner",
			"last-submitting-user",
			"parent-case",
			"all-child-cases",
		].includes(kind)
	)
		return { uuid: id, kind } as AutomationRecipient;
	if (
		[
			"case-property-username",
			"case-property-user-id",
			"case-property-email",
		].includes(kind)
	)
		return { uuid: id, kind, property: "case_name" } as AutomationRecipient;
	if (kind === "location") {
		const availableLocation = locations.find(
			(location) =>
				!existingRecipients.some(
					(recipient) =>
						recipient.kind === "location" &&
						recipient.locationUuid === location.id,
				),
		);
		return availableLocation
			? { uuid: id, kind, locationUuid: asUuid(availableLocation.id) }
			: undefined;
	}
	if (["mobile-worker", "user-group", "case-group"].includes(kind)) {
		return {
			uuid: id,
			kind,
			hqId: "",
		} as AutomationRecipient;
	}
	return { uuid: id, kind: "custom", registeredId: "" };
}

function recipientKindAvailable(
	kind: AutomationRecipient["kind"],
	recipients: readonly AutomationRecipient[],
	locations: readonly StoredLocation[],
	usesConnect: boolean,
	excludeUuid?: Uuid,
): boolean {
	if (usesConnect && !automationRecipientSupportsConnect(kind)) return false;
	const peers = recipients.filter(
		(recipient) => recipient.uuid !== excludeUuid,
	);
	if (
		automationRecipientKindIsSingleton(kind) &&
		peers.some((recipient) => recipient.kind === kind)
	) {
		return false;
	}
	if (kind === "location") {
		return locations.some(
			(location) =>
				!peers.some(
					(recipient) =>
						recipient.kind === "location" &&
						recipient.locationUuid === location.id,
				),
		);
	}
	return true;
}

function clearLocationSettingsWithoutRecipient(
	draft: WritableDraft<Automation>,
): void {
	if (
		draft.kind === "conditional-alert" &&
		!draft.recipients.some((recipient) => recipient.kind === "location")
	) {
		draft.includeDescendantLocations = false;
		draft.locationLevelUuids = [];
	}
}

function contentFor(
	kind: AutomationContent["kind"],
	forms: readonly AutomationFormChoice[],
): AutomationContent | undefined {
	if (kind === "sms")
		return { kind, message: automationMessageText("Message") };
	if (kind === "email")
		return {
			kind,
			subject: automationMessageText("Subject"),
			body: {
				kind: "plain-text",
				message: automationMessageText("Message"),
			},
		};
	if (kind === "connect-message")
		return { kind, message: automationMessageText("Message") };
	if (kind === "custom") return { kind, registeredId: "" };
	if (kind === "sms-callback")
		return {
			kind,
			message: automationMessageText("Message"),
			reminderIntervalsMinutes: [5],
		};
	const formUuid = forms[0]?.uuid;
	if (formUuid === undefined) return undefined;
	if (kind === "ivr")
		return {
			kind,
			formUuid,
			reminderIntervalsMinutes: [5],
			submitPartiallyCompletedForms: false,
			includeCaseUpdatesInPartialSubmissions: false,
			maxQuestionAttempts: 3,
		};
	return {
		kind,
		formUuid,
		expirationHours: 24,
		reminderIntervalsMinutes: [],
		submitPartiallyCompletedForms: false,
		includeCaseUpdatesInPartialSubmissions: false,
	} as AutomationContent;
}

function AlertEditor({
	automation,
	caseTypes,
	forms,
	locations,
	levels,
	userProperties,
	onEdit,
}: {
	automation: Extract<Automation, { kind: "conditional-alert" }>;
	caseTypes: readonly CaseType[];
	forms: readonly AutomationFormChoice[];
	locations: readonly StoredLocation[];
	levels: readonly { uuid: Uuid; name: string }[];
	userProperties: readonly { uuid: Uuid; label: string; slug: string }[];
	onEdit: (recipe: (draft: WritableDraft<Automation>) => void) => void;
}) {
	const recipientFocus = useRepeatedRowRemovalFocus(automation.recipients);
	const filterFocus = useRepeatedRowRemovalFocus(automation.userDataFilters);
	const usesConnect = automation.schedule.events.some(
		(event) =>
			event.content.kind === "connect-message" ||
			event.content.kind === "connect-survey",
	);
	const resetAllowed =
		automation.schedule.kind === "immediate" ||
		automation.schedule.start.kind === "rule-trigger";
	const hasLocationRecipient = automation.recipients.some(
		(recipient) => recipient.kind === "location",
	);
	const addRecipientKind = RECIPIENT_KINDS.find(([kind]) =>
		recipientKindAvailable(kind, automation.recipients, locations, usesConnect),
	)?.[0];
	const nextFilterProperty = userProperties.find(
		(property) =>
			!automation.userDataFilters.some(
				(filter) => filter.userPropertyUuid === property.uuid,
			),
	);
	return (
		<div className="flex flex-col gap-6">
			<Section title="Recipients">
				{automation.recipients.map((recipient, index) => (
					<div
						key={recipient.uuid}
						className="rounded-lg border border-nova-border bg-black/10 p-3"
					>
						<div className="grid gap-3 @md:grid-cols-2">
							<Labeled label={`Recipient ${index + 1}`}>
								<Choice
									value={recipient.kind}
									onChange={(kind) => {
										const peers = automation.recipients.filter(
											(candidate) => candidate.uuid !== recipient.uuid,
										);
										const replacement = recipientFor(
											kind as AutomationRecipient["kind"],
											locations,
											peers,
										);
										if (replacement)
											onEdit((draft) => {
												if (draft.kind === "conditional-alert") {
													replacement.uuid = recipient.uuid;
													draft.recipients[index] =
														replacement as WritableDraft<AutomationRecipient>;
													clearLocationSettingsWithoutRecipient(draft);
												}
											});
									}}
									options={RECIPIENT_KINDS.map(([kind, label]) => {
										const connectBlocked =
											usesConnect && !automationRecipientSupportsConnect(kind);
										const unavailable = !recipientKindAvailable(
											kind,
											automation.recipients,
											locations,
											usesConnect,
											recipient.uuid,
										);
										return [
											kind,
											kind === "location" && locations.length === 0
												? "Location (add a place first)"
												: connectBlocked
													? `${label} (not available for Connect)`
													: unavailable
														? `${label} (already selected)`
														: label,
											unavailable,
										] as const;
									})}
								/>
							</Labeled>
							{"property" in recipient && (
								<Labeled
									label="Case property"
									hint="Use the Nova name; setup guidance translates standard names for HQ."
								>
									<Input
										value={recipient.property}
										onChange={(event) =>
											onEdit((draft) => {
												if (draft.kind === "conditional-alert") {
													const item = draft.recipients[index];
													if (item && "property" in item)
														item.property = event.target.value;
												}
											})
										}
									/>
								</Labeled>
							)}
							{"hqId" in recipient && (
								<Labeled label="CommCare HQ ID">
									<Input
										value={recipient.hqId}
										placeholder="Enter the CommCare HQ ID"
										onChange={(event) =>
											onEdit((draft) => {
												if (draft.kind === "conditional-alert") {
													const item = draft.recipients[index];
													if (item && "hqId" in item)
														item.hqId = event.target.value;
												}
											})
										}
									/>
								</Labeled>
							)}
							{"registeredId" in recipient && (
								<Labeled
									label="Registered ID"
									hint="Choose the exact handler registered in the target CommCare HQ project"
								>
									<Input
										value={recipient.registeredId}
										placeholder="Enter the registered recipient ID"
										onChange={(event) =>
											onEdit((draft) => {
												if (draft.kind === "conditional-alert") {
													const item = draft.recipients[index];
													if (item && "registeredId" in item)
														item.registeredId = event.target.value;
												}
											})
										}
									/>
								</Labeled>
							)}
							{recipient.kind === "location" && (
								<Labeled label="Location">
									<Choice
										value={recipient.locationUuid}
										onChange={(value) =>
											onEdit((draft) => {
												if (draft.kind === "conditional-alert") {
													const item = draft.recipients[index];
													if (item?.kind === "location")
														item.locationUuid = asUuid(value);
												}
											})
										}
										options={locations.map((location) => [
											location.id,
											location.name,
											automation.recipients.some(
												(candidate) =>
													candidate.uuid !== recipient.uuid &&
													candidate.kind === "location" &&
													candidate.locationUuid === location.id,
											),
										])}
									/>
								</Labeled>
							)}
						</div>
						<RemoveButton
							label="Remove recipient"
							buttonRef={recipientFocus.removeButtonRef(recipient.uuid)}
							onClick={() =>
								recipientFocus.removeAt(index, () =>
									onEdit((draft) => {
										if (draft.kind === "conditional-alert") {
											draft.recipients.splice(index, 1);
											clearLocationSettingsWithoutRecipient(draft);
										}
									}),
								)
							}
						/>
					</div>
				))}
				<Button
					ref={recipientFocus.addRef}
					type="button"
					variant="outline"
					disabled={addRecipientKind === undefined}
					onClick={() =>
						onEdit((draft) => {
							if (
								draft.kind === "conditional-alert" &&
								addRecipientKind !== undefined
							) {
								const recipient = recipientFor(
									addRecipientKind,
									locations,
									draft.recipients,
								);
								if (recipient !== undefined) draft.recipients.push(recipient);
							}
						})
					}
				>
					<Icon icon={tablerPlus} />
					Recipient
				</Button>
			</Section>
			<ScheduleEditor
				automation={automation}
				caseTypes={caseTypes}
				forms={forms}
				onEdit={onEdit}
			/>
			<Section title="Recipient filters and schedule controls">
				{hasLocationRecipient && (
					<Toggle
						checked={automation.includeDescendantLocations}
						onChange={(checked) =>
							onEdit((draft) => {
								if (draft.kind === "conditional-alert") {
									draft.includeDescendantLocations = checked;
									if (!checked) draft.locationLevelUuids = [];
								}
							})
						}
						label="Include descendant locations for location recipients"
					/>
				)}
				<Labeled
					label="Default language code"
					hint="Leave empty for Project Default. Any code must already be configured in the target HQ project"
				>
					<Input
						value={automation.defaultLanguageCode ?? ""}
						onChange={(event) =>
							onEdit((draft) => {
								if (draft.kind === "conditional-alert") {
									if (event.target.value === "")
										delete draft.defaultLanguageCode;
									else draft.defaultLanguageCode = event.target.value;
								}
							})
						}
					/>
				</Labeled>
				{hasLocationRecipient && automation.includeDescendantLocations && (
					<div>
						<p className="mb-2 text-[12px] font-medium text-nova-text-secondary">
							Location levels for broadcast recipients
						</p>
						<div className="grid gap-2 @md:grid-cols-2">
							{levels.map((level) => (
								<Toggle
									key={level.uuid}
									checked={automation.locationLevelUuids.includes(level.uuid)}
									onChange={(checked) =>
										onEdit((draft) => {
											if (draft.kind !== "conditional-alert") return;
											draft.locationLevelUuids = checked
												? [...draft.locationLevelUuids, level.uuid]
												: draft.locationLevelUuids.filter(
														(uuid) => uuid !== level.uuid,
													);
										})
									}
									label={level.name}
								/>
							))}
						</div>
					</div>
				)}
				<Toggle
					checked={automation.useUserCaseForFilter}
					onChange={(checked) =>
						onEdit((draft) => {
							if (draft.kind === "conditional-alert")
								draft.useUserCaseForFilter = checked;
						})
					}
					label="Read filters from user cases"
				/>
				{automation.userDataFilters.map((filter, index) => (
					<div
						key={filter.uuid}
						className="grid gap-3 rounded-lg border border-nova-border bg-black/10 p-3 @md:grid-cols-2"
					>
						<Labeled label="Worker information">
							<Choice
								value={filter.userPropertyUuid}
								onChange={(value) =>
									onEdit((draft) => {
										if (
											draft.kind === "conditional-alert" &&
											draft.userDataFilters[index]
										)
											draft.userDataFilters[index].userPropertyUuid =
												asUuid(value);
									})
								}
								options={userProperties.map((property) => [
									property.uuid,
									`${property.label} (${property.slug})`,
									automation.userDataFilters.some(
										(candidate) =>
											candidate.uuid !== filter.uuid &&
											candidate.userPropertyUuid === property.uuid,
									),
								])}
							/>
						</Labeled>
						<Labeled label="Accepted values" hint="One per line">
							<Textarea
								value={filter.allowedValues.join("\n")}
								onChange={(event) =>
									onEdit((draft) => {
										if (
											draft.kind === "conditional-alert" &&
											draft.userDataFilters[index]
										)
											draft.userDataFilters[index].allowedValues =
												event.target.value
													.split("\n")
													.map((value) => value.trim())
													.filter(Boolean);
									})
								}
							/>
						</Labeled>
						<RemoveButton
							label="Remove filter"
							buttonRef={filterFocus.removeButtonRef(filter.uuid)}
							onClick={() =>
								filterFocus.removeAt(index, () =>
									onEdit((draft) => {
										if (draft.kind === "conditional-alert")
											draft.userDataFilters.splice(index, 1);
									}),
								)
							}
						/>
					</div>
				))}
				<Button
					ref={filterFocus.addRef}
					type="button"
					variant="outline"
					disabled={nextFilterProperty === undefined}
					onClick={() =>
						onEdit((draft) => {
							if (draft.kind === "conditional-alert" && nextFilterProperty)
								draft.userDataFilters.push({
									uuid: uuid(),
									userPropertyUuid: nextFilterProperty.uuid,
									allowedValues: [""],
								});
						})
					}
				>
					<Icon icon={tablerPlus} />
					Recipient filter
				</Button>
				<Labeled
					label="Restart when this case property changes"
					hint={
						resetAllowed
							? "HQ reads only custom case data here; standard properties are not available"
							: "CommCare HQ enables this only when a timed schedule starts from the rule trigger"
					}
				>
					<Input
						disabled={!resetAllowed}
						value={automation.resetCaseProperty ?? ""}
						onChange={(event) =>
							onEdit((draft) => {
								if (draft.kind === "conditional-alert") {
									if (event.target.value === "") delete draft.resetCaseProperty;
									else draft.resetCaseProperty = event.target.value;
								}
							})
						}
					/>
				</Labeled>
				<Labeled
					label="Stop after the date in this case property"
					hint="Use the Nova name; setup guidance translates standard date names for HQ"
				>
					<Input
						value={automation.stopDateCaseProperty ?? ""}
						onChange={(event) =>
							onEdit((draft) => {
								if (draft.kind === "conditional-alert") {
									if (event.target.value === "")
										delete draft.stopDateCaseProperty;
									else draft.stopDateCaseProperty = event.target.value;
								}
							})
						}
					/>
				</Labeled>
			</Section>
		</div>
	);
}

function ScheduleEditor({
	automation,
	caseTypes,
	forms,
	onEdit,
}: {
	automation: Extract<Automation, { kind: "conditional-alert" }>;
	caseTypes: readonly CaseType[];
	forms: readonly AutomationFormChoice[];
	onEdit: (recipe: (draft: WritableDraft<Automation>) => void) => void;
}) {
	const schedule = automation.schedule;
	const eventFocus = useRepeatedRowRemovalFocus(schedule.events);
	const timedSetupForm =
		schedule.kind === "timed"
			? automationTimedScheduleSetupForm(schedule)
			: undefined;
	const connectRecipientBlocked = automation.recipients.some(
		(recipient) => !automationRecipientSupportsConnect(recipient.kind),
	);
	const fixedDayChoicesExhausted =
		schedule.kind === "timed" &&
		((timedSetupForm === "monthly" &&
			new Set(schedule.events.map((event) => event.day)).size ===
				MONTHLY_EVENT_DAYS.length) ||
			(timedSetupForm === "weekly" &&
				new Set(schedule.events.map((event) => event.day)).size ===
					WEEKDAY_NAMES.length));
	const removeEvent = (index: number) =>
		eventFocus.removeAt(index, () =>
			onEdit((draft) => {
				if (draft.kind !== "conditional-alert") return;
				draft.schedule.events.splice(index, 1);
				if (
					draft.schedule.kind === "timed" &&
					automationTimedScheduleSetupForm(draft.schedule) === "custom-daily" &&
					draft.schedule.totalIterations === 1 &&
					draft.schedule.events.length > 0
				) {
					draft.schedule.repeatEvery =
						(draft.schedule.events.at(-1)?.day ?? 0) + 1;
				}
			}),
		);
	const setSchedule = (kind: AutomationSchedule["kind"]) =>
		onEdit((draft) => {
			if (draft.kind !== "conditional-alert") return;
			const content = cloneEditableValue(
				draft.schedule.events[0]?.content ?? {
					kind: "sms",
					message: automationMessageText("Message"),
				},
			);
			draft.schedule =
				kind === "immediate"
					? {
							kind,
							events: [
								{
									uuid: uuid(),
									minutesToWait: 0,
									content,
								},
							],
						}
					: {
							kind,
							repeatEvery: 1,
							totalIterations: 1,
							startOffsetDays: 0,
							startDayOfWeek: -1,
							start: { kind: "rule-trigger" },
							events: [
								{
									uuid: uuid(),
									day: 0,
									timing: { kind: "specific-time", time: "09:00" },
									content,
								},
							],
						};
		});
	const setTimedSetupForm = (form: "custom-daily" | "weekly" | "monthly") =>
		onEdit((draft) => {
			if (draft.kind !== "conditional-alert" || draft.schedule.kind !== "timed")
				return;
			const first = draft.schedule.events[0];
			const event = {
				uuid: first?.uuid ?? uuid(),
				day: form === "monthly" ? 1 : 0,
				timing: cloneEditableValue(
					first?.timing ?? { kind: "specific-time", time: "09:00" },
				),
				content: cloneEditableValue(
					first?.content ?? {
						kind: "sms",
						message: automationMessageText("Message"),
					},
				),
			};
			draft.schedule.events = [event];
			draft.schedule.startOffsetDays = 0;
			if (form === "monthly") {
				draft.schedule.repeatEvery = -1;
				draft.schedule.startDayOfWeek = -1;
			} else if (form === "weekly") {
				draft.schedule.repeatEvery = 7;
				draft.schedule.startDayOfWeek =
					draft.schedule.start.kind === "specific-date"
						? weekdayIndexForIsoDate(draft.schedule.start.date)
						: 0;
			} else {
				draft.schedule.repeatEvery = 1;
				draft.schedule.startDayOfWeek = -1;
			}
		});
	return (
		<Section title="Schedule">
			<Labeled label="Schedule type">
				<Choice
					value={schedule.kind}
					onChange={(kind) => setSchedule(kind as AutomationSchedule["kind"])}
					options={[
						["immediate", "Immediate sequence"],
						["timed", "Timed repeating schedule"],
					]}
				/>
			</Labeled>
			<Labeled label="Schedule content type">
				<Choice
					value={schedule.events[0]?.content.kind ?? "sms"}
					onChange={(kind) => {
						const replacement = contentFor(
							kind as AutomationContent["kind"],
							forms,
						);
						if (replacement === undefined) return;
						onEdit((draft) => {
							if (draft.kind !== "conditional-alert") return;
							for (const item of draft.schedule.events) {
								item.content = cloneEditableValue(replacement);
							}
						});
					}}
					options={CONTENT_KINDS.map(([kind, label]) => {
						const needsForm = ["sms-survey", "ivr", "connect-survey"].includes(
							kind,
						);
						const connectBlocked =
							(kind === "connect-message" || kind === "connect-survey") &&
							connectRecipientBlocked;
						return [
							kind,
							needsForm && forms.length === 0
								? `${label} (add a form first)`
								: connectBlocked
									? `${label} (choose Connect-compatible recipients first)`
									: label,
							(needsForm && forms.length === 0) || connectBlocked,
						] as const;
					})}
				/>
			</Labeled>
			{schedule.kind === "timed" && (
				<div className="grid gap-3 @md:grid-cols-2">
					<Labeled label="CommCare HQ schedule form">
						<Choice
							value={timedSetupForm ?? "custom-daily"}
							onChange={(value) =>
								setTimedSetupForm(
									value as "custom-daily" | "weekly" | "monthly",
								)
							}
							options={[
								["custom-daily", "Custom daily"],
								["weekly", "Weekly"],
								["monthly", "Monthly"],
							]}
						/>
					</Labeled>
					<Labeled
						label={`Repeat every ${timedSetupForm === "monthly" ? "months" : timedSetupForm === "weekly" ? "weeks" : "days"}`}
						hint={
							schedule.totalIterations === 1
								? "CommCare HQ derives this value when Repeat is off"
								: undefined
						}
					>
						<Input
							type="number"
							min={1}
							disabled={schedule.totalIterations === 1}
							value={
								timedSetupForm === "monthly"
									? Math.abs(schedule.repeatEvery)
									: timedSetupForm === "weekly"
										? schedule.repeatEvery / 7
										: schedule.repeatEvery
							}
							onChange={(event) =>
								onEdit((draft) => {
									if (
										draft.kind === "conditional-alert" &&
										draft.schedule.kind === "timed"
									)
										draft.schedule.repeatEvery =
											timedSetupForm === "monthly"
												? -Number(event.target.value)
												: timedSetupForm === "weekly"
													? Number(event.target.value) * 7
													: Number(event.target.value);
								})
							}
						/>
					</Labeled>
					<Labeled label="Total iterations" hint="Use -1 for indefinitely">
						<Input
							type="number"
							value={schedule.totalIterations}
							onChange={(event) =>
								onEdit((draft) => {
									if (
										draft.kind === "conditional-alert" &&
										draft.schedule.kind === "timed"
									) {
										draft.schedule.totalIterations = Number(event.target.value);
										if (draft.schedule.totalIterations === 1) {
											draft.schedule.repeatEvery =
												timedSetupForm === "monthly"
													? -1
													: timedSetupForm === "weekly"
														? 7
														: (draft.schedule.events.at(-1)?.day ?? 0) + 1;
										}
									}
								})
							}
						/>
					</Labeled>
					{timedSetupForm === "custom-daily" &&
						schedule.start.kind !== "specific-date" && (
							<Labeled label="Start offset in days">
								<Input
									type="number"
									min={schedule.start.kind === "rule-trigger" ? 0 : undefined}
									value={schedule.startOffsetDays}
									onChange={(event) =>
										onEdit((draft) => {
											if (
												draft.kind === "conditional-alert" &&
												draft.schedule.kind === "timed"
											)
												draft.schedule.startOffsetDays = Number(
													event.target.value,
												);
										})
									}
								/>
							</Labeled>
						)}
					{timedSetupForm === "weekly" &&
						schedule.start.kind !== "specific-date" && (
							<Labeled label="Start weekday">
								<Choice
									value={String(schedule.startDayOfWeek)}
									onChange={(value) =>
										onEdit((draft) => {
											if (
												draft.kind === "conditional-alert" &&
												draft.schedule.kind === "timed"
											) {
												remapWeeklyEventOffsets(draft.schedule, Number(value));
											}
										})
									}
									options={[
										["0", "Monday"],
										["1", "Tuesday"],
										["2", "Wednesday"],
										["3", "Thursday"],
										["4", "Friday"],
										["5", "Saturday"],
										["6", "Sunday"],
									]}
								/>
							</Labeled>
						)}
					<Labeled label="Start from">
						<Choice
							value={schedule.start.kind}
							onChange={(kind) =>
								onEdit((draft) => {
									if (
										draft.kind !== "conditional-alert" ||
										draft.schedule.kind !== "timed"
									)
										return;
									const date = localIsoDate();
									draft.schedule.start =
										kind === "rule-trigger"
											? { kind }
											: kind === "case-property"
												? { kind, property: "date_opened" }
												: {
														kind: "specific-date",
														date,
													};
									if (kind !== "rule-trigger") {
										delete draft.resetCaseProperty;
									}
									if (kind === "specific-date") {
										draft.schedule.startOffsetDays = 0;
										if (timedSetupForm === "weekly") {
											remapWeeklyEventOffsets(
												draft.schedule,
												weekdayIndexForIsoDate(date),
											);
										}
									}
								})
							}
							options={[
								["rule-trigger", "First match"],
								["case-property", "Case property date"],
								["specific-date", "Specific date"],
							]}
						/>
					</Labeled>
					{schedule.start.kind === "case-property" && (
						<Labeled
							label="Start date property"
							hint="Use the Nova name; setup guidance translates standard date names for HQ"
						>
							<Input
								value={schedule.start.property}
								onChange={(event) =>
									onEdit((draft) => {
										if (
											draft.kind === "conditional-alert" &&
											draft.schedule.kind === "timed" &&
											draft.schedule.start.kind === "case-property"
										)
											draft.schedule.start.property = event.target.value;
									})
								}
							/>
						</Labeled>
					)}
					{schedule.start.kind === "specific-date" && (
						<Labeled label="Start date">
							<DatePicker
								value={schedule.start.date}
								clearable={false}
								onValueChange={(date) => {
									if (date === "") return;
									onEdit((draft) => {
										if (
											draft.kind === "conditional-alert" &&
											draft.schedule.kind === "timed" &&
											draft.schedule.start.kind === "specific-date"
										) {
											draft.schedule.start.date = date;
											if (timedSetupForm === "weekly") {
												remapWeeklyEventOffsets(
													draft.schedule,
													weekdayIndexForIsoDate(date),
												);
											}
										}
									});
								}}
							/>
						</Labeled>
					)}
					<Labeled
						label="Schedule timing mode"
						hint="CommCare HQ applies one timing mode to every event"
					>
						<Choice
							value={schedule.events[0]?.timing.kind ?? "specific-time"}
							onChange={(kind) =>
								onEdit((draft) => {
									if (
										draft.kind !== "conditional-alert" ||
										draft.schedule.kind !== "timed"
									)
										return;
									for (const item of draft.schedule.events) {
										item.timing =
											kind === "specific-time"
												? { kind, time: "09:00" }
												: kind === "random-window"
													? { kind, time: "09:00", windowMinutes: 60 }
													: {
															kind: "case-property-time",
															property: "time",
														};
									}
								})
							}
							options={[
								["specific-time", "Specific time"],
								["random-window", "Random time in a window"],
								["case-property-time", "Time in a case property"],
							]}
						/>
					</Labeled>
				</div>
			)}
			{schedule.events.map((event, index) => (
				<EventEditor
					key={event.uuid}
					event={event}
					automationCaseType={automation.caseType}
					caseTypes={caseTypes}
					index={index}
					eventDays={schedule.events.map((item) => ({
						uuid: item.uuid,
						day: "day" in item ? item.day : 0,
					}))}
					scheduleKind={schedule.kind}
					timedSetupForm={timedSetupForm}
					startDayOfWeek={
						schedule.kind === "timed" ? schedule.startDayOfWeek : undefined
					}
					repeatEvery={
						schedule.kind === "timed" ? schedule.repeatEvery : undefined
					}
					repeatIsDerived={
						schedule.kind === "timed" && schedule.totalIterations === 1
					}
					forms={forms}
					removeButtonRef={eventFocus.removeButtonRef(event.uuid)}
					onRemove={() => removeEvent(index)}
					onEdit={onEdit}
				/>
			))}
			<Button
				ref={eventFocus.addRef}
				type="button"
				variant="outline"
				disabled={fixedDayChoicesExhausted}
				onClick={() =>
					onEdit((draft) => {
						if (draft.kind !== "conditional-alert") return;
						if (draft.schedule.kind === "immediate")
							draft.schedule.events.push({
								uuid: uuid(),
								minutesToWait: draft.schedule.events.length === 0 ? 0 : 5,
								content: cloneEditableValue(
									draft.schedule.events[0]?.content ?? {
										kind: "sms",
										message: automationMessageText("Message"),
									},
								),
							});
						else {
							const first = draft.schedule.events[0];
							const previous = draft.schedule.events.at(-1);
							const setupForm = automationTimedScheduleSetupForm(
								draft.schedule,
							);
							let day = setupForm === "monthly" ? 1 : 0;
							let timing: AutomationTimedEvent["timing"] = cloneEditableValue(
								previous?.timing ?? { kind: "specific-time", time: "09:00" },
							);
							if (setupForm === "monthly") {
								const used = new Set(
									draft.schedule.events.map((event) => event.day),
								);
								const available = MONTHLY_EVENT_DAYS.find(
									(candidate) => !used.has(candidate),
								);
								if (available === undefined) return;
								day = available;
							} else if (setupForm === "weekly") {
								const used = new Set(
									draft.schedule.events.map((event) => event.day),
								);
								const available = Array.from(
									{ length: WEEKDAY_NAMES.length },
									(_, index) => index,
								).find((candidate) => !used.has(candidate));
								if (available === undefined) return;
								day = available;
							} else if (previous !== undefined) {
								if (previous.timing.kind === "case-property-time") {
									day = previous.day;
								} else {
									const [hours = 0, minutes = 0] = previous.timing.time
										.split(":")
										.map(Number);
									const nextMinute =
										previous.day * 1_440 +
										hours * 60 +
										minutes +
										(previous.timing.kind === "random-window"
											? Math.max(5, previous.timing.windowMinutes)
											: 5);
									day = Math.floor(nextMinute / 1_440);
									const minuteOfDay = nextMinute % 1_440;
									const time = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
									timing =
										previous.timing.kind === "random-window"
											? {
													...cloneEditableValue(previous.timing),
													time,
												}
											: { kind: "specific-time", time };
									if (day >= draft.schedule.repeatEvery) {
										draft.schedule.repeatEvery = day + 1;
									}
								}
							}
							draft.schedule.events.push({
								uuid: uuid(),
								day,
								timing,
								content: cloneEditableValue(
									first?.content ?? {
										kind: "sms",
										message: automationMessageText("Message"),
									},
								),
							});
							draft.schedule.events.sort((left, right) =>
								timedEventComparator(setupForm, left, right),
							);
						}
					})
				}
			>
				<Icon icon={tablerPlus} />
				Schedule event
			</Button>
		</Section>
	);
}

function EventEditor({
	event,
	automationCaseType,
	caseTypes,
	index,
	eventDays,
	scheduleKind,
	timedSetupForm,
	startDayOfWeek,
	repeatEvery,
	repeatIsDerived,
	forms,
	removeButtonRef,
	onRemove,
	onEdit,
}: {
	event: {
		uuid: Uuid;
		content: AutomationContent;
	} & ({ minutesToWait: number } | AutomationTimedEvent);
	automationCaseType: string;
	caseTypes: readonly CaseType[];
	index: number;
	eventDays: readonly { uuid: Uuid; day: number }[];
	scheduleKind: AutomationSchedule["kind"];
	timedSetupForm?: "custom-daily" | "weekly" | "monthly";
	startDayOfWeek?: number;
	repeatEvery?: number;
	repeatIsDerived: boolean;
	forms: readonly AutomationFormChoice[];
	removeButtonRef: Ref<HTMLButtonElement>;
	onRemove: () => void;
	onEdit: (recipe: (draft: WritableDraft<Automation>) => void) => void;
}) {
	const content = event.content;
	const timed = event as AutomationTimedEvent;
	const canonicalTime =
		scheduleKind === "timed" && timed.timing.kind !== "case-property-time"
			? timed.timing.time
			: "";
	const [timeText, setTimeText] = useState("");
	const [editingTime, setEditingTime] = useState(false);
	const dayOptions: readonly ChoiceOption[] =
		timedSetupForm === "monthly"
			? MONTHLY_EVENT_DAYS.map((day) => [
					String(day),
					monthlyDayLabel(day),
					eventDays.some(
						(sibling) => sibling.uuid !== event.uuid && sibling.day === day,
					),
				])
			: timedSetupForm === "weekly"
				? WEEKDAY_NAMES.map((_, day) => [
						String(day),
						WEEKDAY_NAMES[((startDayOfWeek ?? 0) + day) % 7] ??
							"Unknown weekday",
						eventDays.some(
							(sibling) => sibling.uuid !== event.uuid && sibling.day === day,
						),
					])
				: Array.from(
						{
							length: Math.max(
								(repeatEvery ?? 1) + (repeatIsDerived ? 1 : 0),
								timed.day + 1,
								1,
							),
						},
						(_, day) => [String(day), `Day ${day + 1}`] as const,
					);
	const updateContent = (
		recipe: (content: WritableDraft<AutomationContent>) => void,
	) =>
		onEdit((draft) => {
			if (draft.kind !== "conditional-alert") return;
			const item = draft.schedule.events[index];
			if (item === undefined) return;
			recipe(item.content);
			if (item.content.kind === "email") {
				for (const sibling of draft.schedule.events) {
					if (
						sibling !== item &&
						sibling.content.kind === "email" &&
						sibling.content.body.kind !== item.content.body.kind
					) {
						sibling.content.body =
							item.content.body.kind === "plain-text"
								? {
										kind: "plain-text",
										message: automationMessageText("Message"),
									}
								: {
										kind: "rich-text",
										html: automationMessageText("<p>Message</p>"),
									};
					}
				}
			}
			if ("submitPartiallyCompletedForms" in item.content) {
				for (const sibling of draft.schedule.events) {
					if (
						sibling.content.kind === item.content.kind &&
						"submitPartiallyCompletedForms" in sibling.content
					) {
						sibling.content.submitPartiallyCompletedForms =
							item.content.submitPartiallyCompletedForms;
						sibling.content.includeCaseUpdatesInPartialSubmissions =
							item.content.includeCaseUpdatesInPartialSubmissions;
					}
				}
			}
			if (
				draft.schedule.kind === "timed" &&
				timedSetupForm !== undefined &&
				timedSetupForm !== "custom-daily"
			) {
				for (const sibling of draft.schedule.events) {
					if (sibling !== item)
						sibling.content = cloneEditableValue(item.content);
				}
			}
		});
	const updateTiming = (
		recipe: (timing: WritableDraft<AutomationTimedEvent["timing"]>) => void,
	) =>
		onEdit((draft) => {
			if (draft.kind !== "conditional-alert" || draft.schedule.kind !== "timed")
				return;
			const item = draft.schedule.events[index];
			if (item === undefined) return;
			recipe(item.timing);
			if (timedSetupForm !== undefined && timedSetupForm !== "custom-daily") {
				for (const sibling of draft.schedule.events) {
					if (sibling !== item)
						sibling.timing = cloneEditableValue(item.timing);
				}
			}
		});

	return (
		<div className="rounded-lg border border-nova-border bg-black/10 p-3">
			<div className="grid gap-3 @md:grid-cols-2">
				{scheduleKind === "immediate" ? (
					<Labeled label="Minutes after previous event">
						<Input
							type="number"
							min={index === 0 ? 0 : 5}
							value={(event as { minutesToWait: number }).minutesToWait}
							onChange={(change) =>
								onEdit((draft) => {
									if (
										draft.kind === "conditional-alert" &&
										draft.schedule.kind === "immediate" &&
										draft.schedule.events[index]
									) {
										draft.schedule.events[index].minutesToWait = Number(
											change.target.value,
										);
									}
								})
							}
						/>
					</Labeled>
				) : (
					<>
						<Labeled label="Day in CommCare HQ schedule">
							<Choice
								value={String(timed.day)}
								options={dayOptions}
								onChange={(value) =>
									onEdit((draft) => {
										if (
											draft.kind === "conditional-alert" &&
											draft.schedule.kind === "timed" &&
											draft.schedule.events[index]
										) {
											const setupForm = automationTimedScheduleSetupForm(
												draft.schedule,
											);
											draft.schedule.events[index].day = Number(value);
											draft.schedule.events.sort((left, right) =>
												timedEventComparator(setupForm, left, right),
											);
											if (
												setupForm === "custom-daily" &&
												draft.schedule.totalIterations === 1
											) {
												draft.schedule.repeatEvery =
													Math.max(
														...draft.schedule.events.map((event) => event.day),
													) + 1;
											}
										}
									})
								}
							/>
						</Labeled>
						{timed.timing.kind === "case-property-time" ? (
							<Labeled
								label="Time property"
								hint="HQ reads only a custom case property in this field"
							>
								<Input
									value={timed.timing.property}
									onChange={(change) =>
										updateTiming((timing) => {
											if (timing.kind === "case-property-time") {
												timing.property = change.target.value;
											}
										})
									}
								/>
							</Labeled>
						) : (
							<Labeled label="Time">
								<TimeField
									value={
										editingTime ? timeText : automationTimeText(canonicalTime)
									}
									onFocus={() => {
										setTimeText(automationTimeText(canonicalTime));
										setEditingTime(true);
									}}
									onValueChange={(value) => {
										setTimeText(value);
										updateTiming((timing) => {
											if (timing.kind !== "case-property-time") {
												timing.time = value;
											}
										});
									}}
									onBlur={(value) => {
										const parsed = parseClockTime(value);
										if (parsed !== null) {
											updateTiming((timing) => {
												if (timing.kind !== "case-property-time") {
													timing.time = parsed.slice(0, 5);
												}
											});
										}
										setEditingTime(false);
									}}
								/>
							</Labeled>
						)}
						{timed.timing.kind === "random-window" && (
							<Labeled label="Window minutes">
								<Input
									type="number"
									min={1}
									max={1439}
									value={timed.timing.windowMinutes}
									onChange={(change) =>
										updateTiming((timing) => {
											if (timing.kind === "random-window") {
												timing.windowMinutes = Number(change.target.value);
											}
										})
									}
								/>
							</Labeled>
						)}
					</>
				)}
				{"message" in content && (
					<AutomationMessageTemplateEditor
						label="Message"
						template={content.message}
						automationCaseType={automationCaseType}
						caseTypes={caseTypes}
						onChange={(template) =>
							updateContent((item) => {
								if ("message" in item) item.message = template;
							})
						}
					/>
				)}
				{content.kind === "email" && (
					<>
						<AutomationMessageTemplateEditor
							label="Subject"
							template={content.subject}
							automationCaseType={automationCaseType}
							caseTypes={caseTypes}
							singleLine
							onChange={(template) =>
								updateContent((item) => {
									if (item.kind === "email") item.subject = template;
								})
							}
						/>
						<Labeled
							label="Email body form"
							hint={
								content.body.kind === "plain-text"
									? "Use only when Rich text emails is not enabled in the target HQ project"
									: "Requires Rich text emails in the target HQ project; HQ sanitizes this HTML and derives the plain-text alternative"
							}
						>
							<Choice
								value={content.body.kind}
								onChange={(kind) =>
									updateContent((item) => {
										if (item.kind !== "email") return;
										item.body =
											kind === "plain-text"
												? {
														kind,
														message: automationMessageText("Message"),
													}
												: {
														kind: "rich-text",
														html: automationMessageText("<p>Message</p>"),
													};
									})
								}
								options={[
									["plain-text", "Plain text"],
									["rich-text", "Rich text HTML"],
								]}
							/>
						</Labeled>
						{content.body.kind === "plain-text" ? (
							<AutomationMessageTemplateEditor
								label="Plain-text message"
								template={content.body.message}
								automationCaseType={automationCaseType}
								caseTypes={caseTypes}
								onChange={(template) =>
									updateContent((item) => {
										if (
											item.kind === "email" &&
											item.body.kind === "plain-text"
										) {
											item.body.message = template;
										}
									})
								}
							/>
						) : (
							<AutomationMessageTemplateEditor
								label="Rich-text HTML source"
								hint="HQ removes unsupported markup and CSS, rewraps the body, and derives plain text"
								template={content.body.html}
								automationCaseType={automationCaseType}
								caseTypes={caseTypes}
								onChange={(template) =>
									updateContent((item) => {
										if (
											item.kind === "email" &&
											item.body.kind === "rich-text"
										) {
											item.body.html = template;
										}
									})
								}
							/>
						)}
					</>
				)}
				{"formUuid" in content && (
					<Labeled label="Form">
						<Choice
							value={content.formUuid}
							onChange={(value) =>
								updateContent((item) => {
									if ("formUuid" in item) item.formUuid = asUuid(value);
								})
							}
							options={forms.map((form) => [form.uuid, form.label])}
						/>
					</Labeled>
				)}
				{"expirationHours" in content && (
					<Labeled label="Survey expiration in hours" hint="1–168 hours">
						<Input
							type="number"
							min={1}
							max={168}
							value={content.expirationHours}
							onChange={(change) =>
								updateContent((item) => {
									if ("expirationHours" in item) {
										item.expirationHours = Number(change.target.value);
									}
								})
							}
						/>
					</Labeled>
				)}
				{"reminderIntervalsMinutes" in content && (
					<Labeled
						label="Reminder intervals in minutes"
						hint={
							"expirationHours" in content
								? "Comma separated; their total must be shorter than the survey expiration"
								: "Comma separated; leave blank for none"
						}
					>
						<Input
							value={content.reminderIntervalsMinutes.join(", ")}
							onChange={(change) =>
								updateContent((item) => {
									if (!("reminderIntervalsMinutes" in item)) return;
									item.reminderIntervalsMinutes = change.target.value
										.split(",")
										.map(Number)
										.filter((value) => Number.isInteger(value) && value > 0);
								})
							}
						/>
					</Labeled>
				)}
				{"submitPartiallyCompletedForms" in content && (
					<>
						<Toggle
							checked={content.submitPartiallyCompletedForms}
							onChange={(checked) =>
								updateContent((item) => {
									if ("submitPartiallyCompletedForms" in item) {
										item.submitPartiallyCompletedForms = checked;
										if (!checked) {
											item.includeCaseUpdatesInPartialSubmissions = false;
										}
									}
								})
							}
							label="Submit partially completed forms"
						/>
						<Toggle
							checked={content.includeCaseUpdatesInPartialSubmissions}
							onChange={(checked) =>
								updateContent((item) => {
									if ("includeCaseUpdatesInPartialSubmissions" in item) {
										item.includeCaseUpdatesInPartialSubmissions = checked;
									}
								})
							}
							label="Include case updates in partial submissions"
							description="Available only when partial form submission is on"
							disabled={!content.submitPartiallyCompletedForms}
						/>
					</>
				)}
				{"maxQuestionAttempts" in content && (
					<Labeled label="Maximum attempts per question" hint="1–5 attempts">
						<Input
							type="number"
							min={1}
							max={5}
							value={content.maxQuestionAttempts}
							onChange={(change) =>
								updateContent((item) => {
									if ("maxQuestionAttempts" in item) {
										item.maxQuestionAttempts = Number(change.target.value);
									}
								})
							}
						/>
					</Labeled>
				)}
				{"registeredId" in content && (
					<Labeled
						label="Registered ID"
						hint="Choose the exact content handler registered in the target CommCare HQ project"
					>
						<Input
							value={content.registeredId}
							placeholder="Enter the registered content ID"
							onChange={(change) =>
								updateContent((item) => {
									if ("registeredId" in item) {
										item.registeredId = change.target.value;
									}
								})
							}
						/>
					</Labeled>
				)}
			</div>
			{(content.kind === "ivr" || content.kind === "sms-callback") && (
				<p
					role="status"
					className="mt-3 rounded-lg border border-nova-amber/40 bg-nova-amber/[0.06] px-3 py-2 text-[12px] text-nova-text-secondary"
				>
					Current CommCare HQ displays historical{" "}
					{content.kind === "ivr" ? "IVR" : "SMS callback"} configurations but
					refuses new activation. Keep this only when documenting an existing
					setup.
				</p>
			)}
			<RemoveButton
				label="Remove event"
				buttonRef={removeButtonRef}
				onClick={onRemove}
			/>
		</div>
	);
}
