import { fieldKinds, fieldRegistry } from "@/lib/domain";
import {
	FUNCTION_REGISTRY,
	functionArgumentCount,
	QUERY_FUNCTIONS,
} from "@/lib/domain/expressionFunctions";
import { workerIdentityGuidance, workerPlaceGuidance } from "./workerIdentity";

const fields = () =>
	fieldKinds
		.map((kind) => {
			const description =
				kind === "repeat"
					? 'Repeated questions. Use repeat.mode "user_controlled" for rows the worker adds, "count_bound" with count for a fixed number, or "query_bound" with ids_query for one row per record. Counts and record IDs outside another repeat are captured when the form opens; nested repeats capture theirs when the enclosing row is created. A section creates its rows on first entry, so nested repeats there can read answers from earlier pages. Returning to a page or changing an answer keeps rows already created. Without sections, Preview shows the whole form together; native question-by-question insertion timing still needs a device check. Each query-bound row retains its record identity: put a hidden row_id directly inside the repeat with calculate current()/../@id, then use #form/row_id in an operation running over this same repeat. For example, instance(\'casedb\')/casedb/case[@case_id = current()/../@id]/case_name reads its name from another direct child calculation. Inside a predicate, current() retains the calculating field’s context; a repeated #form reference can instead select values from multiple rows. The @id belongs to the repeat row, so an intervening group changes the relative path. The repeat is not the selected record (#case), and its text is not a record ID.'
					: fieldRegistry[kind].saDocs;
			return `${kind}: ${description}`;
		})
		.join("\n");

export const AUTHORING_REFERENCE = {
	workflows:
		() => `Design forms around the worker's tasks and the records that persist between visits. Registration creates a record; follow-up changes a selected record; close closes its CommCare case lifecycle. A survey collects information without selecting a record. Set recordName to an answer or expression for the record's display name. New record modules declare their type and default to a Name column. Use caseWrite to save other answers; advanced operations describe additional ordered effects on other records.

The built-in status is operational: closing a record normally removes it from the worker's synced set at the next sync, though related open records can retain a closed dependency. Closing a host can also remove its extensions. Server history remains. Keep a record open if later tasks still need it. Store business stages such as awaiting approval or paid in an ordinary property such as current_status; changing that value does not close the case. CommCare's separate @state reads state with a current_status fallback; Nova supports current_status as an ordinary property, not authoring @state. Use the close form or an explicit close operation for lifecycle closure.

Records already have date_opened and last_modified. The former records opening; the latter changes with later case updates and is not the server receipt time. Prefer these to duplicate generic timestamps. Form expressions can read these built-ins on the selected record or its parents without custom definitions; date_opened and last_modified read as calendar dates there, so do not use them for elapsed-hour calculations. owner_id controls case sharing and sync together with relationships; it is not authorship or Nova Project permission. HQ records opened_by and modified_by (also called user_id), but Nova does not expose these as portable record properties; device owner identity is not the modifier. An approval date or approver that must survive later edits needs its own saved business-event value. Read a property to see its effective type and meaning. Unused custom definitions can be removed once the app no longer reads or writes them; removal refuses saved or set-aside values. Populated-property retirement needs a reviewed data migration.

Check journeys from app entry as the saved Preview identities a user can select. Disposable app tests let you navigate, choose records, answer and submit forms, and inspect resulting records and the next task without changing live records. Supply representative starting records when needed; fictional test places and assignments do not complete deployment setup. These records and places never appear in ordinary Preview. Users can inspect recorded steps through the Preview identity menu’s Test journeys; that view does not replay submissions or provide an interactive sandbox. A single-form check observes answers and proposed values, not submission or reachability. Neither check establishes device, media capture or automation behavior; report those boundaries when they matter.

Modules organize navigation. Record ancestry, submenu placement and parent selection are separate choices. setCaseTypeParent changes the record relationship. parentCaseModuleUuid makes a module select a parent first; omit it for a flat list, including records without parents. A submenu only groups menus. Each form has one owning module; different entry routes do not require copies of the form. Give each record lifecycle a usable way to begin, return and finish when the user's workflow needs those steps.

To create a child while working with its parent, use a parent follow-up form with caseWrite destinations on the direct child type. This supports ordinary answers and captured evidence in one submission. The child defaults to the current worker as owner, not the parent's owner; an explicit creation operation can choose another owner when case sharing requires it. A registration form creates an independent record, even in a module with parent selection. For an independent record that needs an explicit owner, a survey form can create it through an operation. Use that operation instead of also creating a primary registration record.

A several-case form applies one shared answer to each selected record. Questions start blank rather than borrowing one record's value, even if the worker selects just one case. Blank preserves each record's existing value; a configured starting value or calculation is shared. Never choose a representative record to fill the form.

Search-first workflows begin with Search. Their registration form is offered after no matches; it can use that Search's answers as starting values. A form opened on an existing record does not inherit Search answers. Results and Details serve different purposes: show the information needed to choose a record in Results, and supporting context in Details.

After-submit navigation happens after answers leave form scope. Save a needed answer before using it in a later route. An entry point is a durable external address for a destination; changing that address can break distributed links. Generating an HQ link requires a verified deployment. Opening it can claim cases, so it is not a harmless verification probe.`,
	fields,
	forms:
		() => `Form wording is Markdown. {{name}} inserts an answer; {{#case/property}} inserts a saved value. Worker values use {{#user/property}}. Bare hashtags in wording stay literal; expression slots use #form/name or #case/property without braces. Names bind to identities, so renames keep references intact. Escape a literal opening brace or backslash with a backslash.

Use relevant to decide whether a question participates in the form, required for an answer requirement, and validate: {expr, msg} for a rule and its explanation. Relevance also affects data: a non-relevant answer is omitted from submission and can read as blank in expressions. To carry a value without displaying a question, use a hidden field rather than a question with relevant: false(). In validation, . is the current answer: . >= 0 rejects negative ages. A hidden field calculates a value as answers change; default_value sets a starting value once at form load.

Writers for a single selected record start with its saved value, even when that value is blank; this overrides an explicit starting value. Scoped question reads report that effective source. Capture questions start with a new capture, not the old attachment. Several-case forms start blank unless a shared starting value or calculation is configured; blank preserves each record's value. After-submit links run after answers have left form scope; save a value before using it in a later route.`,
	expressions:
		() => `Expressions use XPath syntax: quoted text, numbers, true()/false(), =, !=, <, <=, >, >=, and, or, not(), +, -, *, div, mod. div produces a decimal. Record expressions also offer quotient(a,b) for integer division.

References depend on the current scope. #form/name reads a form answer; nested fields accept a unique short name or full path. #case/property reads the selected record. Registration and survey forms have no selected record. #user/property reads worker information. In record expressions, that property must be declared in the app; external-user('key') reads custom data supplied outside the app. #search/name reads a Search answer in Search rules or that module's no-matches registration. Names bind to stable identities; ambiguous names need an exact path or ID.

In form expressions, #<record-type>/<property> reads the selected record or an ancestor by its declared type. For a visit whose parent type is household, #household/region reads that household’s region and #household/case_id reads its identity. Read the form’s recordContext for the available types. This follows the saved relationship without copying parent values or IDs into custom fields. Registration and survey forms have no selected record; selecting several records does not provide one scalar record to read.

A form can also query other records available to its worker, including in registration and survey forms: instance('casedb')/casedb/case[@case_type = 'visit'] selects that type. Add predicates such as [region = #form/region] to filter by saved properties and answers; count(...) counts matches and sum(.../quantity) totals a numeric property. @case_id is the queried record's identity; index/parent is its parent identity. Use an explicit #form/path inside a predicate rather than . when you mean an answer, since . then denotes the queried node. For a follow-up check, exclude the selected record when appropriate. Query-bound repeats use a query's /@case_id nodes as ids_query. The fields guide explains their retained row identity and initialization timing. These are reads of the worker's available records, not a server-wide search or an atomic guarantee against concurrent submissions. Design ownership and workflow checks with that boundary in mind.

${workerIdentityGuidance()}

Forms and record expressions share concat(...), coalesce(...), if(condition,yes,no), number(value), date(value), format-date(value,format), and is-blank(value). Blank means missing or empty; zero, false and whitespace are values. coalesce returns the first nonblank value, or its last argument if all are blank. Other functions depend on the expression's scope; request this guide with functionName for a function's availability and argument count.

Record filters, Results columns, Search rules and advanced operation values also support datetime(value), date-add(date,quantity,'days'), in(value,'a','b'), between(value,lower,upper), all(...), and any(...). unbounded() omits a range end; optional fourth and fifth arguments to between set inclusive ends. selected-any(value,'a','b') and selected-all(value,'a','b') test several choices.

In record expressions, relationships are children('CaseType'), ancestor('parent'), related('CaseType'), and self(). exists(relationship,condition), missing(relationship,condition), and count(relationship,condition) evaluate on related records. via(ancestor('parent'), #case/property) reads a parent property. #case/case_id reads the selected record's identity; via(ancestor('parent'), #case/case_id) reads its parent's identity and can target an update to that parent. A relationship itself is not an ID. id-of('earlier_operation') reads the record created by an earlier operation. Reuse relationships instead of copying IDs into new custom properties. These record-expression functions are not form XPath functions.

lookup('Table','column',condition) reads a data-table value; #row/column inside its condition reads that table's row. Search offers when-provided(#search/name,condition), starts-with(#case/property,value), fuzzy(...), phonetic(...), and fuzzy-date(...). matches-pattern(value,'pattern') runs in Search required and validation rules. Rules before record selection cannot read an unselected record.`,
	languages:
		() => `The conversation language, the app's source language, and its runtime default are separate choices. Source language describes the text authored in the app; the runtime default is what workers see first. For a new app, establish its source language before adding translation targets. Changing a language identity does not translate its content.

Read the app's languages before changing them. A language identity contains language, with script when needed and an optional region; the tool resolves supported identifiers and names. Add a target by copying an existing language so every string has a value. Copying provides coverage, not a translation or a human review.

Translation entries include their location, current source, explicit value and status. Preserve inserted answers and record values when translating wording. Set operations begin Needs review. An explicit review is a separate decision about the exact value and current source; do not mark generated text as human-reviewed merely because you wrote it. Source changes can leave an existing translation out of date. Read fresh entries and echo their opaque revision tokens when setting or reviewing them.

Automatic translation availability is reported for each exact language direction. MCP has no automatic translation action; general model fluency is not permission to bulk-translate through manual edits. Save translations the user supplies or explicitly requests, and report remaining translation and review work.`,
	peopleAndPlaces:
		() => `Worker information describes the people using the app. Roles provide reusable values; a Preview persona inherits its role's values and can override individual ones. A persona is a Preview identity, not a provisioned CommCare HQ worker account. Give each authored role a representative persona so a person can enter its workflows. Role names such as Field worker are sufficient; this does not assert that a real worker account exists. Read Preview readiness to find missing worker information and unassigned location context. Do not invent real places or deployment assignments to hide missing setup. App worker roles are separate from the Nova Project roles that govern editing and sharing.

Built-in identity supplies the current worker without custom audit-identity properties. The worker-information read returns expressions for each supported scope.

Organization levels describe a hierarchy; places are its concrete locations. Case flow decides which places own records, where workers are assigned, and how far below their assigned place their cases reach. The address book independently decides which places workers can see and name in the app. Showing a place in the address book does not deliver its cases.

${workerPlaceGuidance()}

Choose these scopes from the user's responsibilities and geography. Read existing definitions before changing them; case flow and address-book settings are complete replacements. A persona's first assigned place is its main place. Archiving a place does not reassign its records; review the impact returned by the tool before confirming.

Ownership relative to the current record's place can travel to HQ. A rule naming one fixed Nova place cannot identify that place in HQ and is refused at export. Account for that boundary when designing a workflow intended for devices.`,
	sharedData:
		() => `Use inline choices for a small answer list belonging to one question. Use a Project data table for reusable or externally maintained reference information shared by questions or apps. Read existing tables before creating a duplicate. Display names help discovery; retained table and column identities keep references stable when names change.

Table and media resources belong to the Project. Editing or removing a shared resource can affect every referencing app, so those changes must be part of the user's authorized request. Updating a question's use of a table is distinct from changing the table itself.

A select is created with its complete choice source. Include the intended inline or table-backed source when creating the field, or when converting another field into a select. Do not create temporary choices merely to replace them on the next call.

Tables store reference data; cases store the records collected by the workflow. Preview reads real case data, and sample-data actions write real rows. Use disposable data only when the task calls for it and its lifecycle is clear.`,
	automations:
		() => `Automations describe conditional alerts and automatic record updates. They produce setup guidance for CommCare HQ; Preview does not run them. Request getAutomations with automationUuid and includeSetupGuide: true for the guide when preparing an HQ handoff. Read an existing automation before replacing it. Preserve identities for retained rules and nested items; omitted items are removed.

Messages are ordinary text with insertions such as {{#case/case_name}} and {{#recipient/first_name}}. Parent and host references require that relationship to exist. Host references require one extension; an ambiguous host cannot be used. Message references cannot use owner, host, or last_modified_by, which HQ reserves in its formatting context.

Recipient filters apply to recipients resolved as user accounts. A referenced filter property must be present on every triggering record. Email has one body: plain text or HTML. For a time read from a case property, provide a valid time beginning with H:MM or HH:MM; invalid or blank values fall back to noon. Registered IDs and setup-only instructions must match the target HQ project.

Nova checks representability before saving. Setup guidance names the remaining steps in HQ; saving an automation in Nova does not install or activate it there.`,
} as const;

/** The same signatures validate calls; this guide does not maintain an inventory. */
export function expressionFunctionReference(name: string): string | undefined {
	const forms = FUNCTION_REGISTRY.get(name);
	const records = QUERY_FUNCTIONS.get(name);
	if (!forms && !records) return;
	if (forms && records && forms === records)
		return `${name}(): ${functionArgumentCount(forms)}. Available in forms and record expressions.`;
	return [
		`${name}().`,
		forms && `Forms: ${functionArgumentCount(forms)}.`,
		records && `Record expressions: ${functionArgumentCount(records)}.`,
	]
		.filter(Boolean)
		.join(" ");
}
