# lib/commcare/reader

`readHqApp` (`index.ts`) reads a CommCare HQ app into a Nova document, or into an account of why
it cannot be held; `readHqAppSteps` is the same reading stopping after each stage, and inside a stage long at the
byte cap between its parts (`index.ts::STAGE_PARTS`: the forms, the case lists, the entry facts,
the binding and every pass of the expression stage inside it, the case management settle, the
menus' settle and the assembly), which a request drives a piece at a time so the event loop turns
between them, and a stage therefore keeps nothing outside the reading's own context across a
stop. `STAGES` stays each stage whole, for a test that runs stages one by one. A grammar read
(`syntaxRead.ts::readFormSyntax`) is answered from the tree an earlier read of the same text gave
(`heldByText.ts`), copied, so each read still has its own nodes. A form's XForm text is parsed once
(`xmlParse.ts::heldXmlParse`, a frozen document shared with `hq/publishedCaseBlocks.ts` and
`hq/sourceIdentity.ts`); the ledger tells forms apart by their document, so a second form of the
same text in one reading reads a copy. The emissions a reading compares with (the entry facts'
and the menus' settle) go through `projectionInputs.ts::readExpansionSteps`, which answers from
`ReaderOptions.heldExpansions` (`heldExpansions.ts`) where another reading of the same request
emitted the same settled document under the same projection inputs, compared in full; a bring-in's
first reading and its fixed point's re-read share one. `lib/commcare/CLAUDE.md` ("The reader",
"Reading expressions", "Reading case management back") states the accounting, the stage order
and the expression contract; this file is the method a change here keeps, the canonical rows,
and what the reader is told.

`ReaderOptions.onStage` is told each stage's index in `STAGES` before it runs, then `close`; a
caller that catches a throw names where it came from by the last one it was told, never by the
thrown message, which can quote the app.

## The work a reading does

A reading's work is counted, never timed: every part of every stage runs under the reading's
work meter (`lib/commcare/workMeter.ts`), which the reader's few doors charge by the size of
what each handles: a grammar read its text's characters (`parse`, `syntaxRead.ts`), a
candidate document the objects it makes and freezes (`propose`, `candidate.ts::withCandidate`),
a print the characters the XPath and XML serializers write and the documents an emission plan
reads (`print`), a comparison the nodes it compares (`compare`, `jsonCursor.ts::sameJson`,
`syntaxCompare.ts`), and a walk the reader makes of a collection the source holds the members it
examines (`visit`). `ReadWork` carries the units by door beside the reading's limit, which is a
function of the source's size alone (`work.ts::readWorkLimit`: `READ_WORK_BASE` and
`READ_WORK_PER_SOURCE_CHARACTER` a character, each set at four times what a measurement saw,
which `__tests__/readWorkLimit.test.ts` holds every retained base and published document under a
quarter of). A charge past the limit stops the reading, and `readHqAppSteps` alone turns that
stop into its outcome: an account of one finding at the app, `too-intricate`, the same on every
run. This includes the final walk of unclaimed keys and XML nodes. A stopped reading reports its
work and claims where it stopped. It does no further accounting. A request's signal (`ReaderOptions.signal`, or the request's own meter, which a reading's
meter charges as its parent) stops a reading at its next charge, and the stop is thrown to the
caller. A stop is sticky, so a meter that stopped throws at every later charge, and every
`catch` in the reader rethrows it first (`rethrowWorkStop(error)`, which a Biome plugin,
`lib/lint/workStopCatch.grit`, requires as the first statement of every `catch` here but
`index.ts`'s).

So a stage keeps its work linear in what it reads: it decides a choice from that choice's own
evidence and prints the whole once to confirm, and never builds the set of combinations of
independent choices (the search settle chooses each Search field's rule on its own printed
property, `search/settings.ts::settleSearchSettings`), and a lookup inside a loop over a
collection is an index built once (a language's shown text, `hqText.ts::shownText`; the menus by
id and the parent selections a build walks, `menus/modules.ts`, `hq/entryFacts.ts`; a
reading's findings, `Accounting.findings`, `findingCount`, `findingRaised`; the first child of a
name for bind and control paths, and repeated sibling names, `xform/model.ts::readDataTree`).

What the source hands the reader is held to three rules at the reader's own doors, never at a
call site. A collection of HQ's objects is read whole or not at all: `JsonCursor.list`, `map` and
`coveredList` (and every raw read of such a list, through `jsonCursor.ts::objectMembers`) take a
list or map only where every member is an object, so a cursor's index is always the member's
stored position, and any other collection is left unclaimed for the close (a bare-string update
map is refused at its key, `basicActions.ts::readUpdateMap`). A table looked up by a name the
source supplies (a column's format, an appearance, a `vellum:role`, an element's name, an upload's
media type, an after-submit word) is a `lib/commcare/sourceKeys.ts::SourceTable`, a `ReadonlyMap`
made by `tableOf`, so a name every object inherits (`constructor`) answers nothing and takes the
site's ordinary verdict for an unknown name. A record built under names the source supplies (a
language's texts, a mapping's labels, a table's columns, the claims a reading registers) comes from
`lib/domain/records.ts::recordFromEntries`, with no prototype, so `__proto__` is an entry like any
other; an absent one reads as `NO_ENTRIES`, and a record the reader did not build (a document it is
told) is read under such a name through `ownRecordValue`. Every object of HQ's JSON comes in with no
prototype (`lib/commcare/hq/jsonText.ts::parseHqJsonText`, which also reads the JSON a form's source
holds), and so does every element's attributes (`xmlParse.ts`). A Biome plugin
(`lib/lint/sourceKeyedRecord.grit`) refuses, here, in `lib/commcare/hq` and in the reading code of
`lib/deployment`, the forms that build a record with a prototype (`{}` typed as a record, `?? {}`,
`Object.fromEntries`, a computed key, an object literal typed as a table). And a name an app supplies is cut once, where the
finding is made (`hqFindings.ts::cutFindingName` and `shownPlace`, over
`lib/publish/shownText.ts::cutShown`: 200 characters and 800 code units), so no caller cuts one
first. A form's text past what one parse builds (`xmlParse.ts::XmlLimits`) is `unrecognized` at
the form, and an app whose forms together pass a reading's total never reaches the reader
(`lib/deployment/reading/gather.ts::formsWithinReading`, `too-large`).

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
whose value is `undefined` is absent, as JSON leaves it out. Two XML elements are compared whole
through one equality, `sameElement.ts::sameElementWhole` (name and namespace, attributes as sets, own
text trimmed of XML's whitespace, children in order).

A claim that covers a stored subtree under a held entry (`XmlCursor.takeSubtree`, `derivedSubtree`)
hides every node under it from the close, so it stands only where the subtree was compared whole with
the element the emitter builds for the reading, or every node of it was read: a Connect block against
`xform/builder.ts::connectBlockData` over the slots read (`xform/connect.ts`), a Save to Case block, a
bind on an attribute and a leaf of the region by test 4 (`caseManagement/saveToCaseCompare.ts`), an
itext media value against `itextMediaValues`' element for the path read (`xform/media.ts`), a
markdown copy and a protected message's forms by their attributes beside the content compared
(`xform/prose.ts::claimMarkdown`, `xform/afterBinding.ts`). A setvalue of a case region and an
itemset's `label` and `value` are claimed node by node, only the nodes the reading read
(`saveToCase.ts::claimSetvalue`, `options.ts::settleCaseChoices`), so anything else is reported at the
close. What a source element does is read as Core reads it, never as Nova would print it: a setvalue's
target (`xform/model.ts::heldSetvalueRef`: `bind` before `ref`, a relative `ref` from `/`, an attribute
of the name in any namespace but the form builder's, a text value where `value` is absent), a
control's node (`xform/body.ts::coreControlPath`: `bind`, then a repeat's `nodeset` or any other
control's `ref`) and a bind's (`nodeset` alone), and only Nova's one spelling of each is held.

Four rules hold everywhere here:

- **Pure.** The reader reads only its arguments, changes none of them, and never throws for an
  app's content. The identity resolver an input names holds nothing: the keys a reading claims are
  its context's own (`ReadContext.identities`, `identity.ts::claimsUnder`), so one input object read
  twice, or read frozen, reads alike (`__tests__/readerPurity.test.ts`). Content
  it cannot hold is a finding, and what the reader itself got wrong is a `ReaderDefect`
  (`defects.ts`), logged and never shown. A throw is left only for a caller's broken input (menus
  from another reading) or a broken invariant of the reader's own.
- **One pass.** Every finding of a reading is reported at once: a stage that refuses something
  keeps reading the rest, and the expression stage binds every slot over a provisional document
  built whether or not a finding stands (`provisional.ts`).
- **Claimed or unrecognized.** A stage reads nothing it does not claim against a manifest entry
  (`claims.ts::defineClaims`), and whatever is left is `unrecognized` at the close. A held claim
  that takes a value whole (`take`, `derived`) stands for the keys each of HQ's objects in it
  declares, never for one it does not: such a key is claimed by its class's rule
  (`jsonCursor.ts::registerUndeclaredKeys`, the same rule a stage visiting the object applies)
  or reported at the close. Every claim that takes a value whole, or reads past it (`drop`,
  `account`), is recorded also at each key of each of HQ's objects inside it that holds a value
  other than its class's default and that the claim's entry names, at the key's own pointer
  (`jsonCursor.ts::within`; a key the class does not declare, under a claim that reads past it,
  as `schema:<class>.<undeclared>`), so the entry of a container read whole names each key inside
  it the lane's parity reads there (the reference details HQ never builds, an inactive case
  action under its form's type, a hidden case list menu item). A key at HQ's default is no use, and a claim on one is recorded, with
  no surface key, only under a kept entry or where it takes the value whole under an allowing
  entry with a value class (`accounting.ts::claimAtDefault`): a stage picks such an entry by the
  value it read, so it claims under one only a value of that entry's class, and leaves a key at its
  default unclaimed rather than name a class the default is not of (the keys of a search a menu
  does not offer, `search/index.ts::deriveInactiveSearch`). A claim names the surface key whose value it reads and is recorded
  where that value sits: an update map's entry refused for its key, or read through the cases
  above, is recorded at the map (`refuseMapEntry`, `holdMapEntry`), the key in `detail.name`;
  a claim on a key that names the schema key of an object above it (a profile setting refused
  under `schema:Application.profile`, a language's key under `schema:Application.translations`)
  is recorded at that key (`jsonCursor.ts::recordedAt`), as is a whole object read past under
  such a key (`refuseWhole` with `account`: a language the app does not hold) and a media
  reference with no file, at the app's `multimedia_map` (`lib/deployment/reading/gather.ts`), and
  so is a part of a value refused
  beside the key's own claim (`refusePart`, a `logo_refs` slot); a claim on an element that names
  one of its attributes is recorded at the attribute, and one naming an itext form at the
  `<value>`'s `form` (`xmlCursor.ts::recordedNode`, a media form's hand-off too), while the
  `<value>` element itself, a text's value whatever form it names, stands under the text value's
  claim (`xform/prose.ts::claimFormValue`). A form's frame is claimed element by element under
  the key used there (`xform/parse.ts`: the model, the main instance, the itext block), and the
  XHTML wrappers Core passes over, like an attribute of an instance's content Core copies as
  answer data, are part of a claim with no record (`xmlCursor.ts::partOf`). A claim that covers a
  subtree of a form is recorded also at each node in it the lane reads, under the key the lane
  names that node by where the claim's entry names it (`xmlCursor.ts::within`: a Save to Case
  block, a Connect block, a translation for a language the app does not hold, an itemset's `copy`),
  and a refusal or an account covering an element stands also at each attribute under it whose
  key its value spells (a setvalue's `event`, an `appearance`) where its entry names that key
  (`xmlCursor.ts::findingWithin`). A finding that is a relation, made of one value, stands also
  where that value sits: in a form, at the node whose value makes its class
  (`Accounting.findingAtNode`: a control's `ref` whose data node sits under another repeat, a
  data node holding text, a repeat a worker adds rows to inside a question list, a model
  iteration's `vellum:role`; a data root's `uiVersion` other than `1` and a data root named other
  than `data` stand at the data root, whose key the entry names), and in the app's JSON at each
  node its class reads around the value (`Accounting.findingAt`: a form's name, its stored
  after-submit word, the language list, the menu order, a menu's display condition, a detail's
  tabs and its tile's cells and template, an empty case list's details, a key a search's request
  carries twice and a name a default filter shares with a Search field). A subtree refused for
  one node in it records its refusal at that node (`XmlCursor.refuseSubtreeAt`: a Save to Case
  block's attachment or reserved row and a case element no role marks, and a guard under its
  block's), an object refused under a narrower class is recorded under the wider one it is in
  too (`JsonCursor.alsoOfClass`: a mirror under a mirror menu is a version 2 mirror), an entry
  that names no surface key records none, its slot standing under the slot's allowing entry
  beside it (`Accounting.claimEntry`, `expressions/index.ts`), and a claim's reach and a finding's
  class add no record of the app's JSON that one already stands as (place, key and entry). Every
  record names no key, or a key its entry names that names the node the record stands at
  (`Accounting.#recordKey`; in a form, `xmlCursor.ts::keyNamesNode`, the lane's naming of a
  node: an attribute by its own name, an instance's node by the most specific item its depth
  matches, any other element by its last step). A claim under a key its entry does not name is
  the defect `key-not-named` and records nothing, but where its caller makes it `keyless`
  (`Accounting.claimEntry`: an expression's refusal whose entry names neither the slot's key nor
  a use's, `provisional.ts::claimExpressionEntry`, a search row's refusal at its value,
  `search/rows.ts::claimRowKey`); a claim whose key its entry names but whose node that key does
  not (a refused question's itext, binds and control, which the refusal reaches past its own node)
  is recorded under the entry's key that names the node, else with no key; and a claim's reach
  records a node only under the first of its keys that holds (`Accounting.within`). So what a
  refused Save to Case block reaches, its binds, setvalues and wrappers, is part of the refusal and
  recorded only at the key the lane names each node by where the refusal's entry names it
  (`caseManagement/saveToCase.ts::reachNode`), and a declaration only a refused expression reads
  stands under that expression's finding (`provisional.ts::claimDeclarations`). A Save
  to Case region's nodes, binds, setvalues and controls are each recorded by place
  (`caseManagement/saveToCase.ts::regionKey`), with the type HQ's question reader gives a node of
  it, and no record names a type HQ's reader never gives (`mug:SaveToCase`, `mug:Connect*`).
  Every output of a text is claimed with its namespace, and an output of a markdown copy or of
  another language as its source twin is, under every claim the expression stage made of the
  twin (`xform/prose.ts::claimTwin`); a text Core parses that no slot holds (the emitter's own
  texts in a Save to Case region, an output of a translation the app does not hold) is
  registered for the uses its syntax makes alone (`pendingExpressions.ts::PendingExpression.usesOnly`).
  So is every attribute Core parses as XPath (the surface's `parsedAs: xpath`) that a claim read
  and no registration holds whole, as the expression stage opens: a reference path (a bind's
  `nodeset`, a control's, a setvalue's or an itemset part's `ref`, an itemset's `nodeset`, a
  repeat's `nodeset` and a count no slot reads), the logic written on a node no question holds,
  an output of a text no slot reads, and a value a slot reads only a part of (a model iteration's query in its `join`, an itemset's
  filter, a Save to Case row's trim), whose part keeps its own uses and whose whole claims each
  use no other claim at the node names (`xform/attributeUses.ts`, `Accounting.claimEntry`'s
  `unlessClaimed`). Such a text is read in the logic of its form's first field, since a path's
  uses are classed by its form's rules alone.
  A secondary instance's source is recorded at its `src`, and its id under
  `xform:model/instance@id` (`provisional.ts::claimDeclarations`). A search row's key is
  recorded at its `property`, and the class its Search field's presence test chooses it in at
  its value (`search/rows.ts::claimRowUses`); the CSQL a row uses is each text Core's
  `xpathStrings` gives the row (`expressions/csqlRead.ts::sentTexts`), a key in every class those
  texts give it (`accounting.ts::claimEntryClass`). A text holding a hashtag, which Core's lexer
  refuses, is used for its hashtags alone (`expressions/surfaceUses.ts::xpathUses`). The slots
  HQ's build reads through `xpath.py::interpolate_xpath` are a menu's and a form's display
  condition, the case list's filter, a detail tab's filter over a case type's children (a tab
  with `has_nodeset`, a `nodeset_case_type` and no `nodeset` of its own, registered for its uses
  alone, `caseList/details.ts::registerTabFilter`) and a Search field's required and validation
  conditions; in each, every pattern HQ replaces that the text holds, inside a string too
  (`#session/`, `#user`, `#case`, `#parent`, `#host`, and `$fixture_value` in a form's
  condition where its menu's lookup table selection is active), is a use under its own key,
  found by the text as HQ's replacement finds it (`surfaceUses.ts::shorthandUses`; a `#case` in the
  class of a menu's case named by its slug where the text holds `#case:`), and no other
  slot holds one: the lane reads the same slots (`proof/checks/manifest_usage.py::_interpolated`).
  The text is the one HQ interpolates at the node the claims are recorded at
  (`PendingExpression.slotText`): the whole stored filter where a registration reads the operand
  beside an owner clause or the clause alone, a Search field's whole condition beside a rule read
  apart from Nova's guard; where that whole text holds a hashtag, Core refuses the slot, so its
  uses are its shorthand alone; and an owner clause recorded at the menu's `case_details` makes no
  shorthand use (`expressions/index.ts::registrationUses`).
  A question's data node is recorded under the type CommCare HQ's question reader gives it
  (`xform/hqQuestionType.ts`, a port of `xform.py::VELLUM_TYPE_INDEX`, which compares each field
  exactly), under the entry the reading holds the question by: an image upload is an Image
  whatever its appearance, a Question List a Group where its appearance is `field-list` in
  another letter case, and a typed input whose bind's `type` is spelled other than as that index
  holds it (`int`, `xsd:geopoint`) a Text.
  A language's key a runtime reads as one of its own UI
  strings is that `ui-string:` item, claimed under it at the key (`appShell.ts::uiStringClaim`);
  every other key of a language's strings is data, recorded at `translations`. An expression
  refused under an entry that names the key of a use its text makes and not the slot's own key
  stands under the slot's allowing entry at its key, the refusal beside it at the use's key
  (`expressions/index.ts::allowingEntryBeside`, `ExpressionClaim.refusal`). The lane's parity
  joins the claim log to its own uses at exactly those places.
  A refused thing is refused whole: what belongs to a refused question, choice, repeat, control,
  message or block and stands elsewhere in the source (the itext its references name, its bind's
  type and logic, a refused repeat's wrapper label, the node a refused control names) is claimed
  under that refusal (`xform/refusals.ts`, `xform/itext.ts::settleItext`), and so is an
  expression's read of a text the form refuses because only expressions name it
  (`provisional.ts::applyExpressionClaim`), and so is a form's read of the results of a search
  whose instance name the reading refuses (`search/settings.ts::refusedInstanceNameOf`), the
  own close's block of a form whose case management is refused
  (`caseManagement/saveToCase.ts::settleSaveToCase`), and the list filter's owner clause of a
  refused owner exclusion, which the list compares less that clause
  (`caseList/index.ts::listDifference`), and every key a refused case list column, custom tile
  cell or callout leaves, at the key under the refusal's entry where that entry names it and
  covered by its finding otherwise (`caseList/refusedWhole.ts`); a source refused whole (blank,
  holding no question as HQ counts one, a DOCTYPE, a data root named other than `data`) refuses its form whole, so nothing
  of the form is read.
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

`canon.ts` is the canonical form of a whole document: `CANONICALIZATIONS` wraps each row of
`READER_CANONICAL_CHOICES`, then `expression-print-collisions`, which applies `canonicalExpression`
to every expression slot in its own context (`slotContext` with no Project lookup types, the
slot's print under the identity lookup naming) and drops a case list filter whose canonical tree
is `match-all`; `canonDocument` applies the list until nothing changes, and throws where it never
settles. A read back of a Nova document is compared with `canonDocument` of it, never with the
rows applied once. `__tests__/canon.test.ts` holds one pair per row with every file of both exports
equal, the local archive's included, and names the test of each row that has its own.

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
   source, naming the function that applies it;
4. derives its member from the document's own evidence and confirms it with a bounded number
   of prints of the document, never one a candidate: a row never enumerates orders or subsets
   (`menus/afterSubmit.ts::searchLinkGuardsAreCarriedValues` reads each link's order off one
   print and confirms every form with one more).

A row never parses, and never hides a difference a runtime reads: if the two members'
exports differ, the reader is wrong and the reader module is corrected instead. The contract is held
where the rows are applied: `canon.ts::canonicalSlots` takes each expression rewrite only where the
slot's production print with the rewritten node in place (`expressions/readExpression.ts::printSlotUnder`)
is the print of the slot as given (`expressions/canonical.ts::RewriteGuard`, over `settledBy`), and
tells each rewrite it withholds (`canon.ts::WithheldRewrite`, a row id and a slot kind), which is
Nova's own defect; and a respelling Changes in HQ writes into an app is written only where the app's
export is the same bytes (`lib/deployment/hqChanges/plan.ts::sameExport`).

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
refuses with no finding fails the test that made it. A stage reading
(`caseManagement/__tests__/caseReading.ts::readCases`) stops before any expression is bound, so its
draft is no document the gate can judge; every source it reads is also read whole through
`heldReading.ts` (but a source told lookup tables, which its own test holds under their context). Each compares a reading with the canonical document
(the rows applied in list order) and is never weakened, skipped or special-cased. Beside them,
`__tests__/canonicalRowsKeepExport.test.ts` applies every row of `canon.ts::CANONICALIZATIONS`, in
list order, to every document
`targetedReadBack.test.ts` reads (`__tests__/publishedDocuments.ts`, the documents and the publish's
expansion of each) and holds `expandDoc`'s output byte for byte after every row that changes the
document, since a read-back that compares documents passes a row that moves content to a place
that prints differently.

The proof lane holds the bar where CommCare HQ serves the app. Its proof 6 runs this reader,
bundled from the production code (`proof/reader/`: `laneReading.ts::readForLane`, which calls
`lib/deployment/reading/gather.ts::gatherFromHq` for a first reading and reads a read back with
`matchingResolver`), over HQ's own answers for every corpus document and every app the lane authored
in HQ's own pages (`proof/hq-apps/`), and compares a read back with `canonDocument`: a
canonicalization exists only as a row of `canon.ts::CANONICALIZATIONS`, never in the lane. Its
parity joins the claim log (`accounting.ts::serializeClaimLog`) with the lane's own manifest
classifier at the place each key's value sits, so a claim recorded anywhere else is a difference,
never a match. A record whose key names a key above the value it reads (a language's key under
`schema:Application.translations`, a language read past whole) also carries `at`, the value's own
pointer, which the join does not read and the first-publish judge's inert allowance does
(`proof/checks/parity.py::claim_places`), so an inert key's removal is told apart from a kept one's. The bundle's digest keys every judgment of the corpus, so a change here judges every
corpus document again. `__tests__/bases.retained.test.ts` holds the reading of every retained base
to the lane's `expected.json` in ordinary CI. No production module imports `proof/reader/`.

A reading records each stored value Nova writes back another way on purpose in
`ReadFacts.sameStateRewrites`, under the first-publish register's id it falls under
(`types.ts::SameStateRegister`): `SAME_STATE_REGISTERS` are the ids of a same-state rule a
comparison allows, and `FIRST_PUBLISH_READING_RECORDS` the ids a stage records where no comparison
has a rule (a Save to Case date and time in Nova's earlier spelling, a Register label with no text,
a name map, an app string a worker reads otherwise, a navigation media map, a form text written as
literal outputs, a Hidden Value's unread default, a blank-named Sort by entry, a form's title). Each
id is an entry of `lib/deployment/reading/firstPublishChanges.ts::FIRST_PUBLISH_CHANGES` whose
`applies` reads that record, the two lists together are every such entry, and the lane holds each id
to a retained base whose `expected.json` lists it (`entryCoverage.test.ts`, rule 3).

## What the reader is told

`ReaderInput` (`types.ts`) is everything a reading takes. Beside the source as HQ serves it and
the aligned menus, it carries what no export holds: the identity resolver (`mintingResolver` for a
first reading; `matchingResolver` with the identities of the document Nova holds for a re-read,
which `identityMapParity.test.ts` holds to `externalIdentityMap`), the source project space's
lookup tables, organization levels and media files, the app strings Nova's build gives a
document (each case list column named by the word the reading found it stored under, which HQ's
build names the column's app strings by, so a translation stored under HQ's id for a column's
header is judged against that id; asked of the reading's document under the declaration it
proposes, `assemble.ts::underProposedDeclaration`, since a document that declares nothing runs on
both platforms and the gate refuses content only one of them runs, a list choosing several cases
or `here()` in a calculated column), the record dialect's judge, whether the project space applies
"save only if changed",
and, for an app Nova already holds, `knownCaseTypes`: the case type each index of a type reaches,
consulted only where the app itself fixes none, and the type the document declares for each
property, which every property the reading holds takes (`catalog.ts::noteProperty`,
`declareToldTypes`) unless a question writing it gives values that type cannot hold, since no print
tells a reading a declared type and a sort's comparator, `datetime-coerce`, `format-date` and a
comparison of dates and times each lower by it (`case-catalog-is-as-read` keeps every declared type
of a property it keeps); and `knownLanguageCodes`
(`languages.ts::knownLanguageCodesOf`), the language each stored wire code names, read before
`languageIdentityForHqCode` because a stored code is never re-minted while the minter's spelling
for an identity can change. A first reading is told neither. A test builds the input through
`__tests__/readerInput.ts` and `__tests__/novaExport.ts`, never by hand.

A first reading is told no property's type, so a property no writer types takes the type the
record slots that compare it give (`expressions/comparedTypes.ts`): a comparison with a value of a
known type, through each branch of an `if`, `coalesce`, `switch` or `cond` the property stands in
(`coalesce(seen, now()) > now()` compares `seen` with `now()`), and the known type of a branch
beside it, since record branches agree on one type. A type one comparison gives a property
reaches every node that reads it: `if(c, age, 3) = weight` types `age` by the `3`, then
`weight` by the branch node `age` and `3` then type (`comparedTypes.ts::comparedTypes` scans
again over what it found until it finds nothing new). A property of the case a menu above chose
(`chosen-case-property`) is typed as a property of the row is, and a form's own slot (its display
condition, its case changes) declares it on that case's type, by the datum the form's entry
holds for it (`scanReads.ts::chosenCaseType`), as a value a device works out inside a search's
row declares it by the datums the searched menu's entry holds (`scanReads.ts::searchRowHoleReads`,
which the search stage declares before the rows bind, since `searchRowProperties` and
`searchRowRelations` read only the searched case and the cases related to it). A simple date range Search field over such a
property declares it `date` before any expression binds (`search/dateRangeGuesses.ts`), since its
print is HQ's prompt alone, and a record slot's comparison overrides that guess (an ordering against
a branch node whose values are all literals spelled as one of the two types orders that type).
A property a function's signature fixes the kind of (`format-date`'s and `date-add`'s date, a
number a sum, a product, a negation or a distance reads, `quotient`'s whole numbers, and the value
`datetime-coerce` reads, which tries text before a date and a date and time) takes the first type
that position admits under which every slot reading it binds, passes its checker and prints the
source (`comparedTypes.ts::requiredTypes`, `expressions/index.ts::withRequiredTypes`), every
position that reads the property deciding the order together (`comparedTypes.ts::mergedCandidates`:
the type a list's numeric sort tells first, then each position's own order, of the types every
position admits); two
untyped properties ordered against each other take one type in the same try, since the checker
admits neither alone, and so do the properties of an ordering whose two sides, a branch node among
them, give only untyped properties (`comparedTypes.ts::orderedProperties`, a date tried before a
number, `seen >= coalesce(seen)` among them), two untyped properties compared, each side itself or
through a value-giving branch, take a date and time first where only the print a device makes of
two moments is the source's (`expressions/index.ts::withComparedTypes`), and where no type holds
while the slots' other
untyped properties stay text (a `date-add` of two of them), the try is made again with each of
those at the first type its own position admits, typing only the property tried.

**Where a literal spelled as a date or a date and time is typed.** A typed date or date-and-time
literal prints the text the untyped literal of that text prints, so which one a record slot holds
is decided by the position it stands in, never by the print, one rule for the reader and the
canonical form alike: it is typed by its shape exactly where its position requires that type, and
untyped everywhere else (`expressions/temporalLiterals.ts::typedWhereRequired`, which every bound
record slot passes through, a search's CSQL rows included). A position requires a date or a date
and time where the checker refuses the text there: the date a function's signature takes
(`format-date`'s and `date-add`'s), an operand compared with a value of that type or ordered
against a value of no known type (a `between`'s bounds against its subject, and a literal or a
branch node of literals ordered against another, among them), the whole value of a slot that
expects one (a date Search field's starting value), and each branch of an `if`, `coalesce`,
`switch` or `cond` standing in such a position or beside a branch that gives one. Every other
position takes the text as it is: a part of a `concat`, the value of `date()`, the value of a
`datetime()` that stays one (in a comparison by day), the whole value of a slot that expects no
type (a calculated column), and a branch node in one of those with no branch beside it that gives
a type; there the reading gives the untyped literal and the canonical row
`untyped-value-literal` returns it. `in`'s values and a `switch`'s cases are typed against their
subject by `folds.ts` and the canonical row `literal-type`, and again once the subject is typed
(`typedWhereRequired`), since a subject whose own literals a later pass types is text when the
fold reads the values. A time literal is typed the same way beside a branch that gives a time, or
compared with one. A `datetime-coerce` of a literal printed as a value prints the literal's own
instant text, and is that typed literal wherever a device folds it, `format-date`'s date among
those places (`coerced-instant-literal`). A search's condition prints as CSQL, which keeps a
`date()` or `datetime()` of a literal as written, so there the literal inside one is typed by its
shape (`coerced-literal-type`). Form logic holds no typed literal: the checker refuses one
(`literal-not-spellable`).

**What a lowered comparison reads back as.** A comparison a device lowers to microseconds prints
each leaf of each side, through any nesting of `if`, `coalesce`, `switch` and `datetime-coerce`, by
one function, `lib/domain/expression/instantOperand.ts::instantLeafSpelling`: the emitter prints the
spelling (`xpath/wire/instant.ts::instantOperandWire`), the checker refuses a comparison with a
leaf spelled `refused` (`unlowerableLeaves`), and the reading of each spelling and the canonical
form both take the member `instantSpellingMember` gives it (`folds.ts::instantOperandProposal`,
the canonical row `instant-operand` over `instantOperandMember` and `loweredComparisonMembers`): a
folded literal the canonical text of its moment, a literal branch its own text, a typed date and
time or text the value with no coercion, a midnight or a text that may be a date the value's
`datetime-coerce`, and two sides neither of which is parsed (two folded literals, a day number) the
numbers they print. The row holds for every container whose tests a device lowers: a comparison,
each bound of a range (a range one bound of which prints two numbers and the other a parse reads
as the range of the members of a parsed side, `folds.ts::momentPair`), each equality of a
membership and each case test of a switch. The coercion of a value as a value is refused by the
emitter and the checker alike through `coercedValueRefusal` (a literal that names no moment, a
blank or a yes or no, a branch node coerced to a day in some branches and a moment in others), and
a value-giving node whose branches give a day beside a moment through `branchesMixCoercedDays`. A
coercion an enclosing `datetime-coerce` reads through value branches is printed by that one, leaf
by leaf, and never as a value of its own, so the rows that read a coercion as a value
(`coerced-day`, `moment-text-coercion`) leave it to the enclosing one (`readByEnclosingCoercion`);
`coerced-day` reads a coercion as `date()` exactly where `coercesToDay`, the emitter's own test,
does.

**A range in a list filter its search restates.** A device prints a range and the `and` of its two
comparisons alike, and so does a search's CSQL inside a parenthesized join; but each top-level
conjunct of the filter is a row of the search of its own, so there the range prints one row,
parenthesized, and the two comparisons two. The reading of the list's own filter keeps two
top-level comparisons apart in such a slot whatever they read (`folds.ts::conjunctsPrintAsRows`;
a value a device works out inside a row is no slot's whole source, `ExpressionReadEnv.rowValues`,
so a range there is read as one); a row reads a parenthesized lower and upper bound's comparisons
of one operand as the range (`csqlRead.ts::CsqlBinder.rangeJoin`, after a date and time's
equality, which prints as the range from its value to itself), and `search/rows.ts` takes the run
of the list's clauses one row restates, in the row's spelling or as the range the run's own two
comparisons make (the range from a value to itself, which the row reads as the equality), before
one clause in another spelling. The canonical row `range` folds the two comparisons only where the
join prints as the range (`joinPrintsAsRange`).
In the same slot the canonical row `csql-anchor-left` touches only a comparison inside a Search
field's presence test, the one part of the filter a device leaves out
(`walk.ts::substituteUnansweredSearchInputs`), which the reader reads from the search's row.
A clause that reads Search fields stands in the list filter or in an advanced field's condition by
one test, `search/rows.ts::waitsForFields`, whether a device prints nothing for it in the list's
own filter, whether a presence test or the device covers each read (a hidden field's read the
device works out among them): the reader places a row on the list filter as such a clause only
where it holds, and offers no field that holds no condition (a simple or a hidden one), and the
canonical rows `search-filter-conditions-of-a-field-are-its-own` and
`search-field-conditions-over-other-fields-are-the-filter-s` move only a clause it holds for, each
where the search's rows come out the same.
A clause a device prints (a presence test under a negation, which a device reads as never there)
is a clause of the list the case list stage reads, which a row restates. A field's conjunct whose
first field read, in the fields' order, is another advanced field is that field's
(`search-field-conditions-of-another-field-are-its-own`), where the search's rows come out the
same, as the reader's kind D tries that field's condition first.

`matchingResolver` answers a key the map holds with its UUID and gives any other key a UUID the
map holds under no key (`identity.ts::freeEntityUuid`): a map holds a renamed entity's UUID, minted
from its old key, under its new one, so an entity CommCare HQ later adds under the old key must not
take it. A canonical row that gives an entity the UUID a re-read gives it asks
`identityMap.ts::reReadUuidOf` (the same rule over the document's own map, `identity.ts::matchingUuidOf`)
or claims through a matching resolver over the document's entities of that kind
(`worldEntities.ts::heldResolver`), and never calls `mintEntityUuid` itself.

A document holds a case list column's property and not the word its `field` stores it under,
where CommCare HQ names the property by two (`name` or `case_name`, `date-opened` or
`date_opened`, `external-id` or `external_id`): both read as one property, and the reading carries
the word each column stores on each screen beside the document (`ReadDraft.identities.columnFieldWords`,
`caseList/fieldWords.ts::columnFieldWordsRead`), as it carries a form's id and a keyed create's
prefix, which the deployment's target-identity record holds (`lib/deployment/CLAUDE.md`,
"Identities") and every export to that project space prints the column under.

A document holds a media slot's asset and no path, so a projection prints each asset at one path,
the first in code-unit order of those the source spells for it (`projectionInputs.ts`). Where
CommCare HQ holds one file under several paths, every comparison of a stored media path reads it
through `projectionInputs.ts::keptMediaPaths`, so no comparison depends on which path is kept: the
first publish keeps one by its own rule (`assignMediaPaths`, which first drops a path it cannot
hold, and declares each move), not necessarily this one. The media reader
holds several paths the index resolves to one asset as that one file (`xform/media.ts`).
Each hint, validation message, group label or repeat label that references an itext file is
recorded in `unheldMedia` when its path resolves, with its question, role, language, kind and
path. Project data checks whether HQ serves the file. If a question’s label also uses it, the
draft keeps the asset on that label and the first publish discloses its removal from the other slot.

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
projection joins to the field (`search/settings.ts::runtimeGuardEndings`) is `unrecognized` at its
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
texts, the Search button's label, an image map's alt text). A text the gate admits no spelling of
(`heldText.ts::unheldText`) is one finding at the text's place, refused at its key where the key
is still unclaimed (`unheldRefusal`) and beside its claim otherwise (`refuseUnheldText`), and what
holds it is still read (a Search field keeps its place in the reading over the texts HQ's build
shows, `search/prompts.ts::promptText`), so one text is one finding: a text a device shows none of
(nothing after the line's key before a carriage return) under the line-end entry where its rest
defines another app string and under
`application-and-settings/app-text-holding-a-carriage-return-before-which-a-device-shows-nothing`
otherwise; one a device shows with a backslash before `#` (two backslashes then `#` stored) under
`application-and-settings/app-text-a-device-shows-with-a-backslash-before-hash`; a text of a role
some screen reads through Core's argument filler (a menu's or form's name, a case list menu item's
or Register button's label, a Search field's label) holding a `${` that screen shows otherwise
(`localeFile.ts::argumentScreenIssue`, applied by `heldText` per role) under
`application-and-settings/name-or-label-holding-a-placeholder-a-screen-fills`; and one holding a
character XML 1.0 cannot carry, which the gate admits in no app text (`APP_TEXT_UNREPRESENTABLE`),
under `application-and-settings/app-text-holding-a-character-xml-cannot-carry`. A generated key
folded over one is refused
(`assemble.ts::decideGeneratedKeys`); every other fold is held as a device shows it, a choice
label's too. The app's `name` is also the profile's `name`, which Android's list of the apps on a
phone shows (a carriage return or a line break there as a space), and the name Web Apps' list of
apps shows as stored, so one holding `\n`, `\#` or a carriage return, which the app's own screens
show otherwise, is refused at the app under
`application-and-settings/app-name-holding-backslash-n-a-backslash-before-hash-or-a-carriage-return`
(`appShell.ts::holdAppName`);
a form's name read with a line break is written into its `<h:title>` and data node. A form whose
`<h:title>` Core reads as other text than that name (HQ's new form holds it blank) is recorded under
`form-titles-written` (`assemble.ts::recordTitleRewrites`): CommCare Android shows the title at the
top of a saved form a worker opens again. A comparison of a stored text with Nova's print
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

- **A Save to Case block's case id that names an earlier create by the create block's absolute
  path** (`/data/…/mk/case/@case_id`), which Core resolves to the node Nova's `current()`
  spelling names: one finding at the block under
  `questions/savetocase-block-outside-nova-s-own-block-shape`, since `saveToCase.ts::readTarget`
  reads the path as the create while the block's re-emission (`settleSaveToCase`, test 4) holds the
  source to Nova's `current()` print. Inside a block's expression (a value, a condition) the same
  path is held (`expressions/folds.ts::operationId`).
- **A question's own logic (a calculate, a display condition) that reads a Save to Case create's
  id by the create block's path** (absolute, relative or from `current()`, the last two read from
  the question as Core reads them): one finding at the question under
  `expressions-and-data/a-form-expression-outside-what-nova-types`, reason
  `operation-id-outside-case-operation` (`expressions/findings.ts::readsOperationId`). Core reads
  the path, but Nova holds the read of a create's id only in a case operation's slots.
- **A carriage return in an app string whose rest defines another app string**: refused under
  `application-and-settings/app-text-holding-a-carriage-return-whose-rest-defines-an-app-string`
  at the text's place, or at its key in `translations` (`heldText.ts::refuseLineEndKey`,
  `appShell.ts::readTranslations`). Core reads that rest as a line of its own, so it sets the
  wording of the string it names, which no document holds and Nova, printing no carriage return,
  would drop. A text a device shows none of (nothing before the carriage return) whose rest
  defines an app string is refused under this entry wherever it stands: a text held through
  `heldText.ts::heldText` by `unheldRefusal`, whether or not another language holds the blank HQ's
  build fills, and the app's `name`, a `translations` value and the texts checked at their own
  key, which check the rest first.
- **A key of an app language's `translations` that is no locale record under its own name** (a
  space or a control character at either end, `=`, `#` or a line break in it,
  `localeFile.ts::isLocaleFileKey`): refused at `translations` under
  `application-and-settings/translations-key-that-is-no-locale-record-under-its-own-name`, naming the
  key (`appShell.ts::readTranslations`). HQ's build writes the key stripped and on one line
  (`commcare_translations.py::dumps`), so it sets another string than its own name there (` home.start`
  sets the target's `home.start`, `x=y` sets `x`) or none, which no document holds, and no publish carries
  it (`appStringKeys.ts::translationKeyOwner`, `not-its-own`); a key with no `=` before a `#` or a line
  break stops HQ's build, whose read-back of each language's strings raises on a line with no `=`.
- **A text a device shows none of**, nothing but spaces before a carriage return and a rest that
  defines no app string: refused under
  `application-and-settings/app-text-holding-a-carriage-return-before-which-a-device-shows-nothing`
  at its place (`heldText.ts::unheldRefusal`). The language's file defines no string under the
  key, so a device shows the default table's text where that table defines the key, and where it
  does not (the first language's text is the one that shows nothing) fails to load every language
  whose file defines it and to show the screen in the rest; Nova holds no text that shows so.
  The app's `name` holding a carriage return is refused under its own entry (below).
- **An app `name` holding the two characters `\n`, a backslash before `#` or a carriage
  return**: refused at the app under
  `application-and-settings/app-name-holding-backslash-n-a-backslash-before-hash-or-a-carriage-return`
  (`appShell.ts::holdAppName`), one whose rest after the carriage return defines an app string
  under the line-end entry. Android's list of the apps on a phone shows the profile's `name`,
  which HQ's build writes as stored (a carriage return there read as a space), and Web Apps' list
  of apps the app's `name` as stored, while the app's own screens show the app strings' line
  break, `#` alone or the text before the carriage return; no one name Nova prints into both gives
  both back. A line break inside the name is held: the lists show it as a space and the screens as
  a line break, but Nova prints the source's `name` and app strings again, so HQ's build shows
  what it showed.
- **An app text holding a character XML 1.0 cannot carry** (a control character but a tab, a line
  break or a carriage return, an unpaired surrogate, U+FFFE, U+FFFF), but at an end of a text a
  device trims it from: refused under
  `application-and-settings/app-text-holding-a-character-xml-cannot-carry` at its place
  (`heldText.ts::unheldRefusal`, `refuseUnheldText`). HQ's build refuses it as an unpaired surrogate
  anywhere (it encodes each app strings file and the profile as UTF-8), and HQ's form settings
  refuse it in a form's name (lxml, `XForm.set_name`); elsewhere HQ's build writes it into the app
  strings and, for the app's name, into a profile no step of the build parses, and Core reads both
  as text, so the refusal is the gate's alone (`APP_TEXT_UNREPRESENTABLE`), which admits it in no
  app text.
- **An app string a device shows with a backslash before `#`** (two backslashes then `#`
  stored): refused under
  `application-and-settings/app-text-a-device-shows-with-a-backslash-before-hash` at its place
  (`heldText.ts::unheldRefusal`). Core shows one backslash then `#`, which only a text holding a
  backslash before `#` spells, and the gate refuses that (`localeFile.ts::localeFileValueIssue`).
- **A menu's or form's name, a case list menu item's or Register button's label, or a Search
  field's label holding a `${` some screen reads as a placeholder**: refused under
  `application-and-settings/name-or-label-holding-a-placeholder-a-screen-fills` at its place
  (`heldText.ts::unheldRefusal`). Android's menu list, action bar and Search screen and every
  screen title read the text through Core's `Localizer.processArguments` (`Visits ${0}` shows as
  `Visits`), while Web Apps' menu list shows it as stored, so no text Nova holds shows alike on
  every screen, and the gate refuses each (`localeFile.ts::appStringValueIssue`).
- **A setvalue Core reads otherwise than an absolute `ref` and a `value`** (a `bind`, which Core
  reads in place of `ref`; a relative `ref`, which Core resolves from `/`; an attribute of either
  name in another namespace before the plain one; no `value`, where Core sets the text): one finding
  at the form under `questions/setvalue-event-xforms-value-changed-authored-xforms-revalidate`
  (`xform/model.ts::heldSetvalueRef`, `xform/logic.ts::readDefaults`). Core's reading of each is a
  default or an id Nova could hold, but not in the one spelling it prints, and a reading from the
  form builder's spelling would aim it elsewhere.
- **A Connect deliver unit whose `work_area_id` holds a fixed id**: refused whole under
  `questions/connect-deliver-unit-work-area-id-expression`, its record at the leaf
  (`xform/connect.ts`). Connect files the visit under that work area
  (`form_receiver/processor.py::process_deliver_unit`), and Nova's document holds no work area.
- **A form expression no XPath grammar reads, outside a bind** (a setvalue's `value` of `((((`):
  `unrecognized` at the question under the slot's key, with the `expression-not-written-back`
  defect beside it (`expressions/findings.ts::parseIssueEntry`, `parse:syntax`, which names an
  entry only for a bind attribute, a menu's display condition and a case list's filter;
  `provisional.ts::applyExpressionCircumstance`). No entry yet names a syntax error in a setvalue,
  an output or an itemset's filter.
- **A processing instruction in a text Core reads** (a title, label, hint, help text, alert, an
  itext or choice value, a repeat's caption, a setvalue's or an instance node's text): `unrecognized`
  at the element's place, `xform:<element>/processing-instruction()`, wherever a claim of the
  element or of a subtree that reads it stands (`accounting.ts::coreReadsTextOf`). CommCare HQ's
  build removes comments and keeps processing instructions, and Core's `getXMLText` stops at one
  (a title it starts reads null) while `getLabel` writes it as `null`; the reader reads the text
  around it. One beside an element in an element Core reads by its children alone is inert, as
  every comment is.
- **A `required` on a Hidden Value's bind**: `unrecognized` at the question,
  `xform:bind@required` (`xform/logic.ts::readBindLogic`, which claims a `required` only on a kind
  that holds one and refuses it only on a label), wherever no other reader claims it.
- **A hidden value with a starting answer and a calculation** holds both expressions.
  The bound reader records whether a later opening assignment can observe the
  starting answer in the coverage ledger. A repeat can observe the starting
  answer when its row is inserted. Neither observation changes the document.
- **An index on the first chosen load of an advanced form naming the worker's record loaded
  before it**: one finding at the form under
  `forms-and-case-writes/an-index-on-the-first-chosen-load-naming-the-worker-s-record-loaded-before-it`
  (`caseManagement/advancedActions.ts`). HQ's editor offers every load stored after the first that
  does not auto-select "a subcase of the previous case", the worker's record's load among the
  previous ones, and Nova holds no chosen case narrowed to the worker's record's children.
- **The worker's record's auto-selected load stored before a chosen load**: one finding at the
  form under
  `forms-and-case-writes/the-worker-s-record-s-auto-selected-load-stored-before-a-chosen-load`
  (`caseManagement/index.ts::compareEntryFacts`, where the entry's loads differ only in where that
  load stands). HQ's entry gives each load's datum in stored order, and Nova writes the worker's
  load after every chosen load.
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
- **A search's own filter row that reads no Search field and that HQ's search and the device's list
  read apart**, on a menu whose forms read the search, where no excluded field can hold it: refused
  under `case-search/xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s`
  (`search/joinReadsAlike.ts`). Nova keeps such a row only as a clause of the list filter, which the
  device runs again over the results. HQ tests a property's text as stored and the device trimmed
  (Core's `TreeElementParser`, `CaseXmlParser`), so a `!=`, a `not` of `=`, of a blank test or of
  `starts-with`, a literal with a space at an end, or the session's user data (untrimmed) would
  drop a case HQ's search returned.
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
  (`caseManagement/index.ts::settleCaseChanges`, over the gate's own
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
  (`worldEntities.ts::locationDataNameRefused`); a session read of the worker's `user/data/` under a
  second such name, or under one the gate refuses for a worker property, under
  `expressions-and-data/a-read-of-the-worker-s-session-data-under-a-name-no-worker-property-takes`
  (`worldEntities.ts::workerDataNameRefused`, routed from the checker's `undeclared-worker-field` by
  `expressions/findings.ts::checkErrorEntry`), since the gate holds a session read of worker
  information only by identity, while a read of the worker's own case stands by name and the
  reading declares the name the session reads where one of the pair is read there
  (`worldEntities.ts::heldWorkerSlugs`); and a level whose name a level already placed (parent
  before child, siblings in HQ's order) spells in other letters only is `place-not-holdable`
  (`worldEntities.ts::levelsFromHq`), while a level left out for another reason takes no name and
  refuses none. CommCare HQ's
  user-data and location-data schemas hold one slug of such a pair as well
  (`CustomDataFieldsForm.verify_no_duplicates`), so neither a worker property nor a location
  property can take the second name; HQ holds two level names apart, and the gate does not.
- **A Save to Case block that gives a case another type beside a change that may read it as the
  earlier one**: one finding at the form under
  `questions/a-savetocase-change-of-a-case-s-type-another-change-of-the-form-may-read-as-its-earlier-type`
  (`caseManagement/index.ts::settleCaseChanges`, over the gate's own
  `caseOperationTargetTypeOrderViolations`, reason `type-change`): a create keyed by an answer of a
  type other than the form's loaded case beside Case Management's change of that case, or a
  `case_type` row on a case a later change reads as its earlier type. A keyed id may name a case an
  earlier submission made, and a device and HQ's server both give a case that exists the type its
  create names, so Nova cannot prove the later change is of another case.
- **A Save to Case update, close or link that names its case by a type the case does not hold**,
  with no change of its type before it (a link's `case_type` other than the menu's case type, an
  update of a case a create of the form makes as another type): one finding at the block under
  `questions/a-savetocase-change-whose-case-type-is-not-the-type-of-the-case-it-reaches`
  (`caseManagement/index.ts::settleCaseChanges`, the gate's `CASE_OPERATION_TARGET_TYPE_MISMATCH`
  reason `declared-type`, a violation that is not `retyped`). Neither runtime reads a block's
  `vellum:case_type`, and both keep a link's `case_type` as written; Nova types a change by the
  case it reaches.
- **A Save to Case `case_type` row that gives a case a type holding one of the earlier type's
  properties as another type**: one finding at the block under
  `questions/a-savetocase-change-of-a-case-s-type-to-a-type-that-holds-one-of-its-properties-as-another-type`
  (`caseManagement/index.ts::settleCaseChanges`, the gate's `CASE_OPERATION_RETYPE_UNSAFE` told apart
  through `lib/domain/caseRetype.ts::planCaseRetype`). Both runtimes change only the case's type and
  keep every property, and Nova changes a type only where the later type holds every property as the
  same type. A property the later type holds nowhere, or holds only through a read that no writer of
  its own and no declaration the reading derives types, is carried onto it, typed as the earlier type
  types it (`caseManagement/catalog.ts::carryRetypedProperties`, which the settle and the canonical row
  `case-catalog-is-as-read` both apply), so that shape is held; a change of the type of a case a
  create keyed by an answer makes is the type change's finding at the form.
- **A link to a captured file as a case's name or external id** in a Save to Case block: one finding
  at the block under `questions/savetocase-expressions-outside-nova-s-typed-vocabularies-case-id`
  (`caseManagement/saveToCase.ts::readBlock`). CommCare keeps a name and an external id as the case's
  own value, and the gate holds a link only in a property of its own
  (`CAPTURE_CASE_WRITE_STANDARD_PROPERTY`).
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
  (`caseManagement/index.ts::settleCaseChanges`, asking the gate's own
  `validator/rules/caseOperations.ts::validateCaseOperations` for reason `worker-record-twice`). A
  device and HQ's server apply both in the form's order, and Nova keeps a form's writes of the worker's
  record in one update, which prints one block.
- **A Save to Case block that changes the form's own case beside the form's own change of it**: a
  row of a property the own change also writes (its name and owner among them), or a close of that
  case: one finding at the form under
  `questions/a-savetocase-change-of-the-form-s-own-case-beside-the-form-s-own-change-of-it`
  (`caseManagement/index.ts::settleCaseChanges`, asking the gate's own `validateCaseOperations`
  for its own-case rule). HQ's build appends Case Management's block after every authored node, and a
  device and HQ's server apply both blocks, so the later row stands where it is present; Nova keeps one
  write of each property of the own case and lets no other change close it, and no one change prints
  both blocks. A close-only block whose `update` holds a row is read as a close operation, never as the
  own close, which the emitter writes with no `update` (`saveToCase.ts::readSaveToCaseBlocks`); an
  empty `update` beside the close, which no runtime acts on and HQ's form builder drops, is outside
  Nova's block shape alone.
- **A Save to Case block a runtime refuses or does not act on as written**: one finding at the
  block, read in `caseManagement/saveToCase.ts::readBlock` where the source spells it and in
  `caseManagement/index.ts::settleCaseChanges` by the gate's typed `details.reason` otherwise. A
  case id blank on every submission, a session case on a form that chooses none, or a link of a case
  to itself, under `questions/a-savetocase-change-a-device-refuses-a-blank-case-id-or-a-link-of-its-case-to-itself`;
  a link to, or a read of, the menu's case on a form whose menu chooses none, under
  `questions/a-savetocase-change-that-reads-the-case-a-menu-chooses-on-a-form-whose-menu-chooses-none`;
  a link name over 255 characters, under `questions/a-savetocase-link-name-longer-than-commcare-hq-stores`;
  and a case type outside the grammar or over 255 characters, under
  `questions/a-savetocase-case-type-outside-the-case-type-grammar-or-longer-than-255-characters`.

The first-publish comparison carries the actual source that a registered change rewrites. A saved-form title uses the same trimmed text Core reads. A dropped default or changed XForm expression uses the reader’s parsed spelling rules. An untranslated slot identifies its field, choice and language. These facts live in the reading and let a second request distinguish another worker-facing change at the same place.

Proof locations describe where an export changes, including the resulting case property. A review binds the source question, case operation and write slot or the earlier date/time row the reader recognized. Native source exports can rekey form attachment IDs on every call. Those IDs and unrelated actions never enter a case consequence. Stored object-valued settings use a fixed-size digest of their recorded operand.
