import { fieldKinds, fieldRegistry } from "@/lib/domain";

const fields = () =>
	fieldKinds
		.map((kind) => {
			const description =
				kind === "repeat"
					? 'Repeated questions. Use repeat.mode "user_controlled" for rows the worker adds, "count_bound" with count for a fixed number, or "query_bound" with ids_query for one row per record. Counts and queries are fixed when that repeat instance opens.'
					: fieldRegistry[kind].saDocs;
			return `${kind}: ${description}`;
		})
		.join("\n");

export const AUTHORING_REFERENCE = {
	workflows:
		() => `Design forms around the worker's tasks and the records that persist between visits. Registration creates a record; follow-up changes a selected record; close completes it. A survey collects information without selecting a record. Use caseWrite for a form's ordinary answers; advanced operations describe additional ordered effects on other records.

Modules organize navigation. A submenu relationship does not create a relationship between records. Each form has one owning module; different entry routes do not require copies of the form. Give each record lifecycle a usable way to begin, return and finish when the user's workflow needs those steps.

A several-case form applies one shared answer to each selected record. Questions start blank rather than borrowing one record's value, even if the worker selects just one case. Blank preserves each record's existing value; a configured starting value or calculation is shared. Never choose a representative record to fill the form.

Search-first workflows begin with Search. Their registration form is offered after no matches; it can use that Search's answers as starting values. A form opened on an existing record does not inherit Search answers. Results and Details serve different purposes: show the information needed to choose a record in Results, and supporting context in Details.

After-submit navigation happens after answers leave form scope. Save a needed answer before using it in a later route. An entry point is a durable external address for a destination; changing that address can break distributed links. Generating an HQ link requires a verified deployment. Opening it can claim cases, so it is not a harmless verification probe.`,
	fields,
	formLogic:
		() => `Form expressions use XPath. #form/name reads an answer, with a full path for nested fields; #case/property reads the record selected for this form. Registration and survey forms have no selected record. #user/property reads worker information. In a module's no-matches registration form, #search/name reads that module's Search answer.

Use relevant for visibility, required for an answer requirement, and validate: {expr, msg} for a rule and its explanation. In validation, . is the current answer. For example, . >= 0 rejects negative ages. Hidden fields can calculate a value as answers change or use default_value once at form load. Writers for a single selected record start with its saved value. Several-case forms start blank unless a shared starting value or calculation is configured; blank preserves each record's value.

Wording is Markdown. {{name}} inserts an answer; {{#case/property}} inserts a saved value. Names bind to identities, so renames keep references intact. Escape a literal opening brace or backslash with a backslash.

Use the form's caseWrite destinations for ordinary record creation and updates. Advanced operations handle other records, related records, and repeated updates. A form's after-submit links run after its answers have left scope; save an answer to a record before using it there.`,
	recordQueries:
		() => `Record filters, Results columns, Search rules, and advanced operation values use expressions. #case/property reads the current record, #search/name reads a Search answer, and #user/property reads worker information. Quote literal text: 'active'. Numbers and true()/false() can be written directly.

Use =, !=, <, <=, >, >=, and, or, not(), and +, -, *, div, mod. div produces a decimal; quotient(a,b) preserves integer division. Common values include concat(...), coalesce(...), if(condition,yes,no), number(value), date(value), datetime(value), date-add(date,quantity,'days'), format-date(date,format), and id-of('earlier_operation').

Conditions include is-blank(value), in(value,'a','b'), between(value,lower,upper), and all(...)/any(...). unbounded() omits a range end; optional fourth and fifth arguments to between set inclusive ends. selected-any(value,'a','b') and selected-all(value,'a','b') test several choices.

Relationships are children('CaseType'), ancestor('parent'), related('CaseType'), and self(). exists(relationship,condition), missing(relationship,condition), and count(relationship,condition) evaluate the condition on related records. via(ancestor('parent'), #case/property) reads a parent property.

lookup('Table','column',condition) reads a data-table value. Within its condition, #row/column reads that table's row. Names must be unambiguous; stable IDs from reads work when labels collide.

Search supports when-provided(#search/name,condition), starts-with(#case/property,value), fuzzy(...), phonetic(...), and fuzzy-date(...). matches-pattern(value,'pattern') is available in Search required and validation rules. Conditions before record selection can use Search answers, worker information, and constants, but cannot read an unselected record.`,
	languages:
		() => `The conversation language, the app's source language, and its runtime default are separate choices. Source language describes the text authored in the app; the runtime default is what workers see first. For a new app, establish its source language before adding translation targets. Changing a language identity does not translate its content.

Read the app's languages before changing them. A language identity contains language, with script when needed and an optional region; the tool resolves supported identifiers and names. Add a target by copying an existing language so every string has a value. Copying provides coverage, not a translation or a human review.

Translation entries include their location, current source, explicit value and status. Preserve inserted answers and record values when translating wording. Set operations begin Needs review. An explicit review is a separate decision about the exact value and current source; do not mark generated text as human-reviewed merely because you wrote it. Source changes can leave an existing translation out of date. Read fresh entries and echo their opaque revision tokens when setting or reviewing them.

Automatic translation availability is reported for each exact language direction. MCP has no automatic translation action; general model fluency is not permission to bulk-translate through manual edits. Save translations the user supplies or explicitly requests, and report remaining translation and review work.`,
	peopleAndPlaces:
		() => `Worker information describes the people using the app. Roles provide reusable values; a Preview persona inherits its role's values and can override individual ones. A persona is a Preview identity, not a provisioned CommCare HQ worker account. App worker roles are separate from the Nova Project roles that govern editing and sharing.

Organization levels describe a hierarchy; places are its concrete locations. Case flow decides which places own records, where workers are assigned, and how far below their assigned place their cases reach. The address book independently decides which places workers can see and name in the app. Showing a place in the address book does not deliver its cases.

Choose these scopes from the user's responsibilities and geography. Read existing definitions before changing them; case flow and address-book settings are complete replacements. A persona's first assigned place is its main place. Archiving a place does not reassign its records; review the impact returned by the tool before confirming.

Ownership relative to the current record's place can travel to HQ. A rule naming one fixed Nova place cannot identify that place in HQ and is refused at export. Account for that boundary when designing a workflow intended for devices.`,
	sharedData:
		() => `Use inline choices for a small answer list belonging to one question. Use a Project data table for reusable or externally maintained reference information shared by questions or apps. Read existing tables before creating a duplicate. Display names help discovery; retained table and column identities keep references stable when names change.

Table and media resources belong to the Project. Editing or removing a shared resource can affect every referencing app, so those changes must be part of the user's authorized request. Updating a question's use of a table is distinct from changing the table itself.

A select is created with its complete choice source. Include the intended inline or table-backed source when creating the field, or when converting another field into a select. Do not create temporary choices merely to replace them on the next call.

Tables store reference data; cases store the records collected by the workflow. Preview reads real case data, and sample-data actions write real rows. Use disposable data only when the task calls for it and its lifecycle is clear.`,
	automations:
		() => `Automations describe conditional alerts and automatic record updates. They produce setup guidance for CommCare HQ; Preview does not run them. Read an existing automation before replacing it. Preserve identities for retained rules and nested items; omitted items are removed.

Messages are ordinary text with insertions such as {{#case/case_name}} and {{#recipient/first_name}}. Parent and host references require that relationship to exist. Host references require one extension; an ambiguous host cannot be used. Message references cannot use owner, host, or last_modified_by, which HQ reserves in its formatting context.

Recipient filters apply to recipients resolved as user accounts. A referenced filter property must be present on every triggering record. Email has one body: plain text or HTML. For a time read from a case property, provide a valid time beginning with H:MM or HH:MM; invalid or blank values fall back to noon. Registered IDs and setup-only instructions must match the target HQ project.

Nova checks representability before saving. Setup guidance names the remaining steps in HQ; saving an automation in Nova does not install or activate it there.`,
} as const;
