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
`xform/__tests__/formFixedPoint.fuzz.test.ts`. Each compares a reading with the canonical document
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
(`itext.ts::ItextReading.buildRefusesLabel`). Nova then prints every language's text or path in full, so a
first publish fills the languages a stored map or translation left out: a media map's under
`media-maps-respelled`, which `navMedia.ts::recordRespelling` records with each stored map Nova
writes again, and a form's under `forms-and-settings-rewritten`.

What the project space holds rather than the app (levels, worker and location properties) is read
from what the reading is told and what the logic reads, so its canonical rows run the reading's
own functions (`worldEntities.ts::levelsFromHq`, `worldEntitiesFromReads`) over what a document's
publish gives them (`levelsAsPublished`). An entity a reading mints that the document did not hold
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
  `app.display.name` other than `name` is not the source.
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
