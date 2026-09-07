import { StrictMode, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ValueField } from "@/components/builder/app-setup/ValueField";
import { WorkerInformationSubsection } from "@/components/builder/app-setup/WorkerInformationSubsection";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { FieldEditorPanel } from "@/components/builder/editor/FieldEditorPanel";
import { FieldEditorSection } from "@/components/builder/editor/FieldEditorSection";
import { CaseWriteEditor } from "@/components/builder/editor/fields/CaseWriteEditor";
import { OptionsEditor } from "@/components/builder/editor/fields/OptionsEditor";
import { OptionsSourceEditor } from "@/components/builder/editor/fields/OptionsSourceEditor";
import { RequiredEditor } from "@/components/builder/editor/fields/RequiredEditor";
import { TextEditor } from "@/components/builder/editor/fields/TextEditor";
import { XPathEditor } from "@/components/builder/editor/fields/XPathEditor";
import { requiredEntry } from "@/components/builder/editor/requiredEntry";
import { OptionalMarkdownRow } from "@/components/builder/inspector/OptionalMarkdownRow";
import { BuilderLookupCatalogContext } from "@/components/builder/lookup/catalogContext";
import { CaseTypePicker } from "@/components/builder/shared/CaseTypePicker";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import {
	buildValidityIndex,
	PredicateEditProvider,
} from "@/components/builder/shared/editorContext";
import { buildEditorTypeContext } from "@/components/builder/shared/editorTypeContext";
import { PredicateCardEditor } from "@/components/builder/shared/PredicateCardEditor";
import { PredicateSlotCard } from "@/components/builder/shared/PredicateSlotCard";
import { PredicateWorkbench } from "@/components/builder/shared/PredicateWorkbench";
import { CustomDatePatternInput } from "@/components/builder/shared/primitives/CustomDatePatternInput";
import { LiteralValueInput } from "@/components/builder/shared/primitives/LiteralValueInput";
import { PropertyPicker } from "@/components/builder/shared/primitives/PropertyPicker";
import { RelationPathBuilder } from "@/components/builder/shared/primitives/RelationPathBuilder";
import { SlotCardHeader } from "@/components/builder/shared/SlotCardHeader";
import { reorderByKeyboard } from "@/components/builder/shared/useReorderableList";
import { useStableListIdentity } from "@/components/builder/shared/useStableListIdentity";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/shadcn/alert-dialog";
import { Button } from "@/components/shadcn/button";
import { Calendar } from "@/components/shadcn/calendar";
import {
	Combobox,
	ComboboxContent,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@/components/shadcn/combobox";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/shadcn/dialog";
import {
	InputGroup,
	InputGroupButton,
	InputGroupInput,
	InputGroupTextarea,
} from "@/components/shadcn/input-group";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { PortaledContentDirectionProvider } from "@/components/shadcn/portaled-content-direction";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useField } from "@/lib/doc/hooks/useEntity";
import { useCanUndo } from "@/lib/doc/hooks/useUndoRedo";
import {
	usePersonas,
	useUserProperties,
	useUserTypes,
} from "@/lib/doc/hooks/useUserCollections";
import { LookupCommitContext } from "@/lib/doc/lookupCommitContext";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { CaseType } from "@/lib/domain";
import {
	blueprintDocSchema,
	type UserProperty,
	uuidSchema,
} from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import type { Literal } from "@/lib/domain/predicate";
import {
	ancestorPath,
	and,
	arith,
	checkPredicate,
	checkValueExpression,
	coalesce,
	comparisonObjectConstraint,
	concat,
	count,
	dateLiteral,
	eq,
	exists,
	gt,
	ifExpr,
	isBlank,
	isIn,
	literal,
	lt,
	match,
	matchAll,
	matchesPattern,
	multiSelectAny,
	not,
	or,
	type Predicate,
	predicateSchema,
	prop,
	type RelationPath,
	relationStep,
	selfPath,
	sessionUserProperty,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	type ValueExpression,
	valueExpressionSchema,
	within,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import { runHistoryStep } from "@/lib/routing/historyStep";
import { BuilderSessionProvider } from "@/lib/session/provider";
import {
	AccessFixture,
	CarryFixture,
	CaseTargetFixture,
	ChromeFixture,
	FrameFixture,
	InlineValidationFixture,
	ModuleSettingsFixture,
	PlacesFixture,
	ProgressFixture,
} from "./builder-workflows-fixtures";

const LONG_NAME =
	"ThisIsAnAuthoredNameWithNoNaturalBreakThatMustNeverForceTheDialogOutsideTheViewport";
function Calendars() {
	const [selected, setSelected] = useState<Date>();
	return (
		<>
			<output aria-label="Selected date">
				{selected?.toLocaleDateString("en-CA") ?? "None"}
			</output>
			<section aria-label="Plain calendar">
				<Calendar
					mode="single"
					defaultMonth={new Date(2025, 0, 1)}
					selected={selected}
					onSelect={setSelected}
				/>
			</section>
			<section aria-label="Week calendar">
				<Calendar
					mode="single"
					defaultMonth={new Date(2025, 0, 1)}
					showWeekNumber
					captionLayout="dropdown"
				/>
			</section>
		</>
	);
}
function Dialogs() {
	const [chosen, setChosen] = useState("none");
	return (
		<PortaledContentDirectionProvider direction="rtl">
			<Dialog>
				<DialogTrigger render={<Button />}>Open dialog</DialogTrigger>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{LONG_NAME}</DialogTitle>
						<DialogDescription>{LONG_NAME}</DialogDescription>
					</DialogHeader>
					<Popover>
						<PopoverTrigger render={<Button />}>
							Open nested popover
						</PopoverTrigger>
						<PopoverContent aria-label="Nested popover">
							<Button onClick={() => setChosen("popover")}>
								Choose nested action
							</Button>
						</PopoverContent>
					</Popover>
					<output aria-label="Nested selection">{chosen}</output>
					<Select
						value={chosen}
						onValueChange={(value) => {
							if (value) setChosen(value);
						}}
						items={{ none: "Choose a nested value", selected: "Nested value" }}
					>
						<SelectTrigger aria-label="Nested choice">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="selected">Nested value</SelectItem>
						</SelectContent>
					</Select>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							Cancel
						</DialogClose>
						<Button>Use connection</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<AlertDialog>
				<AlertDialogTrigger render={<Button />}>
					Open confirmation
				</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogTitle>{LONG_NAME}</AlertDialogTitle>
					<AlertDialogDescription>{LONG_NAME}</AlertDialogDescription>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction>Delete</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</PortaledContentDirectionProvider>
	);
}
function Choices() {
	const [value, setValue] = useState("needs-review");
	const items = { "needs-review": "Needs review", long: LONG_NAME };
	return (
		<>
			{[false, true].map((wrap) => (
				<Select
					key={String(wrap)}
					value={value}
					onValueChange={(v) => {
						if (v) setValue(v);
					}}
					items={items}
				>
					<SelectTrigger
						style={{ width: 200 }}
						aria-label={wrap ? "Wrapping status" : "Compact status"}
						wrapValue={wrap}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{Object.entries(items).map(([id, label]) => (
							<SelectItem key={id} value={id} wrap>
								{label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			))}
			<Combobox items={["Available", "Unavailable"]}>
				<ComboboxInput aria-label="Choose information" />
				<ComboboxContent>
					<ComboboxList>
						{(item: string) => (
							<ComboboxItem
								key={item}
								value={item}
								disabled={item === "Unavailable"}
							>
								{item}
							</ComboboxItem>
						)}
					</ComboboxList>
				</ComboboxContent>
			</Combobox>
			<InputGroup data-testid="text-group">
				<InputGroupInput aria-label="Name" />
				<InputGroupButton disabled>Send</InputGroupButton>
			</InputGroup>
			<InputGroup data-testid="message-group">
				<InputGroupTextarea aria-label="Message" />
			</InputGroup>
		</>
	);
}
function LocalRow({
	index,
	value,
	move,
}: {
	index: number;
	value: string;
	move: () => void;
}) {
	const [draft, setDraft] = useState(value);
	return (
		<li>
			<input
				aria-label={`Row ${index + 1}`}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
			/>
			<Button onClick={move}>Move row {index + 1} to start</Button>
		</li>
	);
}
function StableRows() {
	const [items, setItems] = useState([
		{ value: "same" },
		{ value: "same" },
		{ value: "other" },
	]);
	const identity = useStableListIdentity(items);
	return (
		<>
			<Button onClick={() => setItems(structuredClone(items))}>
				Clone document
			</Button>
			<Button
				onClick={() => {
					identity.stage([items[1], items[0], items[2]], {
						kind: "move",
						fromIndex: 1,
						toIndex: 0,
					});
					setItems(items);
				}}
			>
				Reject duplicate move
			</Button>
			<ul>
				{items.map((item, index) => (
					<LocalRow
						key={identity.keys[index]}
						index={index}
						value={item.value}
						move={() => {
							const change = reorderByKeyboard(items, index, "Home");
							if (change) {
								identity.stage(change.items, {
									kind: "move",
									fromIndex: index,
									toIndex: 0,
								});
								setItems(structuredClone([...change.items]));
							}
						}}
					/>
				))}
			</ul>
		</>
	);
}
const EDITOR_CASE_TYPES: readonly CaseType[] = [
	{
		name: "household",
		properties: [
			{ name: "region", label: proseText("Region"), data_type: "text" },
		],
	},
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "case_name", label: proseText("Case name"), data_type: "text" },
			{ name: "age", label: proseText("Age"), data_type: "int" },
		],
	},
	{ name: "visit", parent_type: "patient", properties: [] },
];
const EDITOR_TYPE_CONTEXT = buildEditorTypeContext({
	caseTypes: EDITOR_CASE_TYPES,
	currentCaseType: "patient",
	knownInputs: [],
});
function ExpressionFixture() {
	const [value, setValue] = useState<ValueExpression>(() =>
		valueExpressionSchema.parse(term(literal("42"))),
	);
	const [commits, setCommits] = useState(0);
	return (
		<BlueprintDocProvider appId="native-editor">
			<ExpressionCardEditor
				value={value}
				caseTypes={EDITOR_CASE_TYPES}
				currentCaseType="patient"
				onChange={(next) => {
					if (!checkValueExpression(next, EDITOR_TYPE_CONTEXT).ok)
						throw new Error("Expression edit must type-check");
					setValue(next);
					setCommits((n) => n + 1);
				}}
			/>
			<output aria-label="Authored value">{JSON.stringify(value)}</output>
			<output aria-label="Commit count">{commits}</output>
		</BlueprintDocProvider>
	);
}
function PredicateFixture({ mode }: { mode: string }) {
	const [value, setValue] = useState<Predicate>(() =>
		predicateSchema.parse(
			mode === "pattern"
				? matchesPattern(prop("patient", "case_name"), "^A[0-9]+$")
				: mode === "membership"
					? isIn(prop("patient", "age"), literal(1), literal(2), literal(3))
					: isBlank(prop("patient", "case_name", selfPath())),
		),
	);
	const [commits, setCommits] = useState(0);
	return (
		<BlueprintDocProvider appId="native-editor">
			<PredicateCardEditor
				value={value}
				caseTypes={EDITOR_CASE_TYPES}
				currentCaseType="patient"
				onChange={(next) => {
					if (!checkPredicate(next, EDITOR_TYPE_CONTEXT).ok)
						throw new Error("Predicate edit must type-check");
					setValue(next);
					setCommits((n) => n + 1);
				}}
			/>
			<output aria-label="Authored condition">{JSON.stringify(value)}</output>
			<output aria-label="Commit count">{commits}</output>
		</BlueprintDocProvider>
	);
}
function RelationFixture({ custom }: { custom: boolean }) {
	const [value, setValue] = useState<RelationPath>(() =>
		custom
			? subcasePath("host", "household")
			: ancestorPath(
					relationStep("parent", "patient"),
					relationStep("parent", "household"),
				),
	);
	const [commits, setCommits] = useState(0);
	return (
		<BlueprintDocProvider appId="native-editor">
			<PredicateEditProvider
				caseTypes={EDITOR_CASE_TYPES}
				currentCaseType="visit"
				knownInputs={[]}
				validityIndex={buildValidityIndex([])}
			>
				<RelationPathBuilder
					value={value}
					onChange={(next) => {
						setValue(next);
						setCommits((n) => n + 1);
					}}
				/>
			</PredicateEditProvider>
			<output aria-label="Authored connection">{JSON.stringify(value)}</output>
			<output aria-label="Commit count">{commits}</output>
		</BlueprintDocProvider>
	);
}

function LiteralFixture() {
	const [value, setValue] = useState<Literal>({
		...literal(7),
		data_type: "int",
	});
	const [date, setDate] = useState<Literal>(dateLiteral("2025-01-02"));
	return (
		<BlueprintDocProvider appId="native-editor">
			<PredicateEditProvider
				caseTypes={EDITOR_CASE_TYPES}
				currentCaseType="patient"
				knownInputs={[]}
				validityIndex={buildValidityIndex([])}
			>
				<LiteralValueInput
					value={value}
					onChange={setValue}
					caseTypeName="patient"
					propertyName="age"
					ariaLabel="Whole number"
				/>
				<LiteralValueInput
					value={date}
					onChange={setDate}
					caseTypeName="patient"
					propertyName={undefined}
					overrideDataType="date"
					accepts={new Set(["date"])}
					ariaLabel="Visit date"
				/>
				<Button>Leave inputs</Button>
				<output aria-label="Authored number">{JSON.stringify(value)}</output>
				<output aria-label="Authored date">{JSON.stringify(date)}</output>
			</PredicateEditProvider>
		</BlueprintDocProvider>
	);
}
function DatePatternFixture() {
	const [value, setValue] = useState("Visit %Y");
	return (
		<>
			<CustomDatePatternInput
				value={value}
				onChange={setValue}
				presets={[{ id: "short", label: "Short date", pattern: "short" }]}
			/>
			<Button>Leave date style</Button>
			<output aria-label="Authored date style">{value}</output>
		</>
	);
}
const PICKER_DOC = toPersistableDoc(
	buildDoc({
		caseTypes: [
			{ name: "client_record", properties: [] },
			{ name: "household", properties: [] },
		],
	}),
);
blueprintDocSchema.parse(PICKER_DOC);
function CaseTypeFixture() {
	const [value, setValue] = useState<string | undefined>("client_record");
	return (
		<BlueprintDocProvider initialDoc={PICKER_DOC}>
			<CaseTypePicker
				value={value}
				onChange={setValue}
				onClear={() => setValue(undefined)}
			/>
			<output aria-label="Chosen case type">{value ?? "None"}</output>
		</BlueprintDocProvider>
	);
}

function ListExpressionFixture({ kind }: { kind: string }) {
	const [value, setValue] = useState<ValueExpression>(() => {
		const parts = [
			term(literal("first")),
			term(literal("second")),
			term(literal("third")),
		] as const;
		return kind === "concat"
			? concat(...parts)
			: kind === "coalesce"
				? coalesce(...parts)
				: switchExpr(
						term(prop("patient", "age")),
						[
							switchCase(literal(1), term(literal(10))),
							switchCase(literal(2), term(literal(20))),
							switchCase(literal(3), term(literal(30))),
						],
						term(literal(0)),
					);
	});
	return (
		<BlueprintDocProvider appId="native-editor">
			<Button onClick={() => setValue(structuredClone(value))}>
				Clone expression
			</Button>
			<ExpressionCardEditor
				value={value}
				caseTypes={EDITOR_CASE_TYPES}
				currentCaseType="patient"
				onChange={(next) => {
					valueExpressionSchema.parse(next);
					if (!checkValueExpression(next, EDITOR_TYPE_CONTEXT).ok)
						throw new Error("List edits must type-check");
					setValue(structuredClone(next));
				}}
			/>
			<output aria-label="Authored list">{JSON.stringify(value)}</output>
		</BlueprintDocProvider>
	);
}
function OptionalConditionFixture() {
	// Deliberately invalid historical AST at the lower-level editor boundary.
	const [value, setValue] = useState<Predicate | undefined>(
		gt(prop("patient", "age"), literal("wrong type")),
	);
	const [valid, setValid] = useState<boolean | undefined>();
	return (
		<BlueprintDocProvider appId="native-editor">
			<PredicateSlotCard
				title="Filter"
				description="Cases available here"
				addLabel="Add filter"
				clearLabel="Clear"
				clearAriaLabel="Clear filter"
				value={value}
				onChange={setValue}
				caseTypes={EDITOR_CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={setValid}
			/>
			<output aria-label="Condition validity">{String(valid)}</output>
			<output aria-label="Optional condition">
				{JSON.stringify(value) ?? "None"}
			</output>
		</BlueprintDocProvider>
	);
}

function DiagnosticFixture({ kind }: { kind: string }) {
	const [value, setValue] = useState<ValueExpression>(() =>
		kind === "arith-error"
			? arith("+", term(literal("bad number")), term(literal(1)))
			: ifExpr(matchAll(), term(literal(1)), term(literal("text"))),
	);
	const [valid, setValid] = useState<boolean | undefined>();
	return (
		<BlueprintDocProvider appId="native-editor">
			<ExpressionCardEditor
				value={value}
				onChange={setValue}
				caseTypes={EDITOR_CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={setValid}
			/>
			<Button onClick={() => setValue(term(literal(1)))}>
				Load corrected value
			</Button>
			<output aria-label="Expression validity">{String(valid)}</output>
		</BlueprintDocProvider>
	);
}
const LONG_INFORMATION =
	"Preferred follow up location from the most recent household assessment";
const PICKER_CASES: readonly CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "home_phone", label: proseText("Telephone"), data_type: "text" },
			{
				name: "patient_dob",
				label: proseText("Date of birth"),
				data_type: "date",
			},
			{
				name: "preferred_follow_up_location",
				label: proseText(LONG_INFORMATION),
				data_type: "text",
			},
		],
	},
];
function PropertyPickerFixture() {
	const [value, setValue] = useState("preferred_follow_up_location");
	const [created, setCreated] = useState(0);
	return (
		<BlueprintDocProvider appId="native-editor">
			<PredicateEditProvider
				caseTypes={PICKER_CASES}
				currentCaseType="patient"
				knownInputs={[]}
				validityIndex={buildValidityIndex([])}
			>
				<PropertyPicker
					value={value}
					onChange={setValue}
					onCreateNew={() => setCreated((n) => n + 1)}
					createNewLabel="Create a new question"
				/>
				<Button onClick={() => setValue("retired_property")}>
					Load missing information
				</Button>
				<output aria-label="Selected information">{value}</output>
				<output aria-label="Create requests">{created}</output>
			</PredicateEditProvider>
		</BlueprintDocProvider>
	);
}

const OPTIONS_FIELD_ID = uuidSchema.parse(
	"00000000-0000-7000-8000-000000000301",
);
const OPTIONS_REFERENCE_ID = uuidSchema.parse(
	"00000000-0000-7000-8000-000000000302",
);
const OPTIONS_DOC = toPersistableDoc(
	buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [
							{
								kind: "text",
								id: "name",
								uuid: OPTIONS_REFERENCE_ID,
								label: proseText("Name"),
							},
							{
								kind: "single_select",
								id: "color",
								uuid: OPTIONS_FIELD_ID,
								label: proseText("Color"),
								optionsSource: {
									kind: "inline",
									options: [
										{
											uuid: uuidSchema.parse(
												"00000000-0000-7000-8000-000000000303",
											),
											value: "red",
											label: proseText("Red"),
										},
										{
											uuid: uuidSchema.parse(
												"00000000-0000-7000-8000-000000000304",
											),
											value: "blue",
											label: proseText("Blue"),
										},
									],
								},
							},
						],
					},
				],
			},
		],
	}),
);
blueprintDocSchema.parse(OPTIONS_DOC);
const SOURCE_TABLE: LookupTableDefinition = {
	id: lookupTableIdSchema.parse("00000000-0000-7000-8000-000000000311"),
	name: "Regions",
	tag: "regions",
	definitionRevision: parseLookupRevision("1"),
	columns: [
		{
			id: lookupColumnIdSchema.parse("00000000-0000-7000-8000-000000000312"),
			wireName: "code",
			label: "Region code",
			dataType: "text",
		},
		{
			id: lookupColumnIdSchema.parse("00000000-0000-7000-8000-000000000313"),
			wireName: "name",
			label: "Region name",
			dataType: "text",
		},
	],
};
function OptionsSourceFixtureContent() {
	const field = useField(OPTIONS_FIELD_ID);
	const mutations = useBlueprintMutations();
	if (field?.kind !== "single_select") throw new Error("Missing select field");
	return (
		<>
			<OptionsSourceEditor
				field={field}
				value={field.optionsSource}
				label="Choices"
				keyName="optionsSource"
				onChange={(next) =>
					mutations.inline.updateField(field.uuid, "single_select", {
						optionsSource: next,
					})
				}
			/>
			<output aria-label="Saved source">
				{JSON.stringify(field.optionsSource)}
			</output>
		</>
	);
}
function OptionsSourceFixture() {
	const [missing, setMissing] = useState(false);
	const definitions = missing ? [] : [SOURCE_TABLE];
	const lookupContext = {
		kind: "available" as const,
		projectId: "native-project",
		projectRevision: parseLookupRevision(missing ? "2" : "1"),
		definitions,
	};
	const catalog = {
		kind: "ready" as const,
		definitions,
		tables: definitions,
		byId: new Map(definitions.map((table) => [table.id, table])),
		lookupContext,
		retry: async () => {},
	};
	return (
		<BlueprintDocProvider initialDoc={OPTIONS_DOC} appId="native-options">
			<BuilderSessionProvider
				init={{ canEdit: true, projectId: "native-project" }}
			>
				<LookupCommitContext value={{ kind: "ready", lookupContext }}>
					<BuilderLookupCatalogContext value={catalog}>
						<OptionsSourceFixtureContent />
						<Button onClick={() => setMissing(!missing)}>
							{missing ? "Restore table definition" : "Remove table definition"}
						</Button>
					</BuilderLookupCatalogContext>
				</LookupCommitContext>
			</BuilderSessionProvider>
		</BlueprintDocProvider>
	);
}
const SETUP_REGION_ID = uuidSchema.parse(
	"00000000-0000-7000-8000-000000000343",
);
const SETUP_CADRE_ID = uuidSchema.parse("00000000-0000-7000-8000-000000000344");
const SETUP_PERSONA_ID = uuidSchema.parse(
	"00000000-0000-7000-8000-000000000345",
);
const SETUP_ROLE_ID = uuidSchema.parse("00000000-0000-7000-8000-000000000346");
const SETUP_SOURCE = {
	...buildDoc({
		modules: [
			{
				name: "Survey",
				displayCondition: eq(
					sessionUserProperty(SETUP_REGION_ID),
					literal("north"),
				),
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [{ kind: "text", id: "name", label: proseText("Name") }],
					},
				],
			},
		],
	}),
	userProperties: {
		[SETUP_REGION_ID]: {
			uuid: SETUP_REGION_ID,
			slug: "region",
			label: "Region",
			choices: ["north", "south", "__nova_no_value"],
		},
		[SETUP_CADRE_ID]: { uuid: SETUP_CADRE_ID, slug: "cadre", label: "Cadre" },
	},
	userPropertyOrder: [SETUP_REGION_ID, SETUP_CADRE_ID],
	userTypes: {
		[SETUP_ROLE_ID]: {
			uuid: SETUP_ROLE_ID,
			name: "Field worker",
			values: { [SETUP_REGION_ID]: "north", [SETUP_CADRE_ID]: "nurse" },
		},
	},
	userTypeOrder: [SETUP_ROLE_ID],
	personas: {
		[SETUP_PERSONA_ID]: {
			uuid: SETUP_PERSONA_ID,
			name: "Asha",
			userTypeUuid: SETUP_ROLE_ID,
			values: { [SETUP_REGION_ID]: "south" },
		},
	},
	personaOrder: [SETUP_PERSONA_ID],
};
const setupAdmission = evaluateCommit({
	nextDoc: structuredClone(SETUP_SOURCE),
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
});
if (!setupAdmission.ok) throw new Error(JSON.stringify(setupAdmission));
const SETUP_DOC = toPersistableDoc(SETUP_SOURCE);
blueprintDocSchema.parse(SETUP_DOC);
function SetupFixtureContent({ values }: { readonly values: boolean }) {
	const properties = useUserProperties();
	const personas = usePersonas();
	const roles = useUserTypes();
	const mutations = useBlueprintMutations();
	const persona = personas[0];
	if (!persona) throw new Error("Missing native persona");
	return (
		<>
			{values ? (
				<section aria-label="Persona values">
					{properties.map((property) => (
						<ValueField
							key={property.uuid}
							property={property}
							value={persona.values?.[property.uuid]}
							inheritedValue={roles[0]?.values?.[property.uuid]}
							disabled={false}
							onChange={(value) =>
								mutations.inline.updatePersonaValue(
									persona.uuid,
									property.uuid,
									value,
								)
							}
						/>
					))}
				</section>
			) : (
				<WorkerInformationSubsection />
			)}
			<Button>Leave setup</Button>
			<Button
				onMouseDown={(event) => event.preventDefault()}
				onClick={() =>
					mutations.inline.updateUserProperty(SETUP_REGION_ID, {
						label: "District",
					})
				}
			>
				Peer renames region
			</Button>
			<output aria-label="Saved worker properties">
				{JSON.stringify(properties)}
			</output>
			<output aria-label="Saved persona values">
				{JSON.stringify(persona.values ?? {})}
			</output>
		</>
	);
}
function SetupFixture({ values = false }: { readonly values?: boolean }) {
	return (
		<BlueprintDocProvider initialDoc={SETUP_DOC} appId="native-setup" canEdit>
			<BuilderSessionProvider init={{ canEdit: true }}>
				<SetupFixtureContent values={values} />
			</BuilderSessionProvider>
		</BlueprintDocProvider>
	);
}
function MarkdownFixture() {
	const [value, setValue] = useState<string | undefined>("Hello");
	const [generation, setGeneration] = useState(0);
	return (
		<section aria-label="Markdown inspector" style={{ width: 300 }}>
			<OptionalMarkdownRow
				key={generation}
				label="Subtitle"
				hint="Shown below the title"
				value={value}
				onCommit={setValue}
			/>
			<Button>Leave markdown</Button>
			<Button onClick={() => setGeneration(generation + 1)}>
				Reopen markdown
			</Button>
			<output aria-label="Saved markdown">{value ?? "<absent>"}</output>
		</section>
	);
}
function ActivationFixtureContent() {
	const [selected, setSelected] = useState(false);
	const first = useField(OPTIONS_REFERENCE_ID);
	const second = useField(OPTIONS_FIELD_ID);
	if (first?.kind !== "text" || second?.kind !== "single_select")
		throw new Error("Missing activation fixture");
	return (
		<>
			<Button
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => setSelected(!selected)}
			>
				{selected ? "Select first field" : "Select second field"}
			</Button>
			<section aria-label="Appearance section">
				<FieldEditorSection
					field={selected ? second : first}
					section="ui"
					entries={[
						{
							key: "hint",
							component: TextEditor,
							label: "Hint",
							addable: true,
							visible: (field: typeof first | typeof second) =>
								!!field.hint?.parts.length,
						},
					]}
				/>
			</section>
			<section aria-label="Logic section">
				<FieldEditorSection
					field={first}
					section="logic"
					entries={[requiredEntry<typeof first>()]}
				/>
			</section>
			<output aria-label="Selected field">
				{selected ? "second" : "first"}
			</output>
		</>
	);
}
const CASE_WRITE_SOURCE = buildDoc({
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "phone", label: proseText("Phone"), data_type: "text" },
				{ name: "email", label: proseText("Email"), data_type: "text" },
			],
		},
	],
	modules: [
		{
			name: "Clients",
			caseType: "patient",
			caseListConfig: {
				...caseListConfig([{ field: "phone", header: "Phone" }]),
				selection: { kind: "multiple", maximum: 10 },
			},
			forms: [
				{
					name: "Follow up",
					type: "followup",
					fields: [
						{
							kind: "text",
							id: "phone",
							uuid: OPTIONS_REFERENCE_ID,
							label: proseText("Phone"),
							caseWrite: { caseType: "patient", property: "phone" },
						},
					],
				},
			],
		},
	],
});
const caseWriteAdmission = evaluateCommit({
	nextDoc: structuredClone(CASE_WRITE_SOURCE),
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
});
if (!caseWriteAdmission.ok) throw new Error(JSON.stringify(caseWriteAdmission));
const CASE_WRITE_DOC = toPersistableDoc(CASE_WRITE_SOURCE);
blueprintDocSchema.parse(CASE_WRITE_DOC);
function CaseWriteFixtureContent() {
	const field = useField(OPTIONS_REFERENCE_ID);
	const mutations = useBlueprintMutations();
	if (field?.kind !== "text") throw new Error("Missing case-write field");
	return (
		<>
			<CaseWriteEditor
				field={field}
				value={field.caseWrite}
				label="Saves to"
				keyName="caseWrite"
				onChange={(next) =>
					mutations.inline.updateField(field.uuid, "text", { caseWrite: next })
				}
			/>
			<output aria-label="Saved destination">
				{JSON.stringify(field.caseWrite)}
			</output>
		</>
	);
}
function CaseWriteFixture() {
	return (
		<BlueprintDocProvider initialDoc={CASE_WRITE_DOC} appId="native-case-write">
			<BuilderSessionProvider init={{ canEdit: true }}>
				<CaseWriteFixtureContent />
			</BuilderSessionProvider>
		</BlueprintDocProvider>
	);
}
/**
 * The field inspector on a one-case followup form: what the rail says and
 * shows for each destination class, and how the hidden field's single Value
 * control moves between its two modes. Legacy both-slot hidden fields are
 * not seeded here because the commit gate refuses them; the pure model test
 * owns that state.
 */
const PRELOAD_PHONE_ID = uuidSchema.parse(
	"00000000-0000-7000-8000-00000000a001",
);
const PRELOAD_EMAIL_ID = uuidSchema.parse(
	"00000000-0000-7000-8000-00000000a002",
);
const PRELOAD_VISIT_NAME_ID = uuidSchema.parse(
	"00000000-0000-7000-8000-00000000a003",
);
const PRELOAD_VISIT_NOTES_ID = uuidSchema.parse(
	"00000000-0000-7000-8000-00000000a004",
);
const PRELOAD_LAST_SEEN_ID = uuidSchema.parse(
	"00000000-0000-7000-8000-00000000a005",
);
const PRELOAD_SCRATCH_ID = uuidSchema.parse(
	"00000000-0000-7000-8000-00000000a006",
);
const PRELOAD_FIELDS = {
	phone: PRELOAD_PHONE_ID,
	email: PRELOAD_EMAIL_ID,
	"visit name": PRELOAD_VISIT_NAME_ID,
	"last seen": PRELOAD_LAST_SEEN_ID,
	scratch: PRELOAD_SCRATCH_ID,
} as const;
type PreloadFieldName = keyof typeof PRELOAD_FIELDS;
const PRELOAD_SOURCE = buildDoc({
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "phone", label: proseText("Phone"), data_type: "text" },
				{ name: "email", label: proseText("Email"), data_type: "text" },
				{ name: "last_seen", label: proseText("Last seen"), data_type: "date" },
			],
		},
		{
			name: "visit",
			parent_type: "patient",
			properties: [
				{ name: "notes", label: proseText("Notes"), data_type: "text" },
			],
		},
	],
	modules: [
		{
			name: "Visits",
			caseType: "visit",
			caseListOnly: true,
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
			forms: [],
		},
		{
			name: "Clients",
			caseType: "patient",
			caseListConfig: caseListConfig([{ field: "phone", header: "Phone" }]),
			forms: [
				{
					name: "Follow up",
					type: "followup",
					fields: [
						{
							kind: "text",
							id: "phone",
							uuid: PRELOAD_PHONE_ID,
							label: proseText("Phone"),
							caseWrite: { caseType: "patient", property: "phone" },
						},
						{
							kind: "text",
							id: "email",
							uuid: PRELOAD_EMAIL_ID,
							label: proseText("Email"),
							caseWrite: { caseType: "patient", property: "email" },
							default_value: "'none'",
						},
						{
							kind: "text",
							id: "visit_name",
							uuid: PRELOAD_VISIT_NAME_ID,
							label: proseText("Visit name"),
							caseWrite: { caseType: "visit", property: "case_name" },
						},
						{
							kind: "text",
							id: "visit_notes",
							uuid: PRELOAD_VISIT_NOTES_ID,
							label: proseText("Visit notes"),
							caseWrite: { caseType: "visit", property: "notes" },
						},
						{
							kind: "hidden",
							id: "last_seen",
							uuid: PRELOAD_LAST_SEEN_ID,
							calculate: "today()",
							caseWrite: { caseType: "patient", property: "last_seen" },
						},
						{
							kind: "hidden",
							id: "scratch",
							uuid: PRELOAD_SCRATCH_ID,
							default_value: "''",
						},
					],
				},
			],
		},
	],
});
const preloadAdmission = evaluateCommit({
	nextDoc: structuredClone(PRELOAD_SOURCE),
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
});
if (!preloadAdmission.ok) throw new Error(JSON.stringify(preloadAdmission));
const PRELOAD_DOC = toPersistableDoc(PRELOAD_SOURCE);
blueprintDocSchema.parse(PRELOAD_DOC);
function PreloadFixtureContent() {
	const [selected, setSelected] = useState<PreloadFieldName>("phone");
	const field = useField(PRELOAD_FIELDS[selected]);
	const api = useBlueprintDocApi();
	const canUndo = useCanUndo();
	if (field === undefined) throw new Error("Missing preload fixture field");
	return (
		<>
			<nav aria-label="Fields">
				{(Object.keys(PRELOAD_FIELDS) as PreloadFieldName[]).map((name) => (
					<Button
						key={name}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => setSelected(name)}
					>
						Select {name}
					</Button>
				))}
			</nav>
			<section aria-label="Field inspector" style={{ width: 300 }}>
				<FieldEditorPanel field={field} />
			</section>
			<Button
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => {
					const result = runHistoryStep(
						api.getState(),
						"undo",
						{
							canEdit: true,
							lookupCommitState: {
								kind: "unmanaged",
								lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
							},
						},
						flushSync,
					);
					if (result.kind === "refused") throw new Error(result.message);
				}}
			>
				Undo
			</Button>
			<output aria-label="Saved field">{JSON.stringify(field)}</output>
			<output aria-label="Can undo">{String(canUndo)}</output>
		</>
	);
}
function PreloadFixture() {
	return (
		<BlueprintDocProvider
			initialDoc={PRELOAD_DOC}
			appId="native-preload"
			canEdit
		>
			<BuilderSessionProvider init={{ canEdit: true }}>
				<EditGuardProvider>
					<PreloadFixtureContent />
				</EditGuardProvider>
			</BuilderSessionProvider>
		</BlueprintDocProvider>
	);
}

function OptionsFixtureContent() {
	const field = useField(OPTIONS_FIELD_ID);
	const mutations = useBlueprintMutations();
	const [reorderKeys, setReorderKeys] = useState(false);
	if (field?.kind !== "single_select" || field.optionsSource.kind !== "inline")
		throw new Error("Missing options fixture");
	const source = reorderKeys
		? {
				kind: "inline" as const,
				options: field.optionsSource.options.map((option) => ({
					label: option.label,
					value: option.value,
					uuid: option.uuid,
					...(option.media ? { media: option.media } : {}),
				})),
			}
		: field.optionsSource;
	return (
		<>
			<OptionsEditor
				field={field}
				value={source}
				label="Options"
				keyName="optionsSource"
				onChange={(next) =>
					mutations.inline.updateField(field.uuid, "single_select", {
						optionsSource: next,
					})
				}
			/>
			<Button
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => setReorderKeys(!reorderKeys)}
			>
				Reorder snapshot object keys
			</Button>
			<Button
				onClick={() =>
					mutations.inline.updateField(field.uuid, "single_select", {
						optionsSource: {
							kind: "inline",
							options:
								field.optionsSource.kind === "inline"
									? field.optionsSource.options.map((option, index) =>
											index === 0
												? {
														...option,
														value: "option_1",
														label: {
															parts: [
																{ kind: "text" as const, text: "Option 1" },
																{
																	kind: "field-ref" as const,
																	uuid: OPTIONS_REFERENCE_ID,
																},
															],
														},
													}
												: option,
										)
									: [],
						},
					})
				}
			>
				Load authored reference label
			</Button>
			<Button>Leave options</Button>
			<output aria-label="Saved options">
				{JSON.stringify(field.optionsSource)}
			</output>
		</>
	);
}
function FieldProseFixtureContent() {
	const field = useField(OPTIONS_REFERENCE_ID);
	const mutations = useBlueprintMutations();
	const canUndo = useCanUndo();
	if (field?.kind !== "text") throw new Error("Missing prose field");
	return (
		<>
			<TextEditor
				field={field}
				value={field.hint}
				label="Hint"
				keyName="hint"
				onChange={(next) =>
					mutations.inline.updateField(field.uuid, "text", { hint: next })
				}
			/>
			<Button>Leave prose</Button>
			<output aria-label="Saved prose field">{JSON.stringify(field)}</output>
			<output aria-label="Can undo">{String(canUndo)}</output>
		</>
	);
}
function FieldLogicFixtureContent({
	required = false,
}: {
	readonly required?: boolean;
}) {
	const field = useField(OPTIONS_REFERENCE_ID);
	const mutations = useBlueprintMutations();
	const canUndo = useCanUndo();
	if (field?.kind !== "text") throw new Error("Missing logic field");
	return (
		<>
			{required ? (
				<RequiredEditor
					field={field}
					value={field.required}
					label="Required"
					keyName="required"
					onChange={(next) =>
						mutations.inline.updateField(field.uuid, "text", { required: next })
					}
				/>
			) : (
				<XPathEditor
					field={field}
					value={field.validate}
					label="Validation condition"
					keyName="validate"
					onChange={(next) =>
						mutations.inline.updateField(field.uuid, "text", { validate: next })
					}
				/>
			)}
			<Button>Leave logic</Button>
			<output aria-label="Saved logic field">{JSON.stringify(field)}</output>
			<output aria-label="Can undo">{String(canUndo)}</output>
		</>
	);
}
function OptionsFixture({
	prose = false,
	logic = false,
	required = false,
	activation = false,
}: {
	readonly prose?: boolean;
	readonly logic?: boolean;
	readonly required?: boolean;
	readonly activation?: boolean;
}) {
	const [editable, setEditable] = useState(true);
	useEffect(() => {
		const receive = (event: Event) => {
			if (event instanceof CustomEvent && typeof event.detail === "boolean")
				setEditable(event.detail);
		};
		window.addEventListener("native-editor-access", receive);
		return () => window.removeEventListener("native-editor-access", receive);
	}, []);
	return (
		<BlueprintDocProvider
			initialDoc={OPTIONS_DOC}
			appId="native-options"
			canEdit={editable}
		>
			<BuilderSessionProvider>
				<Button
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => setEditable(!editable)}
				>
					{editable ? "Make app read only" : "Restore editing"}
				</Button>
				{activation ? (
					<ActivationFixtureContent />
				) : prose ? (
					<FieldProseFixtureContent />
				) : logic ? (
					<EditGuardProvider>
						<FieldLogicFixtureContent required={required} />
					</EditGuardProvider>
				) : (
					<OptionsFixtureContent />
				)}
			</BuilderSessionProvider>
		</BlueprintDocProvider>
	);
}
const STABLE_CASE_TYPES: readonly CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
			{ name: "region", label: proseText("Region"), data_type: "text" },
		],
	},
];
function StableAstFixture({ mode }: { readonly mode: string }) {
	const comparison = lt(prop("patient", "dob"), dateLiteral("2026-01-01"));
	const [value, setValue] = useState<Predicate | ValueExpression>(() =>
		mode === "stable-active"
			? comparison
			: mode === "stable-membership"
				? isIn(
						prop("patient", "dob"),
						dateLiteral("2026-01-01"),
						dateLiteral("2026-02-02"),
					)
				: mode === "stable-concat"
					? concat(
							term(dateLiteral("2026-01-01")),
							term(dateLiteral("2026-02-02")),
						)
					: mode === "stable-coalesce"
						? coalesce(
								term(dateLiteral("2026-01-01")),
								term(dateLiteral("2026-02-02")),
							)
						: mode === "stable-switch"
							? switchExpr(
									term(prop("patient", "dob")),
									[
										switchCase(
											dateLiteral("2026-01-01"),
											term(literal("scheduled")),
										),
									],
									term(literal("other")),
								)
							: mode === "stable-boolean"
								? concat(term(literal(true)), term(dateLiteral("2026-01-01")))
								: and(
										comparison,
										eq(prop("patient", "region"), literal("North")),
									),
	);
	const ctx = buildEditorTypeContext({
		caseTypes: STABLE_CASE_TYPES,
		currentCaseType: "patient",
		knownInputs: [],
	});
	const expression = ["concat", "coalesce", "switch"].includes(value.kind);
	const change = (next: Predicate | ValueExpression) => {
		const parsed = expression
			? valueExpressionSchema.parse(next)
			: predicateSchema.parse(next);
		const checked = expression
			? checkValueExpression(valueExpressionSchema.parse(parsed), ctx)
			: checkPredicate(predicateSchema.parse(parsed), ctx);
		if (!checked.ok) throw new Error(JSON.stringify(checked));
		setValue(parsed);
	};
	const props = { caseTypes: STABLE_CASE_TYPES, currentCaseType: "patient" };
	return (
		<BlueprintDocProvider appId="native-editor">
			{expression ? (
				<ExpressionCardEditor
					{...props}
					value={valueExpressionSchema.parse(value)}
					onChange={change}
				/>
			) : mode === "stable-workbench" || mode === "stable-active" ? (
				<PredicateWorkbench
					{...props}
					value={predicateSchema.parse(value)}
					onChange={change}
					focusRequest={
						mode === "stable-active" ? { token: 1, path: ["right"] } : undefined
					}
				/>
			) : (
				<PredicateCardEditor
					{...props}
					value={predicateSchema.parse(value)}
					onChange={change}
				/>
			)}
			<output aria-label="Saved stable AST">{JSON.stringify(value)}</output>
		</BlueprintDocProvider>
	);
}
function LogicalDragFixture() {
	const [value, setValue] = useState<Predicate>(
		and(
			eq(prop("patient", "case_name"), literal("North")),
			eq(prop("patient", "case_name"), literal("South")),
			eq(prop("patient", "case_name"), literal("West")),
		),
	);
	return (
		<BlueprintDocProvider appId="native-editor">
			<PredicateCardEditor
				value={value}
				onChange={(next) => setValue(predicateSchema.parse(next))}
				caseTypes={EDITOR_CASE_TYPES}
				currentCaseType="patient"
			/>
			<output aria-label="Saved logical group">{JSON.stringify(value)}</output>
		</BlueprintDocProvider>
	);
}
const RELATED_FILTER_CASE_TYPES: readonly CaseType[] = [
	{ name: "household", properties: [] },
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "enrollment", label: proseText("Enrollment"), data_type: "text" },
		],
	},
	{
		name: "visit",
		parent_type: "household",
		properties: [
			{
				name: "enrollment",
				label: proseText("Visit enrollment"),
				data_type: "text",
			},
		],
	},
];
function RelatedFilterFixture({ mode }: { readonly mode: string }) {
	const [value, setValue] = useState<Predicate | ValueExpression>(() => {
		const via = subcasePath("parent", "patient");
		const where = mode.endsWith("seed")
			? undefined
			: eq(prop("patient", "enrollment"), literal("active"));
		return mode.includes("count") ? count(via, where) : exists(via, where);
	});
	const change = (next: Predicate | ValueExpression) =>
		setValue(
			next.kind === "count"
				? valueExpressionSchema.parse(next)
				: predicateSchema.parse(next),
		);
	const props = {
		caseTypes: RELATED_FILTER_CASE_TYPES,
		currentCaseType: "household",
	};
	return (
		<BlueprintDocProvider appId="native-editor">
			{value.kind === "count" ? (
				<ExpressionCardEditor {...props} value={value} onChange={change} />
			) : mode.includes("workbench") ? (
				<PredicateWorkbench
					{...props}
					value={predicateSchema.parse(value)}
					onChange={change}
				/>
			) : (
				<PredicateCardEditor
					{...props}
					value={predicateSchema.parse(value)}
					onChange={change}
				/>
			)}
			<output aria-label="Saved related filter">{JSON.stringify(value)}</output>
		</BlueprintDocProvider>
	);
}
function LiteralShapeFixture() {
	const [value, setValue] = useState<ValueExpression>(
		term(dateLiteral("2026-07-17")),
	);
	return (
		<BlueprintDocProvider appId="native-editor">
			<ExpressionCardEditor
				value={value}
				onChange={(next) => setValue(valueExpressionSchema.parse(next))}
				caseTypes={EDITOR_CASE_TYPES}
				currentCaseType="patient"
			/>
			<output aria-label="Saved literal shape">{JSON.stringify(value)}</output>
		</BlueprintDocProvider>
	);
}
function SlotHeaderFixture() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<SlotCardHeader
				title="Starting value"
				description="Choose what appears before someone enters an answer"
				collapse={{
					isOpen: open,
					onToggle: () => setOpen(!open),
					expandLabel: "Open starting value",
					collapseLabel: "Close starting value",
					controlsId: "starting-value",
				}}
			/>
			<section id="starting-value" hidden={!open}>
				Saved starting value
			</section>
		</>
	);
}
const WORKER_ID = uuidSchema.parse("00000000-0000-7000-8000-000000000123");
function WorkerTermFixture() {
	const [properties, setProperties] = useState<UserProperty[]>([
		{ uuid: WORKER_ID, slug: "assigned_region", label: "Assigned region" },
	]);
	const [value, setValue] = useState<ValueExpression>(() =>
		term(sessionUserProperty(WORKER_ID)),
	);
	const [valid, setValid] = useState<boolean | undefined>();
	return (
		<BlueprintDocProvider appId="native-editor">
			<ExpressionCardEditor
				value={value}
				onChange={setValue}
				caseTypes={EDITOR_CASE_TYPES}
				currentCaseType="patient"
				userProperties={properties}
				onValidityChange={setValid}
			/>
			<Button
				onClick={() =>
					setProperties([
						{ uuid: WORKER_ID, slug: "service_area", label: "Service area" },
					])
				}
			>
				Rename worker information
			</Button>
			<Button onClick={() => setProperties([])}>
				Remove worker information
			</Button>
			<output aria-label="Saved worker source">{JSON.stringify(value)}</output>
			<output aria-label="Worker validity">{String(valid)}</output>
		</BlueprintDocProvider>
	);
}
const MEMBERSHIP_CASE_TYPES: CaseType[] = [
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "started", label: proseText("Started"), data_type: "int" },
		],
	},
	{
		name: "household",
		properties: [
			{ name: "started", label: proseText("Started"), data_type: "date" },
		],
	},
];
function RelatedMembershipFixture() {
	const [value, setValue] = useState<Predicate>(() =>
		isIn(
			prop(
				"patient",
				"started",
				ancestorPath(relationStep("parent", "household")),
			),
			dateLiteral("2026-01-01"),
		),
	);
	return (
		<BlueprintDocProvider appId="native-editor">
			<PredicateCardEditor
				value={value}
				onChange={(next) => {
					if (
						!checkPredicate(
							next,
							buildEditorTypeContext({
								caseTypes: MEMBERSHIP_CASE_TYPES,
								currentCaseType: "patient",
								knownInputs: [],
							}),
						).ok
					)
						throw new Error("Invalid related membership fixture commit");
					setValue(predicateSchema.parse(next));
				}}
				caseTypes={MEMBERSHIP_CASE_TYPES}
				currentCaseType="patient"
			/>
			<output aria-label="Saved membership">{JSON.stringify(value)}</output>
		</BlueprintDocProvider>
	);
}
function PredicateDiagnosticFixture({ kind }: { kind: string }) {
	const [value, setValue] = useState<Predicate>(() =>
		kind === "comparison-missing"
			? eq(prop("patient", "missing"), literal("value"))
			: match(
					prop("patient", "case_name"),
					kind === "match-empty" ? literal("") : prop("patient", "missing"),
					"starts-with",
				),
	);
	const [valid, setValid] = useState<boolean | undefined>();
	return (
		<BlueprintDocProvider appId="native-editor">
			<PredicateCardEditor
				value={value}
				onChange={setValue}
				caseTypes={EDITOR_CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={setValid}
			/>
			<Button
				onClick={() =>
					setValue(eq(prop("patient", "case_name"), literal("North")))
				}
			>
				Load corrected condition
			</Button>
			<output aria-label="Predicate validity">{String(valid)}</output>
		</BlueprintDocProvider>
	);
}
const CHOICE_CASE_TYPES: CaseType[] = [
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{
				name: "tags",
				label: proseText("Client tags"),
				data_type: "multi_select",
				options: [{ value: "client", label: proseText("Client") }],
			},
		],
	},
	{
		name: "household",
		properties: [
			{
				name: "tags",
				label: proseText("Household tags"),
				data_type: "multi_select",
				options: [
					{ value: "open_a", label: proseText("Open") },
					{ value: "open_b", label: proseText("Open") },
					{ value: "closed", label: proseText("Closed") },
				],
			},
		],
	},
];
function MultiSelectFixture() {
	const [value, setValue] = useState<Predicate>(() =>
		multiSelectAny(
			prop(
				"patient",
				"tags",
				ancestorPath(relationStep("parent", "household")),
			),
			literal("open_a"),
			literal("closed"),
		),
	);
	return (
		<BlueprintDocProvider appId="native-editor">
			<PredicateCardEditor
				value={value}
				onChange={(next) => {
					const parsed = predicateSchema.parse(next);
					if (
						!checkPredicate(
							parsed,
							buildEditorTypeContext({
								caseTypes: CHOICE_CASE_TYPES,
								currentCaseType: "patient",
								knownInputs: [],
							}),
						).ok
					)
						throw new Error("Invalid chip fixture commit");
					setValue(parsed);
				}}
				caseTypes={CHOICE_CASE_TYPES}
				currentCaseType="patient"
			/>
			<output aria-label="Saved choices">{JSON.stringify(value)}</output>
		</BlueprintDocProvider>
	);
}
const DISTANCE_CASE_TYPES: CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "location", label: proseText("Home"), data_type: "geopoint" },
		],
	},
];
function DistanceFixture() {
	const [value, setValue] = useState<Predicate>(() =>
		within(prop("patient", "location"), term(literal("0 0")), 1, "miles"),
	);
	return (
		<BlueprintDocProvider appId="native-editor">
			<PredicateCardEditor
				value={value}
				onChange={(next) => {
					if (
						!checkPredicate(
							next,
							buildEditorTypeContext({
								caseTypes: DISTANCE_CASE_TYPES,
								currentCaseType: "patient",
								knownInputs: [],
							}),
						).ok
					)
						throw new Error("Invalid distance fixture commit");
					setValue(predicateSchema.parse(next));
				}}
				caseTypes={DISTANCE_CASE_TYPES}
				currentCaseType="patient"
			/>
			<Button>Leave distance</Button>
			<Button
				onClick={() =>
					setValue(
						within(
							prop("patient", "location"),
							term(literal("0 0")),
							Number.MAX_VALUE / 1200,
							"kilometers",
						),
					)
				}
			>
				Load large distance
			</Button>
			<output aria-label="Saved distance">{JSON.stringify(value)}</output>
		</BlueprintDocProvider>
	);
}
function WorkbenchFixture({ mode }: { readonly mode: string }) {
	const first = eq(prop("patient", "case_name"), literal("North"));
	const second = eq(prop("patient", "case_name"), literal("South"));
	const third = eq(prop("patient", "case_name"), literal("West"));
	const [value, setValue] = useState<Predicate>(() =>
		mode === "workbench-navigation"
			? and(first, or(second, not(first)))
			: mode === "workbench-group"
				? and(first, second, third)
				: first,
	);
	const [request, setRequest] = useState<
		{ token: number; path: readonly (string | number)[] } | undefined
	>();
	return (
		<BlueprintDocProvider appId="native-editor">
			<Button
				onClick={() =>
					setRequest((current) => ({
						token: (current?.token ?? 0) + 1,
						path: ["and", 1, "or", 1, "not", "clause"],
					}))
				}
			>
				Focus nested condition
			</Button>
			<section
				data-case-workspace-scroll-body="list"
				aria-label="Rule workspace"
				style={{ height: 600, overflow: "auto", maxWidth: 600 }}
			>
				<div style={{ height: 300 }} />
				<PredicateWorkbench
					value={value}
					onChange={(next) => {
						const parsed = predicateSchema.parse(next);
						if (!checkPredicate(parsed, EDITOR_TYPE_CONTEXT).ok)
							throw new Error("Invalid workbench fixture commit");
						setValue(parsed);
					}}
					caseTypes={EDITOR_CASE_TYPES}
					currentCaseType="patient"
					evaluationTarget={
						mode === "workbench-search" ? "case-search" : "on-device"
					}
					focusRequest={request}
				/>
				<div style={{ height: 900 }} />
			</section>
			<output aria-label="Saved rule">{JSON.stringify(value)}</output>
		</BlueprintDocProvider>
	);
}
function TermSourceFixture({ raw = false }: { readonly raw?: boolean }) {
	const [value, setValue] = useState<ValueExpression>(() =>
		raw
			? term(literal(""))
			: term(
					prop(
						"patient",
						"region",
						ancestorPath(relationStep("parent", "household")),
					),
				),
	);
	const [commits, setCommits] = useState(0);
	return (
		<BlueprintDocProvider appId="native-editor">
			<ExpressionCardEditor
				value={value}
				onChange={(next) => {
					const parsed = valueExpressionSchema.parse(next);
					if (!checkValueExpression(parsed, EDITOR_TYPE_CONTEXT).ok)
						throw new Error("Invalid term source fixture commit");
					setValue(parsed);
					setCommits((n) => n + 1);
				}}
				caseTypes={EDITOR_CASE_TYPES}
				currentCaseType="patient"
			/>
			<Button>Leave source</Button>
			<output aria-label="Saved source">{JSON.stringify(value)}</output>
			<output aria-label="Source commits">{commits}</output>
		</BlueprintDocProvider>
	);
}
function IntegerTermFixture() {
	const [value, setValue] = useState<ValueExpression>(term(literal(7)));
	return (
		<BlueprintDocProvider appId="native-editor">
			<ExpressionCardEditor
				value={value}
				onChange={setValue}
				caseTypes={EDITOR_CASE_TYPES}
				currentCaseType="patient"
				constraint={comparisonObjectConstraint("eq", "int")}
			/>
			<Button>Leave value</Button>
			<output aria-label="Saved integer term">{JSON.stringify(value)}</output>
		</BlueprintDocProvider>
	);
}
const scenario = new URL(location.href).searchParams.get("scenario") ?? "";
if (scenario === "case-write")
	window.history.replaceState(
		null,
		"",
		`/build/native-case-write/${Object.keys(CASE_WRITE_DOC.forms)[0]}`,
	);
if (scenario === "preload")
	window.history.replaceState(
		null,
		"",
		`/build/native-preload/${Object.keys(PRELOAD_DOC.forms)[0]}`,
	);

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
if (scenario === "chrome") root.style.maxWidth = "1800px";
createRoot(root).render(
	<StrictMode>
		{scenario === "inline-validation" ? (
			<InlineValidationFixture />
		) : scenario === "chrome" ? (
			<ChromeFixture />
		) : scenario === "places" ? (
			<PlacesFixture />
		) : scenario === "progress" ? (
			<ProgressFixture />
		) : scenario === "frame" ? (
			<FrameFixture />
		) : scenario === "access" ? (
			<AccessFixture />
		) : scenario === "module-settings" ? (
			<ModuleSettingsFixture />
		) : scenario === "case-target" ? (
			<CaseTargetFixture />
		) : scenario === "carry-single" || scenario === "carry-multiple" ? (
			<CarryFixture multiple={scenario === "carry-multiple"} />
		) : scenario === "setup-worker" || scenario === "setup-values" ? (
			<SetupFixture values={scenario === "setup-values"} />
		) : scenario === "preload" ? (
			<PreloadFixture />
		) : scenario === "case-write" ? (
			<CaseWriteFixture />
		) : scenario === "activation" ? (
			<OptionsFixture activation />
		) : scenario === "markdown" ? (
			<MarkdownFixture />
		) : scenario === "options-source" ? (
			<OptionsSourceFixture />
		) : scenario === "field-logic" || scenario === "field-required" ? (
			<OptionsFixture logic required={scenario === "field-required"} />
		) : scenario === "field-prose" ? (
			<OptionsFixture prose />
		) : scenario === "options" ? (
			<OptionsFixture />
		) : scenario.startsWith("stable-") ? (
			<StableAstFixture mode={scenario} />
		) : scenario === "logical-drag" ? (
			<LogicalDragFixture />
		) : scenario.startsWith("related-filter-") ? (
			<RelatedFilterFixture mode={scenario} />
		) : scenario === "literal-shape" ? (
			<LiteralShapeFixture />
		) : scenario === "slot-header" ? (
			<SlotHeaderFixture />
		) : scenario === "worker-source" ? (
			<WorkerTermFixture />
		) : scenario === "related-membership" ? (
			<RelatedMembershipFixture />
		) : scenario === "comparison-missing" ||
			scenario === "match-empty" ||
			scenario === "match-missing" ? (
			<PredicateDiagnosticFixture kind={scenario} />
		) : scenario === "multi-select" ? (
			<MultiSelectFixture />
		) : scenario === "distance" ? (
			<DistanceFixture />
		) : scenario?.startsWith("workbench-") ? (
			<WorkbenchFixture mode={scenario} />
		) : scenario === "term-source" || scenario === "raw-source" ? (
			<TermSourceFixture raw={scenario === "raw-source"} />
		) : scenario === "integer-term" ? (
			<IntegerTermFixture />
		) : scenario === "property-picker" ? (
			<PropertyPickerFixture />
		) : scenario === "arith-error" || scenario === "if-error" ? (
			<DiagnosticFixture kind={scenario} />
		) : scenario === "optional-condition" ? (
			<OptionalConditionFixture />
		) : scenario === "concat" ||
			scenario === "coalesce" ||
			scenario === "switch" ? (
			<ListExpressionFixture kind={scenario} />
		) : scenario === "literal" ? (
			<LiteralFixture />
		) : scenario === "date-pattern" ? (
			<DatePatternFixture />
		) : scenario === "case-type" ? (
			<CaseTypeFixture />
		) : scenario === "expression" ? (
			<ExpressionFixture />
		) : scenario === "pattern" ||
			scenario === "membership" ||
			scenario === "property" ? (
			<PredicateFixture mode={scenario} />
		) : scenario === "relation" || scenario === "custom-relation" ? (
			<RelationFixture custom={scenario === "custom-relation"} />
		) : scenario === "calendar" ? (
			<Calendars />
		) : scenario === "dialog" ? (
			<Dialogs />
		) : scenario === "identity" ? (
			<StableRows />
		) : (
			<Choices />
		)}
	</StrictMode>,
);
