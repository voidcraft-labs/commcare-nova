# lib/commcare/reader

`readHqApp` (`index.ts`) reads a CommCare HQ app into a Nova document, or into an account of why
it cannot be held. `lib/commcare/CLAUDE.md` ("The reader", "Reading expressions", "Reading case
management back") states the accounting, the stage order and the expression contract; this file
is the method a change here keeps, the canonical rows, and what the reader is told.

## The method: propose, print back, compare trees

Every recognition is a proposal the production emitter prints back. A reader stage proposes the
Nova content it believes a piece of the source is, builds the candidate document
(`candidate.ts::withCandidate`, a new frozen object, so the emitter's per-document memos never see
a half-built draft), prints the candidate through the same function the export uses (the XForm
builder, `planFormCaseWire`, `projectCaseListForHq`, `toWire` in the slot's own mode), and
compares the parsed trees with the source's. A match is the reading; a mismatch is a finding or
the next candidate. Nothing is recognized by a text pattern, and no XPath is read with a regular
expression: XPath text is read through `syntaxRead.ts` and compared through
`syntaxCompare.ts::sameXPathText`. Two stored values (JSON, a document's slot, an expression tree)
are compared through one equality, `jsonCursor.ts::sameJson`: key order never matters, and a key
whose value is `undefined` is absent, as JSON leaves it out.

Four rules hold everywhere here:

- **Pure.** The reader reads only its arguments and never throws for an app's content: content
  it cannot hold is a finding, and what the reader itself got wrong is a `ReaderDefect`
  (`defects.ts`), logged and never shown. A throw is left only for a caller's broken input (menus
  from another reading) or a broken invariant of the reader's own.
- **One pass.** Every finding of a reading is reported at once: a stage that refuses something
  keeps reading the rest, and the expression stage binds every slot over a provisional document
  built whether or not a finding stands (`provisional.ts`).
- **Claimed or unrecognized.** A stage reads nothing it does not claim against a manifest entry
  (`claims.ts::defineClaims`), and whatever is left is `unrecognized` at the close.
- **No content in a finding or a log line.** A finding names a surface key, and the app's own
  value only in `detail.name`; a defect and its log line name places, codes and shapes, never an
  app's text.

## The bar and the canonical rows

Every document Nova's own emitters write reads back to the same document, after the reader's
canonical choices, with no finding and no defect. A read-back that returns a different document
with no finding is a break even where no test names it, and each one gets a test.

Two documents can print one source. Where they do, the reader returns one of them, and the choice
is a row of `assemble.ts::READER_CANONICAL_CHOICES`, `{ id, kind, apply }`: `apply` rewrites the
other member into the one the reader returns and leaves every other document as it was. `kind` is
`one-wire` where both members print the same bytes, `not-carried` where the content is in no
export at all. A print collision inside one expression slot is not a row here but a row of
`expressions/canonical.ts::PRINT_COLLISIONS`, applied through `canonicalExpression`.

A new row:

1. is written by the reader module that makes the choice and registered in the list, after any
   row whose result it reads (`order-rules-on-the-columns-they-land-on` before
   `unsorted-hidden-tile-columns-are-off-the-list`). A row's pair is two documents that print one
   export, not two that read one way: an order rule whose element is positional
   (`_cc_calculated_<n>`) names the column it is on, so the landing row moves only property
   elements;
2. gets its case in `__tests__/assemble.test.ts`, "the reader's canonical choices", or in its
   module's own test, which that case names: both members built from production builders,
   `expandDoc` of each equal byte for byte (for a `not-carried` row, the proof that no export
   carries what it removes), the row a fixed point on its own result, and, where the reader takes
   the pair, a reading of the export that gives the row's member;
3. states in its doc comment its pair, the member the reader returns and why both print one
   source, naming the function that applies it.

A row never parses or prints, and never hides a difference a runtime reads: if the two members'
exports differ, the reader is wrong and the reader module is corrected instead.

The yardsticks that hold the bar: `__tests__/targetedReadBack.test.ts` (every targeted and
producer document, compared whole: every place of the document but its expression slots, which
are compared tree by tree, and but what no export carries and the reader is never told),
`expressions/__tests__/expressionReadBack.fuzz.test.ts`,
`caseList/__tests__/order.roundTrip.test.ts`, `__tests__/identityMapParity.test.ts` and
`xform/__tests__/formFixedPoint.fuzz.test.ts`. `caseManagement/__tests__/caseReadBack.test.ts` also
holds each reading to the commit gate under the platform declaration its document holds, since a
canonical row can carry the reading and the canonical document past a rule together: every key a
reader stage reads as a write is refused there where the gate refuses it. Every whole reading the
case management tests make goes through `caseManagement/__tests__/heldReading.ts::readHqApp`, which
holds a reading with no finding to the gate under the declaration it proposes, so a reading the gate
refuses with no finding fails the test that made it. Each compares a reading with the canonical document
(the rows applied in list order) and is never weakened, skipped or special-cased. Beside them,
`__tests__/canonicalRowsKeepExport.test.ts` applies the rows in list order to every document
`targetedReadBack.test.ts` reads (`__tests__/publishedDocuments.ts`, the documents and the publish's
expansion of each) and holds `expandDoc`'s output byte for byte after every row that changes the
document, since a read-back that compares documents passes a row that moves content to a place
that prints differently.

## What the reader is told

`ReaderInput` (`types.ts`) is everything a reading takes. Beside the source as HQ serves it and
the aligned menus, it carries what no export holds: the identity resolver (`mintingResolver` for a
first reading; `matchingResolver` with the identities of the document Nova holds for a re-read,
which `identityMapParity.test.ts` holds to `externalIdentityMap`), the source project space's
lookup tables, organization levels and media files, the app strings Nova's build gives a
document, the record dialect's judge, whether the project space applies "save only if changed",
and, for an app Nova already holds, `knownCaseTypes`, the case type each index of a type reaches,
consulted only where the app itself fixes none, and `knownLanguageCodes`
(`languages.ts::knownLanguageCodesOf`), the language each stored wire code names, read before
`languageIdentityForHqCode` because a stored code is never re-minted while the minter's spelling
for an identity can change. A first reading is told neither. A test builds the input through
`__tests__/readerInput.ts` and `__tests__/novaExport.ts`, never by hand.

`matchingResolver` answers a key the map holds with its UUID and gives any other key a UUID the
map holds under no key (`identity.ts::freeEntityUuid`): a map holds a renamed entity's UUID, minted
from its old key, under its new one, so an entity CommCare HQ later adds under the old key must not
take it. A canonical row that gives an entity the UUID a re-read gives it asks
`identityMap.ts::reReadUuidOf` (the same rule over the document's own map, `identity.ts::matchingUuidOf`)
or claims through a matching resolver over the document's entities of that kind
(`worldEntities.ts::heldResolver`), and never calls `mintEntityUuid` itself.

A document holds a media slot's asset and no path, so a projection prints each asset at one path,
the first in code-unit order of those the source spells for it (`projectionInputs.ts`). Where
CommCare HQ holds one file under several paths, every comparison of a stored media path reads it
through `projectionInputs.ts::keptMediaPaths`, so no comparison depends on which path is kept: the
first publish keeps one by its own rule (`assignMediaPaths`, which first drops a path it cannot
hold, and declares each move), not necessarily this one. The media reader
holds several paths the index resolves to one asset as that one file (`xform/media.ts`).

A stored text or media map is read as each language shows it, never taken literally. A menu's,
form's, case list item's or Register button's media map is read through
`menus/navMedia.ts::shownNavMedia` (HQ's `NavMenuItemMediaMixin`: a language with no path of its own
shows the `default` table's, and `use_default_*_for_all` shows the first language's everywhere), an
app string's through `hqText.ts::shownText` (but the search title, which HQ's build reads per
language and not through `clean_trans`, through `search/settings.ts::shownTitles`: a language with
no title of its own shows the first language's), and a form's itext by its default translation
(`xform/itext.ts::ItextReading.defaultLanguage`: the first language's where the form holds it, else
the first it holds): a language whose translation lacks a text, its default value, a media form or
the whole translation shows the default's, the source language included, and a blank beside the
default's text is the form builder's to fill from it (`prose.ts::finishText`). Only two such
absences keep a form out: a text the default translation holds no default value of, and a
question's or choice's label with no value in the source's first `<translation>` in document
order, whatever its language, which HQ's build reads every label in
(`itext.ts::ItextReading.buildRefusesLabel`). A protected validation message's `__nova_` forms
are read the same way, form by form, as Core merges the default locale's keys under each
language's (`xform/afterBinding.ts::shownForms`), and its `jr:constraintMsg` is rebuilt over the
branches the source holds, in the order it tests them, each the message of the language whose
forms name it (`messageBranches`), never over the document's languages: CommCare HQ rewrites
neither when it adds, renames, reorders or removes a language. So a language HQ added after the
publish, one that lacks the forms and one holding the default's copy a save in HQ's form builder
writes show the default's message through the default's branch, and the branch of a language HQ
removed, which no language's forms name, is rebuilt from the stored expression alone
(`rebuiltMessage`), whether the source keeps that language's translation or a save in HQ's form
builder dropped it, since no language a device shows reads it. A text's `markdown` copy is read the
same way (`prose.ts::claimMarkdown`): a language whose text lacks it shows the default's copy where
a runtime asks for it and its own value elsewhere, and one whose text holds it beside no value shows
its copy and the default's value, so the copy is held where each language shows one text (the
default's copy, or a blank, as the value; the default's value as the copy) and refused where the
two differ. Nova then prints every language's text or path in full, so a
first publish fills the languages a stored map or translation left out: a media map's under
`media-maps-respelled`, which `navMedia.ts::recordRespelling` records with each stored map Nova
writes again, and a form's under `forms-and-settings-rewritten`.

Every app string a reading holds (the app's, a menu's and a form's name, a case list menu item's
and a Register button's label, a column's header, a mapping's label, an interval's text, a Search
field's texts, the search screen's title and subtitle, and a text a generated key folds over) is
held through one function, `heldText.ts::heldText`, by its translation unit's role: what a device
shows is the bar (`hqDeviceText`: HQ's build writes a blank text as a non-breaking space, a line
break as `\n` and a `#` no backslash precedes as `\#`, and Core's locale reader ends a line at a
carriage return and trims its end before it reads `\#` as `#` and `\n` back, so a line break at a
text's end is shown and its spaces are not, the two characters `\n` show as a line break, a
backslash before `#` does not show, and nothing after a carriage return shows), each text is held
as a device shows it (the text before a carriage return, each `\#` a `#`, each `\n` a line break,
`holdText`) less the characters
up to U+0020 at both ends unless it is only spaces, and for a role whose translation is never blank
(`translationRoleRequiresNonblank`) a blank-looking language beside a source that holds text takes
the source's text. A Search field's validation message is held apart from the runtime guard's text
joined after it (`search/prompts.ts::readValidation`, `search/guardSplit.ts::sharedGuardText`); where
no language's message tells whether the guard is joined, the whole test is the rule, its refusal
waits for the search settle (`PendingExpression.deferRefusal`), and a test ending with the guard the
projection joins to the field (`search/settings.ts::runtimeGuardEnding`) is `unrecognized` at its
message, which keeps it out, rather than refused for the guard's reads, and the rule before the
guard is read on its own, its refusal standing beside the message's where Nova cannot hold it
either (`search/index.ts::untoldRuleRefusal`). A
respelling no worker meets is recorded under the surface's own id (`names-respelled`,
`list-settings-respelled`), and one a worker meets under `text-spaces-dropped`
(`heldText.ts::recordTextRewrite`). A text whose rest after a carriage return is a line that
defines an app string (`keyDefinedAfterLineEnd`) is refused under
`app-text-holding-a-carriage-return-whose-rest-defines-an-app-string`: a held text where its
rewrite is recorded (`heldText.ts::recordTextRewrite`, which every held text with a carriage return
reaches, or `refuseLineEndKey` where another register records the rewrite, a Register label's
`registration-label-fixed`), at the app, menu, form, case list or search the pointer names; and at
its own key every value of an app language's `translations`, whatever the key names, since HQ's
build writes each non-empty one into the language's file (`appShell.ts::readTranslations`), the
search screen's title, and each text compared with HQ's default (a detail's empty-list and continue
texts, the Search button's label, an image map's alt text). A text a device shows none of (nothing
after the line's key before a carriage return), one a device shows with a backslash before `#`
(two backslashes then `#` stored), or holding a character XML cannot hold has no spelling the gate
admits and is left unclaimed, and so is a text of a role some screen reads through Core's argument
filler (a menu's or form's name, a case list menu item's or Register button's label, a Search
field's label) holding a `${` that screen shows otherwise (`localeFile.ts::argumentScreenIssue`,
applied by `heldText` per role); a generated key folded over one is refused
(`assemble.ts::decideGeneratedKeys`); every other fold is held as a device shows it, a choice
label's too. The app's `name` is also the profile's `name`, which Android's app picker shows as
stored, so one holding `\n`, `\#` or a carriage return stays `unrecognized` (`appShell.ts::holdAppName`);
a form's name read with a line break is written into its `<h:title>` and data node, which no screen
a worker reads shows (part 09's decision table). A comparison of a stored text with Nova's print
compares both as held, and a text compared with HQ's default (a detail's empty-list and continue
texts, the Search button's label) is the default where a device shows the default in every
language, its map respelled by the first publish under `list-settings-respelled` where Nova writes
it another way. Blank is what a device shows (`hqDeviceText`), never JavaScript's `trim`: an image
map's alt text and the search screen's title read U+001F as blank and U+FEFF as text. A form's
itext is no app string: Core trims a value at both ends as it parses the form, so it is read as stored.

What the project space holds rather than the app (levels, worker and location properties) is read
from what the reading is told and what the logic reads, so its canonical rows run the reading's
own functions (`worldEntities.ts::levelsFromHq`, `worldEntitiesFromReads`) over what a document's
publish gives them (`levelsAsPublished`). Of worker names that differ only in capitalization, which
CommCare keeps apart and HQ's user-data schema and the gate hold as one, a reading declares one
property (`worldEntities.ts::heldWorkerSlugs`: the first written in code-unit order, else the first
read) and holds each read of another as the name-backed read of its slug, which prints the same
source. An entity a reading mints that the document did not hold
(a worker property for a field read by name) takes the UUID a re-read of the app mints under the
app's own id, so a test that reads Nova's export whole passes `matchingResolver(doc.appId, …)`.

## The source language

The app's first language is its default. Its source language, whose text the document's own
slots hold, is the first language, in `langs` order, that a reading with it as the source prints
back at every place Nova's emitter writes the source's text apart from a translation
(`languages.ts::readingSourceCode`); where nothing in the app tells the languages apart it is the
first, and the first too where no language passes. `languages.ts::sourceLanguageAsRead` applies
the rule to the values Nova's emitter writes for a document (`expander.ts::expandAppShell` and
`hqJson/caseList.ts::projectCaseListForHq`), so the canonical row `source-language-is-as-read`
moves a document only to a language whose text at both places is its source's, and the two print
one export.

The places that tell, each held by a pair in `__tests__/readingSource.test.ts`:

- **The app's name.** HQ JSON's `name` is the source language's name, and a language's
  `translations[<code>]["app.display.name"]` and `homescreen.title` are written only where its
  name differs (`expander.ts::appLevelValues`). A language holding a non-empty
  `app.display.name` other than `name` is not the source, unless its rest after a carriage
  return defines an app string: no export holds that, and the reading refuses it at its key
  whatever the source (`appShell.ts::readTranslations`), so it tells nothing.
- **Nova's own sentences.** A system unit's source is Nova's sentence (`lib/domain/translationUnits.ts`:
  each Search runtime guard's message, the required message of a Search field with none of its
  own), so the source language's text for each one the app's searches print is the sentence
  (`search/systemSentences.ts::systemSentenceHolders`).

The places that look as if they could and do not:

- every other language map of HQ JSON (a menu's, form's, column's or Search field's texts) and
  every itext text is one projection of each language's text (`localization.ts`), the same bytes
  whichever language holds it as the source; a missing or stale translation prints the source's
  text, which a reading reads as no translation whatever its source;
- itext's `default` attribute, a form's `<h:title>` and its data node's `name`, and the form
  builder's fill (`lib/domain/translationFill.ts`) mark the default language, `langs[0]`, never
  the source;
- media is one per slot for every language (`media-is-shared-across-locales`);
- a translation whose prose references differ from the source's, or a required text left blank,
  prints the source's text (`translationUnits.ts::translationValueIntegrityIssue`), so no export
  holds such a difference;
- the local `.ccz` writes each language's own name under `app.display.name`, but the reader reads
  HQ JSON.

## Known conservative refusals

Shapes CommCare HQ can give that the reader refuses rather than holds, each with a true finding.
A change that holds one removes its line.

- **A carriage return in an app string whose rest defines another app string**: refused under
  `application-and-settings/app-text-holding-a-carriage-return-whose-rest-defines-an-app-string`
  at the text's place, or at its key in `translations` (`heldText.ts::refuseLineEndKey`,
  `appShell.ts::readTranslations`). Core reads that rest as a line of its own, so it sets the
  wording of the string it names, which no document holds and Nova, printing no carriage return,
  would drop. Where a text a device shows none of (nothing before the carriage return) is read
  depends on the place. A text held through `heldText.ts::heldText` (a menu's or form's name, a
  column's header, a Register button's label, whether or not another language holds the blank
  HQ's build fills) is left `unrecognized` instead, since `holdText` admits no spelling of it
  before its rewrite is recorded. The app's `name` (`appShell.ts::holdAppName`), a `translations`
  value (`readTranslations`) and the texts checked at their own key (the search screen's title,
  the Search button's label, a detail's empty-list and continue texts, an image map's alt text)
  check the rest first, so such a text there is refused under the line-end entry.
- **An app `name` holding the two characters `\n`, a backslash before `#` or a carriage
  return**: `unrecognized` at the app, `name` (`appShell.ts::holdAppName`). The profile's `name`,
  which Android's app picker shows, carries it as stored while the app strings show a line break,
  `#` alone or the text before the carriage return; Nova prints one name into both.
- **An app string a device shows with a backslash before `#`** (two backslashes then `#`
  stored): `unrecognized` at its place. Core shows one backslash then `#`, which only a text
  holding a backslash before `#` spells, and the gate refuses that
  (`localeFile.ts::localeFileValueIssue`).
- **A menu's or form's name, a case list menu item's or Register button's label, or a Search
  field's label holding a `${` some screen reads as a placeholder**: `unrecognized` at its place
  (`heldText.ts::heldText`). Android's menu list, action bar and Search screen and every screen
  title read the text through Core's `Localizer.processArguments` (`Visits ${0}` shows as
  `Visits`), while Web Apps' menu list shows it as stored, so no text Nova holds shows alike on
  every screen, and the gate refuses each (`localeFile.ts::appStringValueIssue`).
- **An after-submit link's condition or carried value that prints as the source only with a
  rewrite withheld**: `unrecognized` at the form, `schema:FormLink.xpath` or
  `schema:FormDatum.xpath` (`menus/afterSubmit.ts::compareLinks`). The links are compared with
  the expansion's print, which applies every rewrite, and no held level reaches that print.
- **Nova's own owner clause in a case list filter respelled by hand in CommCare HQ**, beside a
  search that stores the owner list: refused under
  `case-search/blacklisted-owner-ids-expression-without-that-clause` at the search
  (`search/settings.ts::readSearchSettings`, `holdsOwnersWithoutClause`). Only Nova's spelling
  tells the clause from an authored condition (`isOwnerClause`), and Nova's print would write the
  clause again beside the respelled one.
- **Two rewrites that print at one node, one inside the other's spelling, each spelled otherwise
  than the source**: refused under the slot's own entry (`expressions/index.ts::siteLevel`). No
  single site's flip moves the first difference on, so the search finds no level.
- **An ancestor read across a pair of case types the app links under several names, where no
  one name is on every case it links, or the one name its child links use is not**: refused at
  the reading slot, the checker's `relation-ambiguous` reason `ancestor-link-names`
  (`lib/domain/advancedModule.ts::ancestorWalk`, the gate's `FORM_CASE_READ_ACROSS_SEVERAL_LINKS`).
  A walk through any one name reads blank for some case, or a case other than the one a worker
  chose. Where every create writes the several names, the read is held and walks the child
  links' name, else `parent`, else the first in document order.
- **A create keyed by an answer in a form whose changes stand in no order the gate admits**: one
  finding at the form under
  `questions/a-keyed-savetocase-create-in-no-order-nova-holds-beside-the-form-s-other-changes`
  (`caseManagement/index.ts::settleOperationOrder`, over the gate's own
  `caseOperationWireOrderViolationDetails`). The reading first holds the order HQ's lists give
  where the gate admits it, else moves changes only as far as what prints one source allows
  (`caseManagement/operationOrder.ts::inWireScopeOrder`), so the finding stands only where no order
  Nova writes is admitted: a keyed create in a repeat beside a change at the root (HQ's
  `usercase_update` turned on beside Nova's export of one), or a later change in its repeat row that
  may be of its case. The gate refuses these because HQ's server applies a case's create before its
  other changes while a device applies them in form order, and it cannot prove the two cases apart.
- **Names of the world that differ only in capitalization, where the gate holds one**: a write of
  the worker's record to a second such name is refused at its form under
  `forms-and-case-writes/a-write-of-the-worker-s-record-to-a-key-no-worker-property-takes`
  (`caseManagement/index.ts::refuseWritesOfFoldedWorkerNames`); a `location_data` read of a second
  such name, or of one the gate refuses for a location property, under
  `expressions-and-data/a-read-of-a-place-s-location-data-under-a-name-no-location-property-takes`
  (`worldEntities.ts::locationDataNameRefused`); and a level whose name a level already placed (parent
  before child, siblings in HQ's order) spells in other letters only is `place-not-holdable`
  (`worldEntities.ts::levelsFromHq`), while a level left out for another reason takes no name and
  refuses none. CommCare HQ's
  user-data and location-data schemas hold one slug of such a pair as well
  (`CustomDataFieldsForm.verify_no_duplicates`), so neither a worker property nor a location
  property can take the second name; HQ holds two level names apart, and the gate does not.
- **A Save to Case block that gives a case another type beside a change that may read it as the
  earlier one**: one finding at the form under
  `questions/a-savetocase-change-of-a-case-s-type-another-change-of-the-form-may-read-as-its-earlier-type`
  (`caseManagement/index.ts::settleOperationOrder`, over the gate's own
  `caseOperationTargetTypeOrderViolations`): a create keyed by an answer of a type other than the
  form's loaded case beside Case Management's change of that case, or a `case_type` row on a case a
  later change reads as its earlier type. A keyed id may name a case an earlier submission made, and
  a device and HQ's server both give a case that exists the type its create names, so Nova cannot
  prove the later change is of another case.
- **A Save to Case update of the worker's record in a condition group or in a repeat**: one finding
  at the block under
  `questions/a-savetocase-update-of-commcare-user-under-a-condition-or-inside-a-repeat`
  (`caseManagement/saveToCase.ts::readBlock`). HQ's form builder takes both, and Nova keeps a form's
  writes of the worker's record in one update that runs once on every submission (the gate's
  `worker-record-facet`).
- **A Save to Case update of the worker's record beside another update of it in the same form**
  (CommCare HQ's `usercase_update`, an advanced form's load of the worker's record, or a second
  such block): one finding at the form under
  `questions/a-savetocase-update-of-commcare-user-beside-another-update-of-the-worker-s-record`
  (`caseManagement/index.ts::settleWorkerRecordWrites`, asking the gate's own
  `validateCaseOperations` for reason `worker-record-twice`). A device and HQ's server apply both in
  the form's order, and Nova keeps a form's writes of the worker's record in one update, which
  prints one block.
