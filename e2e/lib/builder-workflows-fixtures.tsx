import { type ReactNode, useRef, useState } from "react";
import {
	BuilderAccessGate,
	BuilderAccessStatus,
} from "@/components/builder/AccessStatus";
import { BuilderPageNavigation } from "@/components/builder/BuilderPageNavigation";
import {
	ContentFrame,
	ModeFlipGlideProvider,
} from "@/components/builder/ContentFrame";
import { CaseOperationDetailCanvas } from "@/components/builder/case-operations/CaseOperationDetailCanvas";
import { CaseOperationInspectorBody } from "@/components/builder/case-operations/CaseOperationInspectorBody";
import { CaseTargetDraftProvider } from "@/components/builder/case-operations/CaseTargetDraftContext";
import { CaseTargetPicker } from "@/components/builder/case-operations/CaseTargetPicker";
import { InlineField } from "@/components/builder/detail/formSettings/InlineField";
import { ModuleSettingsButton } from "@/components/builder/detail/moduleSettings/ModuleSettingsButton";
import { EditableTitle } from "@/components/builder/EditableTitle";
import {
	CARE,
	INTAKE,
	fixture as linksFixture,
	SOURCE,
	toVisit,
} from "@/components/builder/form-links/__tests__/fixture";
import { CarryValuesSection } from "@/components/builder/form-links/CarryValuesSection";
import { GenerationProgressCard } from "@/components/builder/GenerationProgress";
import { LocationChoiceSelect } from "@/components/builder/LocationChoiceSelect";
import { PresenceRosterView } from "@/components/builder/PresenceRosterView";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { PEER_PALETTE, type Peer } from "@/lib/collab/presence";
import { connectIdError } from "@/lib/commcare/connectSlugs";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseOperations } from "@/lib/doc/hooks/useCaseOperations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useFormLinks } from "@/lib/doc/hooks/useFormLinks";
import { useCanUndo } from "@/lib/doc/hooks/useUndoRedo";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	uuidSchema,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { StoredLocation } from "@/lib/organization/types";
import { useCanEdit } from "@/lib/session/hooks";
import {
	BuilderSessionProvider,
	useBuilderSessionApi,
} from "@/lib/session/provider";
import { GenerationStage } from "@/lib/session/types";

const OPERATIONS_SOURCE = buildDoc({
	appName: "Case target native",
	caseTypes: [{ name: "patient", properties: [] }],
	modules: [
		{
			uuid: "operations-module",
			name: "Clients",
			caseType: "patient",
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
			forms: [
				{
					uuid: "operations-form",
					name: "Follow up",
					type: "followup",
					fields: [{ kind: "text", id: "note", label: proseText("Note") }],
				},
				{
					name: "Register",
					type: "registration",
					fields: [
						{
							kind: "text",
							id: "name",
							label: proseText("Name"),
							caseWrite: { caseType: "patient", property: "case_name" },
						},
					],
				},
			],
		},
	],
});
function admitted(doc: BlueprintDoc) {
	const verdict = evaluateCommit({
		nextDoc: structuredClone(doc),
		lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
	});
	if (!verdict.ok) throw new Error(JSON.stringify(verdict));
	const persisted = toPersistableDoc(doc);
	blueprintDocSchema.parse(persisted);
	return persisted;
}
const MODULE_ID = OPERATIONS_SOURCE.moduleOrder[0];
const FORM_ID = OPERATIONS_SOURCE.formOrder[MODULE_ID][0];
const OPERATION_ID = uuidSchema.parse("00000000-0000-4000-8000-000000000390");
OPERATIONS_SOURCE.forms[FORM_ID].caseOperations = [
	{
		uuid: OPERATION_ID,
		id: "close_patient",
		action: "close",
		caseType: "patient",
		target: { kind: "session" },
	},
];
const OPERATIONS_DOC = admitted(OPERATIONS_SOURCE);

function CaseTargetContent() {
	const view = useCaseOperations(FORM_ID);
	const canUndo = useCanUndo();
	const operation = view.operations[0];
	if (!operation) throw new Error("Missing native operation state");
	if (!OPERATION_ID) throw new Error("Missing native operation");
	return (
		<>
			<div className="grid grid-cols-[minmax(0,1fr)_340px]">
				<section aria-label="Case change canvas">
					<CaseOperationDetailCanvas
						moduleUuid={MODULE_ID}
						formUuid={FORM_ID}
						operationUuid={OPERATION_ID}
					/>
				</section>
				<section aria-label="Case change settings">
					<CaseOperationInspectorBody
						moduleUuid={MODULE_ID}
						formUuid={FORM_ID}
						operationUuid={OPERATION_ID}
					/>
				</section>
			</div>
			<section aria-label="Target without a calculation editor">
				<CaseTargetPicker
					value={operation.target}
					ariaLabel="Unavailable calculation"
					context={{
						priorCreates: [],
						sessionUnavailableReason: undefined,
						newOnly: false,
						allowsNone: false,
					}}
					onChange={(target) => {
						if (target !== null) view.update({ ...operation, target });
					}}
				/>
			</section>
			<Button>Leave case change</Button>
			<output aria-label="Saved case changes">
				{JSON.stringify(view.operations)}
			</output>
			<output aria-label="Can undo case change">{String(canUndo)}</output>
		</>
	);
}
export function CaseTargetFixture() {
	return (
		<BlueprintDocProvider
			initialDoc={OPERATIONS_DOC}
			appId="native-case-target"
			canEdit
		>
			<BuilderSessionProvider init={{ canEdit: true }}>
				<CaseTargetDraftProvider>
					<CaseTargetContent />
				</CaseTargetDraftProvider>
			</BuilderSessionProvider>
		</BlueprintDocProvider>
	);
}

const CARRY_SINGLE_DOC = admitted(
	linksFixture([{ uuid: "native-carry", target: toVisit }]),
);
const collection = linksFixture([{ uuid: "native-carry", target: toVisit }]);
for (const moduleUuid of [INTAKE, CARE]) {
	const config = collection.modules[moduleUuid].caseListConfig;
	if (!config) throw new Error("Missing collection selection");
	config.selection = { kind: "multiple", maximum: 10 };
}
collection.forms[SOURCE].type = "followup";
const CARRY_COLLECTION_DOC = admitted(collection);
function CarryContent() {
	const view = useFormLinks(SOURCE);
	const link = view.links[0];
	if (!link) throw new Error("Missing carry link");
	return (
		<>
			<CarryValuesSection
				formUuid={SOURCE}
				link={link}
				view={view}
				canEdit
				onCommit={(next) => view.update(next, link)}
			/>
			<Button>Leave carried value</Button>
			<output aria-label="Saved carried link">{JSON.stringify(link)}</output>
		</>
	);
}
export function CarryFixture({ multiple }: { readonly multiple: boolean }) {
	return (
		<BlueprintDocProvider
			initialDoc={multiple ? CARRY_COLLECTION_DOC : CARRY_SINGLE_DOC}
			appId="native-carry"
			canEdit
		>
			<BuilderSessionProvider init={{ canEdit: true }}>
				<CarryContent />
			</BuilderSessionProvider>
		</BlueprintDocProvider>
	);
}

const SETTINGS_SOURCE = buildDoc({
	appName: "Module settings native",
	caseTypes: [
		{ name: "patient", properties: [] },
		{ name: "visit", properties: [] },
	],
	modules: [
		{
			uuid: "native-settings-bare",
			name: "Clients",
			caseType: "patient",
			caseListOnly: true,
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
			forms: [],
		},
		{
			uuid: "native-settings-parent",
			name: "Care",
			forms: [
				{
					name: "Survey",
					type: "survey",
					fields: [{ kind: "text", id: "note", label: proseText("Note") }],
				},
			],
		},
		{
			name: "Active care",
			caseType: "patient",
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
			forms: [
				{
					name: "Follow up",
					type: "followup",
					fields: [
						{
							kind: "text",
							id: "name",
							label: proseText("Name"),
							caseWrite: { caseType: "patient", property: "case_name" },
						},
					],
				},
			],
		},
	],
});
const SETTINGS_DOC = admitted(SETTINGS_SOURCE);
const BARE_MODULE_ID = SETTINGS_SOURCE.moduleOrder[0];
const PARENT_MODULE_ID = SETTINGS_SOURCE.moduleOrder[1];
const ACTIVE_MODULE_ID = SETTINGS_SOURCE.moduleOrder[2];
function ModuleSettingsContent() {
	const [selected, setSelected] = useState(BARE_MODULE_ID);
	const module = useModule(selected);
	const { inline } = useBlueprintMutations();
	const session = useBuilderSessionApi();
	return (
		<>
			<Button onClick={() => setSelected(BARE_MODULE_ID)}>
				Select bare module
			</Button>
			<Button onClick={() => setSelected(ACTIVE_MODULE_ID)}>
				Select active module
			</Button>
			<Button onClick={() => setSelected(PARENT_MODULE_ID)}>
				Select parent module
			</Button>
			<Button
				onClick={() =>
					session.getState().applyAccessSnapshot({
						projectId: "native-project",
						role: "viewer",
						canEdit: false,
					})
				}
			>
				View as reader
			</Button>
			<div style={{ width: 192 }}>
				<EditableTitle
					wrap
					ariaLabel="Module title"
					value={module?.name ?? ""}
					onSave={(name) => inline.updateModule(selected, { name })}
				/>
			</div>
			<ModuleSettingsButton key={selected} moduleUuid={selected} />
			<output aria-label="Saved module">{JSON.stringify(module)}</output>
		</>
	);
}
export function ModuleSettingsFixture() {
	return (
		<BuilderSessionProvider
			init={{
				appId: "native-module-settings",
				projectId: "native-project",
				role: "owner",
				canEdit: true,
			}}
		>
			<SessionDocument appId="native-module-settings">
				<ModuleSettingsContent />
			</SessionDocument>
		</BuilderSessionProvider>
	);
}

function AccessContent() {
	const session = useBuilderSessionApi();
	const module = useModule(BARE_MODULE_ID);
	const { inline } = useBlueprintMutations();
	const [floatingOpen, setFloatingOpen] = useState(false);
	return (
		<div data-nova-app-shell>
			<section aria-label="Access transition controls">
				<Button
					onPointerDown={(event) => event.preventDefault()}
					onClick={() => session.getState().beginAccessRefresh()}
				>
					Refresh access
				</Button>
				<Button
					onPointerDown={(event) => event.preventDefault()}
					onClick={() => session.getState().markAccessReconnecting()}
				>
					Reconnect access
				</Button>
				<Button
					onPointerDown={(event) => event.preventDefault()}
					onClick={() =>
						session.getState().applyAccessSnapshot({
							projectId: "native-project",
							role: "owner",
							canEdit: true,
						})
					}
				>
					Restore access
				</Button>
				<Button
					onPointerDown={(event) => event.preventDefault()}
					onClick={() => session.getState().revokeAccess()}
				>
					Revoke access
				</Button>
				<Button
					onPointerDown={(event) => event.preventDefault()}
					onClick={() => session.getState().requireClientUpgrade()}
				>
					Require upgrade
				</Button>
			</section>
			<Button
				onClick={() =>
					session.getState().applyAccessSnapshot({
						projectId: "native-project",
						role: "viewer",
						canEdit: false,
					})
				}
			>
				Viewer access
			</Button>
			<Button
				onClick={() =>
					session
						.getState()
						.applyAccessSnapshot(
							{ projectId: "native-project", role: "viewer", canEdit: false },
							{ hasWaitingChanges: true },
						)
				}
			>
				Viewer with changes
			</Button>
			<BuilderAccessStatus />
			<BuilderAccessGate>
				<InlineField
					label="Retained module name"
					value={module?.name ?? ""}
					onChange={(name) => inline.updateModule(BARE_MODULE_ID, { name })}
				/>
				<Popover
					open={floatingOpen}
					onOpenChange={(next) => {
						if (next) setFloatingOpen(true);
					}}
				>
					<PopoverTrigger render={<Button />}>
						Open controlled floating panel
					</PopoverTrigger>
					<PopoverContent>
						<PopoverTitle>Source Project panel</PopoverTitle>
						<Button>Source Project action</Button>
					</PopoverContent>
				</Popover>
			</BuilderAccessGate>
			<output aria-label="Saved access module">{module?.name}</output>
		</div>
	);
}
export function AccessFixture() {
	return (
		<BuilderSessionProvider
			init={{
				appId: "native-access",
				projectId: "native-project",
				role: "owner",
				canEdit: true,
			}}
		>
			<SessionDocument appId="native-access">
				<AccessContent />
			</SessionDocument>
		</BuilderSessionProvider>
	);
}

function SessionDocument({
	appId,
	children,
}: {
	appId: string;
	children: ReactNode;
}) {
	const canEdit = useCanEdit();
	return (
		<BlueprintDocProvider
			initialDoc={SETTINGS_DOC}
			appId={appId}
			canEdit={canEdit}
		>
			{children}
		</BlueprintDocProvider>
	);
}

export function FrameFixture() {
	const [previewing, setPreviewing] = useState(false);
	const rowRef = useRef<HTMLDivElement>(null);
	const left = previewing ? 0 : 300;
	const right = previewing ? 0 : 360;
	return (
		<>
			<Button
				onClick={() => setPreviewing((value) => !value)}
				aria-pressed={previewing}
			>
				Toggle frame preview
			</Button>
			<div ref={rowRef} style={{ width: 1200 }}>
				<ModeFlipGlideProvider
					previewing={previewing}
					leftWidth={left}
					rightWidth={right}
					rowRef={rowRef}
				>
					<div style={{ display: "flex" }}>
						<div style={{ width: left, flexShrink: 0 }} />
						<div style={{ flex: 1, minWidth: 0 }}>
							<ContentFrame width="3xl">
								<div data-frame-marker="wide">Wide frame</div>
							</ContentFrame>
							<ContentFrame width="md">
								<div data-frame-marker="small">Small frame</div>
							</ContentFrame>
						</div>
						<div style={{ width: right, flexShrink: 0 }} />
					</div>
				</ModeFlipGlideProvider>
			</div>
		</>
	);
}

export function ChromeFixture() {
	const [compact, setCompact] = useState(false);
	const [destination, setDestination] = useState("");
	const peers: Peer[] = ["Ada", "Grace", "Linus", "Margaret", "Katherine"].map(
		(name, index) => ({
			userId: `user-${name}`,
			sessionId: `session-${name}`,
			name,
			image: index === 0 ? "/native-image.svg" : null,
			email: `${name.toLowerCase()}@example.test`,
			color: PEER_PALETTE[index % PEER_PALETTE.length].id,
			location: { kind: "home" },
			updatedAt: 0,
			peerColor: PEER_PALETTE[index % PEER_PALETTE.length],
		}),
	);
	return (
		<>
			<Button onClick={() => setCompact((value) => !value)}>
				Toggle compact chrome
			</Button>
			<div style={{ width: "100%", maxWidth: 1800 }}>
				<BuilderPageNavigation
					hasData
					canGoBack
					onBack={() => setDestination("back")}
					compactWorkspaceBreadcrumb={compact}
					parts={[
						{
							key: "home",
							label: "Home",
							onClick: () => setDestination("home"),
						},
						{
							key: "module",
							label: "Community nutrition and longitudinal care",
							onClick: () => setDestination("module"),
						},
						{
							key: "screen",
							label:
								"Follow-up visits that need a complete authored name in every workspace",
							onClick: () => setDestination("leaf"),
						},
					]}
				/>
			</div>
			<PresenceRosterView
				compact={compact}
				peers={peers}
				onFollow={(person) => setDestination(person.userId)}
			/>
			<output aria-label="Chrome destination">{destination}</output>
		</>
	);
}

const PLACE_CHOICES: StoredLocation[] = Array.from(
	{ length: 120 },
	(_, index) => ({
		id: uuidSchema.parse(
			`00000000-0000-7000-8000-${String(index + 6200).padStart(12, "0")}`,
		),
		levelUuid: uuidSchema.parse("00000000-0000-7000-8000-000000006000"),
		parentId: null,
		siteCode: `place-${index + 1}`,
		name: `Place ${index + 1}`,
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
		archivedAt: null,
		orderKey: String(index),
	}),
);
export function PlacesFixture() {
	const [value, setValue] = useState("");
	return (
		<div style={{ maxWidth: 360 }}>
			<LocationChoiceSelect
				locations={PLACE_CHOICES}
				value={value}
				onValueChange={setValue}
				ariaLabel="Choose a place"
				placeholder="Choose a place"
				issueFor={(location) =>
					location.siteCode === "place-119"
						? "This place is outside the permitted address book."
						: undefined
				}
			/>
			<output aria-label="Chosen place">{value}</output>
		</div>
	);
}

export function ProgressFixture() {
	const [stage, setStage] = useState<GenerationStage | null>(
		GenerationStage.Foundation,
	);
	const [error, setError] = useState(false);
	return (
		<>
			<Button onClick={() => setStage(GenerationStage.Build)}>
				Begin build
			</Button>
			<Button
				onClick={() => {
					setStage(null);
					setError(true);
				}}
			>
				Fail current stage
			</Button>
			<Button
				onClick={() => {
					setStage(GenerationStage.Fix);
					setError(false);
				}}
			>
				Recover in Fix
			</Button>
			<GenerationProgressCard
				stage={stage}
				generationError={
					error
						? { message: "Build could not finish", severity: "failed" }
						: null
				}
				statusMessage={error ? "Build could not finish" : ""}
			/>
		</>
	);
}

export function InlineValidationFixture() {
	const [value, setValue] = useState("starting_code");
	return (
		<>
			<InlineField
				label="Connect code"
				value={value}
				onChange={(next) => {
					setValue(next);
					return undefined;
				}}
				validate={connectIdError}
			/>
			<Button>Next field</Button>
			<output aria-label="Saved Connect code">{value}</output>
		</>
	);
}
