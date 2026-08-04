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
	cloneElement,
	type ReactElement,
	type ReactNode,
	startTransition,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { Spinner } from "@/components/shadcn/spinner";
import { Textarea } from "@/components/shadcn/textarea";
import type { AutomationPreviewResult } from "@/lib/automations/actions";
import { previewAutomationAction } from "@/lib/automations/actions";
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
	type AutomationCriterion,
	type AutomationRecipient,
	type AutomationSchedule,
	type AutomationTimedEvent,
	asUuid,
	automationSchema,
	automationTimedScheduleSetupForm,
	type CaseType,
	type Form,
	type Uuid,
} from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import { useOrganization } from "@/lib/organization/useOrganization";
import { useAppId, useCanEdit } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { EntryRow, SubsectionEmpty } from "./subsection";

type SavedPreview = Extract<AutomationPreviewResult, { success: true }>["data"];

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
	["web-user", "Web user in CommCare HQ"],
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
		runOnSave: false,
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
					content: { kind: "sms", message: "Message" },
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
	forms: readonly Form[];
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
				? mutations.addAutomation(parsed.data)
				: mutations.replaceAutomation(parsed.data);
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
		const result = mutations.removeAutomation(state.automation.uuid);
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

					<ConditionsEditor
						automation={state.automation}
						locations={locations}
						onEdit={edit}
					/>
					<SetupOnlyEditor automation={state.automation} onEdit={edit} />
					<OptionalNumber
						label="Only cases last changed on the server at least this many days ago"
						value={state.automation.serverModifiedBoundaryDays}
						onChange={(value) =>
							edit((draft) => {
								if (value === undefined)
									delete draft.serverModifiedBoundaryDays;
								else draft.serverModifiedBoundaryDays = value;
							})
						}
					/>

					{state.automation.kind === "case-update" ? (
						<CaseUpdateEditor automation={state.automation} onEdit={edit} />
					) : (
						<AlertEditor
							automation={state.automation}
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
	children,
}: {
	label: string;
	hint?: string;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<label htmlFor={id} className="flex min-w-0 flex-col gap-1.5">
			<span className="text-[12px] font-medium text-nova-text-secondary">
				{label}
			</span>
			{cloneElement(
				children as ReactElement<{ id?: string; "aria-label"?: string }>,
				{ id, "aria-label": label },
			)}
			{hint && (
				<span className="text-[11px] leading-relaxed text-nova-text-muted">
					{hint}
				</span>
			)}
		</label>
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
			<SelectTrigger id={id} aria-label={ariaLabel} className="w-full">
				<SelectValue>
					{(selected) =>
						options.find(([optionValue]) => optionValue === selected)?.[1] ??
						selected
					}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{options.map(([id, label, optionDisabled]) => (
					<SelectItem key={id} value={id} disabled={optionDisabled}>
						{label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
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
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<Button type="button" variant="ghost-destructive" onClick={onClick}>
			<Icon icon={tablerTrash} aria-hidden="true" />
			{label}
		</Button>
	);
}

function ConditionsEditor({
	automation,
	locations,
	onEdit,
}: {
	automation: Automation;
	locations: readonly StoredLocation[];
	onEdit: (recipe: (draft: WritableDraft<Automation>) => void) => void;
}) {
	const add = (kind: AutomationCriterion["kind"]) => {
		if (kind === "location" && locations[0] === undefined) return;
		onEdit((draft) => {
			draft.criteria.push(
				kind === "match-property"
					? {
							uuid: uuid(),
							kind,
							property: "case_name",
							matchType: "has-value",
						}
					: kind === "closed-parent"
						? {
								uuid: uuid(),
								kind,
								identifier: "parent",
								relationship: "child",
							}
						: {
								uuid: uuid(),
								kind,
								locationUuid: asUuid(locations[0]?.id ?? ""),
								includeDescendants: false,
							},
			);
		});
	};
	return (
		<Section
			title="Conditions"
			description="The current-match count always excludes closed cases. Server-modified, UCR, and registered custom conditions are named separately because Nova can't count them locally."
		>
			{automation.criteria.map((criterion, index) => (
				<div
					key={criterion.uuid}
					className="rounded-lg border border-nova-border bg-black/10 p-3"
				>
					<div className="grid gap-3 @md:grid-cols-2">
						<Labeled label={`Condition ${index + 1}`}>
							<Choice
								value={criterion.kind}
								onChange={(kind) =>
									onEdit((draft) => {
										const current = draft.criteria[index];
										if (current === undefined) return;
										draft.criteria[index] =
											kind === "match-property"
												? {
														uuid: current.uuid,
														kind,
														property: "case_name",
														matchType: "has-value",
													}
												: kind === "closed-parent"
													? {
															uuid: current.uuid,
															kind,
															identifier: "parent",
															relationship: "child",
														}
													: {
															uuid: current.uuid,
															kind: "location",
															locationUuid: asUuid(locations[0]?.id ?? ""),
															includeDescendants: false,
														};
									})
								}
								options={[
									["match-property", "Case property"],
									["closed-parent", "Closed parent or host"],
									[
										"location",
										locations.length === 0
											? "Owner location (add a place first)"
											: "Owner location",
										locations.length === 0,
									],
								]}
							/>
						</Labeled>
						{criterion.kind === "match-property" && (
							<>
								<Labeled label="Property">
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
													item.value = "";
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
											["regex", "Matches regular expression"],
											["date-days-before", "Date comparison: before"],
											["date-days-lte", "Date comparison: at least"],
											["date-days-gt", "Date comparison: fewer than"],
											["date-days", "Date comparison: due or passed"],
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
									<Labeled label="Day offset">
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
							<>
								<Labeled label="Index name">
									<Input
										value={criterion.identifier}
										onChange={(event) =>
											onEdit((draft) => {
												const item = draft.criteria[index];
												if (item?.kind === "closed-parent")
													item.identifier = event.target.value;
											})
										}
									/>
								</Labeled>
								<Labeled label="Relationship">
									<Choice
										value={criterion.relationship}
										onChange={(value) =>
											onEdit((draft) => {
												const item = draft.criteria[index];
												if (item?.kind === "closed-parent")
													item.relationship = value as "child" | "extension";
											})
										}
										options={[
											["child", "Child"],
											["extension", "Extension"],
										]}
									/>
								</Labeled>
							</>
						)}
						{criterion.kind === "location" && (
							<>
								<Labeled label="Location">
									<Choice
										value={criterion.locationUuid}
										onChange={(value) =>
											onEdit((draft) => {
												const item = draft.criteria[index];
												if (item?.kind === "location")
													item.locationUuid = asUuid(value);
											})
										}
										options={locations.map((location) => [
											location.id,
											location.name,
										])}
									/>
								</Labeled>
								<Toggle
									checked={criterion.includeDescendants}
									onChange={(checked) =>
										onEdit((draft) => {
											const item = draft.criteria[index];
											if (item?.kind === "location")
												item.includeDescendants = checked;
										})
									}
									label="Include descendant locations"
								/>
							</>
						)}
					</div>
					<div className="mt-2">
						<RemoveButton
							label="Remove condition"
							onClick={() =>
								onEdit((draft) => {
									draft.criteria.splice(index, 1);
								})
							}
						/>
					</div>
				</div>
			))}
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					onClick={() => add("match-property")}
				>
					<Icon icon={tablerPlus} />
					Property condition
				</Button>
				<Button
					type="button"
					variant="outline"
					onClick={() => add("closed-parent")}
				>
					<Icon icon={tablerPlus} />
					Closed parent
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={locations.length === 0}
					onClick={() => add("location")}
				>
					<Icon icon={tablerPlus} />
					Location
				</Button>
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
						onChange={(event) =>
							onEdit((draft) => {
								const item = draft.setupOnlyCriteria[index];
								if (item) item.text = event.target.value;
							})
						}
					/>
					<RemoveButton
						label="Remove"
						onClick={() =>
							onEdit((draft) => {
								draft.setupOnlyCriteria.splice(index, 1);
							})
						}
					/>
				</div>
			))}
			<Button
				type="button"
				variant="outline"
				onClick={() =>
					onEdit((draft) => {
						draft.setupOnlyCriteria.push({
							uuid: uuid(),
							text: "Describe the exact CommCare HQ condition",
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
	return (
		<Section
			title="Case changes"
			description="A daily CommCare HQ sweep applies these changes. At least one property update or Close case is required."
		>
			<Toggle
				checked={automation.runOnSave}
				onChange={(checked) =>
					onEdit((draft) => {
						if (draft.kind === "case-update") draft.runOnSave = checked;
					})
				}
				label="Also run when a matching case is saved"
			/>
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
						<Labeled label="Property">
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
												? { kind, value: "" }
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
								<Labeled label="Source property">
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
						onClick={() =>
							onEdit((draft) => {
								if (draft.kind === "case-update")
									draft.updates.splice(index, 1);
							})
						}
					/>
				</div>
			))}
			<Button
				type="button"
				variant="outline"
				onClick={() =>
					onEdit((draft) => {
						if (draft.kind === "case-update")
							draft.updates.push({
								uuid: uuid(),
								target: { scope: "case", property: "case_name" },
								value: { kind: "literal", value: "" },
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
	if (kind === "location")
		return locations[0]
			? { uuid: id, kind, locationUuid: asUuid(locations[0].id) }
			: undefined;
	if (["mobile-worker", "web-user", "user-group", "case-group"].includes(kind))
		return {
			uuid: id,
			kind,
			hqId: "Enter the CommCare HQ ID",
		} as AutomationRecipient;
	return { uuid: id, kind: "custom", registeredId: "registered-id" };
}

function contentFor(
	kind: AutomationContent["kind"],
	forms: readonly Form[],
): AutomationContent | undefined {
	if (kind === "sms") return { kind, message: "Message" };
	if (kind === "email") return { kind, subject: "Subject", message: "Message" };
	if (kind === "connect-message") return { kind, message: "Message" };
	if (kind === "custom") return { kind, registeredId: "registered-id" };
	if (kind === "sms-callback")
		return { kind, message: "Message", reminderIntervalsMinutes: [5] };
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
	forms,
	locations,
	levels,
	userProperties,
	onEdit,
}: {
	automation: Extract<Automation, { kind: "conditional-alert" }>;
	forms: readonly Form[];
	locations: readonly StoredLocation[];
	levels: readonly { uuid: Uuid; name: string }[];
	userProperties: readonly { uuid: Uuid; label: string; slug: string }[];
	onEdit: (recipe: (draft: WritableDraft<Automation>) => void) => void;
}) {
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
										const replacement = recipientFor(
											kind as AutomationRecipient["kind"],
											locations,
										);
										if (replacement)
											onEdit((draft) => {
												if (draft.kind === "conditional-alert") {
													replacement.uuid = recipient.uuid;
													draft.recipients[index] =
														replacement as WritableDraft<AutomationRecipient>;
												}
											});
									}}
									options={RECIPIENT_KINDS.map(([kind, label]) => [
										kind,
										kind === "location" && locations.length === 0
											? "Location (add a place first)"
											: label,
										kind === "location" && locations.length === 0,
									])}
								/>
							</Labeled>
							{"property" in recipient && (
								<Labeled label="Case property">
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
								<Labeled label="Registered ID">
									<Input
										value={recipient.registeredId}
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
										])}
									/>
								</Labeled>
							)}
						</div>
						<RemoveButton
							label="Remove recipient"
							onClick={() =>
								onEdit((draft) => {
									if (draft.kind === "conditional-alert")
										draft.recipients.splice(index, 1);
								})
							}
						/>
					</div>
				))}
				<Button
					type="button"
					variant="outline"
					onClick={() =>
						onEdit((draft) => {
							if (draft.kind === "conditional-alert")
								draft.recipients.push({ uuid: uuid(), kind: "self" });
						})
					}
				>
					<Icon icon={tablerPlus} />
					Recipient
				</Button>
			</Section>
			<ScheduleEditor automation={automation} forms={forms} onEdit={onEdit} />
			<Section title="Recipient filters and schedule controls">
				<Toggle
					checked={automation.includeDescendantLocations}
					onChange={(checked) =>
						onEdit((draft) => {
							if (draft.kind === "conditional-alert")
								draft.includeDescendantLocations = checked;
						})
					}
					label="Include descendant locations for location recipients"
				/>
				<Labeled
					label="Default language code"
					hint="Leave blank to use CommCare HQ's default"
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
							onClick={() =>
								onEdit((draft) => {
									if (draft.kind === "conditional-alert")
										draft.userDataFilters.splice(index, 1);
								})
							}
						/>
					</div>
				))}
				<Button
					type="button"
					variant="outline"
					disabled={userProperties.length === 0}
					onClick={() =>
						onEdit((draft) => {
							if (draft.kind === "conditional-alert" && userProperties[0])
								draft.userDataFilters.push({
									uuid: uuid(),
									userPropertyUuid: userProperties[0].uuid,
									allowedValues: [""],
								});
						})
					}
				>
					<Icon icon={tablerPlus} />
					Recipient filter
				</Button>
				<Labeled label="Restart when this case property changes">
					<Input
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
				<Labeled label="Stop after the date in this case property">
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
	forms,
	onEdit,
}: {
	automation: Extract<Automation, { kind: "conditional-alert" }>;
	forms: readonly Form[];
	onEdit: (recipe: (draft: WritableDraft<Automation>) => void) => void;
}) {
	const schedule = automation.schedule;
	const timedSetupForm =
		schedule.kind === "timed"
			? automationTimedScheduleSetupForm(schedule)
			: undefined;
	const setSchedule = (kind: AutomationSchedule["kind"]) =>
		onEdit((draft) => {
			if (draft.kind !== "conditional-alert") return;
			const content = cloneEditableValue(
				draft.schedule.events[0]?.content ?? {
					kind: "sms",
					message: "Message",
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
					first?.content ?? { kind: "sms", message: "Message" },
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
						? (new Date(`${draft.schedule.start.date}T00:00:00Z`).getUTCDay() +
								6) %
							7
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
						return [
							kind,
							needsForm && forms.length === 0
								? `${label} (add a form first)`
								: label,
							needsForm && forms.length === 0,
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
											)
												draft.schedule.startDayOfWeek = Number(value);
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
									const date = new Date().toISOString().slice(0, 10);
									draft.schedule.start =
										kind === "rule-trigger"
											? { kind }
											: kind === "case-property"
												? { kind, property: "date_opened" }
												: {
														kind: "specific-date",
														date,
													};
									if (kind === "specific-date") {
										draft.schedule.startOffsetDays = 0;
										if (timedSetupForm === "weekly") {
											draft.schedule.startDayOfWeek =
												(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
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
						<Labeled label="Start date property">
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
							<Input
								type="date"
								value={schedule.start.date}
								onChange={(event) =>
									onEdit((draft) => {
										if (
											draft.kind === "conditional-alert" &&
											draft.schedule.kind === "timed" &&
											draft.schedule.start.kind === "specific-date"
										) {
											draft.schedule.start.date = event.target.value;
											if (timedSetupForm === "weekly") {
												draft.schedule.startDayOfWeek =
													(new Date(
														`${event.target.value}T00:00:00Z`,
													).getUTCDay() +
														6) %
													7;
											}
										}
									})
								}
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
					index={index}
					scheduleKind={schedule.kind}
					timedSetupForm={timedSetupForm}
					repeatEvery={
						schedule.kind === "timed" ? schedule.repeatEvery : undefined
					}
					forms={forms}
					onEdit={onEdit}
				/>
			))}
			<Button
				type="button"
				variant="outline"
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
										message: "Message",
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
								const allowed = [
									...Array.from({ length: 28 }, (_, index) => index + 1),
									-3,
									-2,
									-1,
								];
								const used = new Set(
									draft.schedule.events.map((event) => event.day),
								);
								day = allowed.find((candidate) => !used.has(candidate)) ?? 1;
							} else if (setupForm === "weekly") {
								const used = new Set(
									draft.schedule.events.map((event) => event.day),
								);
								day =
									Array.from({ length: 7 }, (_, index) => index).find(
										(candidate) => !used.has(candidate),
									) ?? 0;
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
									first?.content ?? { kind: "sms", message: "Message" },
								),
							});
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
	index,
	scheduleKind,
	timedSetupForm,
	repeatEvery,
	forms,
	onEdit,
}: {
	event: {
		uuid: Uuid;
		content: AutomationContent;
	} & ({ minutesToWait: number } | AutomationTimedEvent);
	index: number;
	scheduleKind: AutomationSchedule["kind"];
	timedSetupForm?: "custom-daily" | "weekly" | "monthly";
	repeatEvery?: number;
	forms: readonly Form[];
	onEdit: (recipe: (draft: WritableDraft<Automation>) => void) => void;
}) {
	const content = event.content;
	const timed = event as AutomationTimedEvent;
	const updateContent = (
		recipe: (content: WritableDraft<AutomationContent>) => void,
	) =>
		onEdit((draft) => {
			if (draft.kind !== "conditional-alert") return;
			const item = draft.schedule.events[index];
			if (item === undefined) return;
			recipe(item.content);
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
						<Labeled
							label="Day in CommCare HQ schedule"
							hint={
								timedSetupForm === "monthly"
									? "Use 1–28, or -3–-1 from month end"
									: "CommCare HQ numbers the first day as 1"
							}
						>
							<Input
								type="number"
								min={timedSetupForm === "monthly" ? -3 : 1}
								max={
									timedSetupForm === "monthly"
										? 28
										: timedSetupForm === "weekly"
											? 7
											: repeatEvery
								}
								value={timedSetupForm === "monthly" ? timed.day : timed.day + 1}
								onChange={(change) =>
									onEdit((draft) => {
										if (
											draft.kind === "conditional-alert" &&
											draft.schedule.kind === "timed" &&
											draft.schedule.events[index]
										) {
											draft.schedule.events[index].day =
												timedSetupForm === "monthly"
													? Number(change.target.value)
													: Number(change.target.value) - 1;
											if (
												timedSetupForm === "custom-daily" &&
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
							<Labeled label="Time property">
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
								<Input
									type="time"
									value={timed.timing.time}
									onChange={(change) =>
										updateTiming((timing) => {
											if (timing.kind !== "case-property-time") {
												timing.time = change.target.value;
											}
										})
									}
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
					<Labeled label="Message">
						<Textarea
							value={content.message}
							onChange={(change) =>
								updateContent((item) => {
									if ("message" in item) item.message = change.target.value;
								})
							}
						/>
					</Labeled>
				)}
				{content.kind === "email" && (
					<>
						<Labeled label="Subject">
							<Input
								value={content.subject}
								onChange={(change) =>
									updateContent((item) => {
										if (item.kind === "email")
											item.subject = change.target.value;
									})
								}
							/>
						</Labeled>
						<Labeled label="HTML message" hint="Optional">
							<Textarea
								value={content.htmlMessage ?? ""}
								onChange={(change) =>
									updateContent((item) => {
										if (item.kind !== "email") return;
										if (change.target.value === "") delete item.htmlMessage;
										else item.htmlMessage = change.target.value;
									})
								}
							/>
						</Labeled>
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
							options={forms.map((form) => [form.uuid, form.name])}
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
					<Labeled label="Registered ID">
						<Input
							value={content.registeredId}
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
				onClick={() =>
					onEdit((draft) => {
						if (draft.kind === "conditional-alert") {
							draft.schedule.events.splice(index, 1);
							if (
								draft.schedule.kind === "timed" &&
								automationTimedScheduleSetupForm(draft.schedule) ===
									"custom-daily" &&
								draft.schedule.totalIterations === 1 &&
								draft.schedule.events.length > 0
							) {
								draft.schedule.repeatEvery =
									(draft.schedule.events.at(-1)?.day ?? 0) + 1;
							}
						}
					})
				}
			/>
		</div>
	);
}
