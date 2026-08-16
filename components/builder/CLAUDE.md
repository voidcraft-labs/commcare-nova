# Builder Components

## The header is the app's, not the builder's

**`BuilderHeader` renders no header.** The band is mounted once in
`(app)/layout.tsx`, above both route groups, so crossing between the app list
and the builder cannot rebuild it — the app list and the builder are one page
wearing different menus. The builder's controls can't go up there with it
(Preview, undo/redo, the save indicator, and Publish all read stores that live
under `BuilderProvider`), so they stay in the builder's tree and PORTAL into
the band's cells, and `BuilderHeader` claims the band alongside them. Height,
insets, the mark, and the wordmark's width rule live in `components/ui`
(`AppHeader`, `AppChrome`, `headerSlots`, `headerMotion`) and nowhere else —
re-spelling any of them here is what produced two headers 8px apart with their
marks 4px apart.

Two consequences worth knowing. The account control is the BAND's now, so the
access-mask quarantine travels as `showAccount` on the claim rather than as a
local unmount. And the builder's clusters arrive animated but leave instantly
(no `AnimatePresence`): they go when app access stops being resolved, and a
control mid-fade is still visible and still takes a click.

**`/build/new` has a second form**: `?design=<designSessionId>` reopens a
pre-app design from the Designs-in-progress list — still the app-less builder
(conversation + derived progress stage, no tree, no Preview), hydrated with
that design's session-targeted thread; a session that has since materialized
redirects to its app.

**`/build/new` claims nothing until a build starts.** No app exists there, so
the screen is still the site with a composer on it and the nav, the Project
switcher, and Help all still belong; the band changes hands at the moment the
app lands, where the menus leaving, the word being drawn into the sphere, and
the tools arriving are one gesture. "No app" is `phase === Idle && appId ===
undefined`, and both halves are load-bearing: `phase` keeps the band in lockstep
with the chat's centred-to-docked morph, which reads the same value, while
`appId` excludes an EXISTING app whose blueprint happens to be empty — a build
interrupted before its first module lands reads as Idle and would otherwise
wear the site's menus inside a real build.

`build/[id]/layout.tsx` covers an EXISTING app twice over, because a hard load
has two distinct gaps. `BuilderBandClaim` claims in the first client commit,
ahead of a page that awaits an authorized snapshot and its threads. A
server-rendered `data-nova-build-open` marker plus one `:has()` rule in
`globals.css` covers the first PAINT, which no claim can reach: the band is
mounted above both route groups, so its server render is structurally
unclaimed. That claim also carries `handoff: false` — a page that opened as a
build never had the word to draw in, and the band cannot work that out for
itself.

Two builder-owned decisions ride on that band. **The mark is the exit**, which
is why the builder can hand the wordmark back: the app being built carries its
own name in the structure sidebar's app row, and a second name on the screen
makes the reader decide which one they are looking at. And **`/build/new` is the
exception**: with no app yet, the whole lockup stands there as Nova's own
presence (there is no hero logo over the chat box — the logomark breathes, and
two of them running the same wave stops reading as presence), so a build
starting is the moment the word is drawn into the sphere it will leave by.
`BuilderHeader` reads that off `phase === Idle` alone, so the collapse and the
chat's centered-to-docked morph are one gesture on one tick.

## Creation never navigates

Both ways an app is born — the design build's `data-app-materialized` frame
and the blank-app Server Action's return value — hand the client the SAME
receipt (identity, the server-resolved Project capability, the exact
sequence-1 blueprint and its canonical digest, the cursor) and land it
through ONE installer, `ChatContainer.installCreatedApp`, behind the same
strict `parseAppMaterializationReceipt` boundary (the digest verifies in the
background over the shared canonical JSON text). It promotes `/build/new` to
`/build/{id}` through `pushBuilderHistory`, the builder's own History-API path,
never the Next router: a route change swaps `BuilderProvider`'s `key={buildId}`
and rebuilds every store under it, severing a live run and discarding the
document just installed to fetch state the client already holds.

That is also why `createStarterApp` does NOT `revalidatePath("/")` the way the
app-list actions do. Those run FROM the app list and revalidating it IS their
refresh; this one runs from `/build/new`, and the router re-render carrying the
revalidation restores Next's own canonical URL, undoing the promotion. The app
list is dynamic (it reads the session), so it is fresh on arrival regardless.

## Builder state — three sources of truth

The builder's state is split across three stores, each with a distinct lifecycle, and each reached ONLY through its named domain hooks (raw stores and selector-accepting hooks are lib-private; Biome enforces it):

- **The URL** owns *where you are* and *what's selected* — `lib/routing` parses the path into a typed `Location`. Intra-builder navigation goes through the History API (`useNavigate`), never Next's router (a router call would force a server RSC re-render on every selection change).
- **The doc store** (`lib/doc`) owns the blueprint and undo/redo. Every UI edit dispatches through `useBlueprintMutations`, which runs the commit gate — a rejected edit never reaches the store and its findings surface inline or via a toast.
- **The session store** (`lib/session`) owns ephemeral run/UI lifecycle (preview mode, sidebars, the active run's event buffer, staged uploads). None of it is undoable or persisted, and every lifecycle signal is *derived* from a few base fields — never add a shadow flag.

Under multiplayer, a fourth, non-store owner mediates persistence: the **reconciler** (`lib/collab`, mounted by `ReconcilerProvider` inside this stack for non-replay sessions). The doc store is still the display + undo source of truth, but `useAutoSave` never PUTs directly — it dispatches the human delta to the reconciler, which owns the diff base (`confirmedDoc ⊕ sentPending`), the durable stream, and 409/reload recovery. A remote peer's edit arrives as an inbound frame the reconciler folds into the store via a `beginRemoteApply` bracket; `useAutoSave`'s first gate is `remoteFrameApplyInProgress` so a server-applied change never bounces back out as a PUT. See `lib/collab/CLAUDE.md`.

## Worker-content language lens

`BuilderLocalizationProvider` is the one Builder/Preview projection from the
canonical source document to the selected worker language. The selection is
owned by the `lang` URL query parameter, falls back to the app default, and is
preserved by every History-API navigation. Structure rows, canvases, case-list
authoring, and running Preview consume the provider's localized projections;
they never walk `doc.localization` or implement fallback independently.

The global header selector stays visible while a target is active. App setup's
Languages workspace is the authoritative source/target review surface: it owns
catalog management, copy-from-an-existing-language, status filtering, coverage
diagnostics, reference-safe prose-token editing, and navigation to each unit's
owning Builder screen. Ordinary Builder edits to worker-facing text write the
selected target overlay; structural IDs and authoring-only metadata always edit
their canonical slots. Preview applies the selected language's text direction
only to worker content, never to Nova's authoring chrome.

The Languages editor disables Save against the currently visible invalid
protected-token text, and Missing units may save an explicit source-identical
reviewed value. Inline target editors return the commit outcome: a refusal keeps
the draft mounted and shows the finding instead of closing and losing the edit.

## View-only members (read-only builder)

A Project **viewer** (the `view`-only role) opens the builder read-only. The build page resolves one atomic `{projectId, role, canEdit, baseSeq}` snapshot; `/build/new` resolves the same tuple from the active Project with `baseSeq: 0` while its in-memory store and reconciler remain dormant. Both creation paths carry that captured `projectId` back as `expectedProjectId` and authorize it directly, so another tab changing the session's active Project cannot redirect the pending build. Chat creation returns the complete server-derived tuple plus the exact sequence-1 canonical starter blueprint and its module/form/field UUIDs. The client strictly validates that receipt, installs its blueprint under a remote-apply bracket, and only then activates multiplayer against that same confirmed base; it never reconstructs a starter or promotes a persisted empty app. The session store owns its mutable capability tuple (`useCanEdit()` / `useAccessPhase()`), and `BlueprintEditableBridge` reacts to it through `BlueprintEditableContext`. Three layers make it airtight without per-control paranoia:

1. **Data backstop (the choke point).** `useBlueprintMutations` reads `BlueprintEditableContext` — when `false`, every gated dispatch no-ops with a "view-only access" message, so no canvas affordance can mutate the doc even if its control wasn't hidden. `useAutoSave` and the reconciler both refuse to PUT when `!canEdit`.
2. **Affordances hide.** The chat composer (the SA is the edit mechanism) hides like replay; `BuilderHeader` swaps the edit cluster (save indicator, undo/redo) for a "View only" badge and the structure sidebar's app-settings gear (`AppSettingsButton`, in its app row) renders nothing; the app-tree "+" insertion strips, `TreeRowDelete`, inline `EditableTitle`/`TextEditable`, form-row drag, and the field-inspector destructive controls all gate on `useCanEdit()`. Preview + local Export stay (a viewer may preview and download), but HQ upload and media upload/delete/attach/replace/remove do not. Their event handlers re-read `session.getState().canEdit` so a stale rendered control still cannot start a Project write. The account file manager stays browse/preview-capable for viewers.
3. **Server enforcement is the authority.** Every write path (`PUT /api/apps/[id]`, `/api/chat`, MCP) independently re-gates at `edit`, so the UI flag is a UX nicety, never the security boundary.

The same effective capability enforces the initial-build boundary for an
editor. After design materialization, `projectCanEdit` keeps chat available but
`canEdit` stays false while `buildUnfinished` is true: the committed app tree
fills in read-only around the central progress card, and no human autosave can
race Nova's remaining slices. Whole-build completion releases it. After a
settled interruption with committed work, the app tree remains inspectable but
locked: no partial-plan transition can mark it complete or unlock authoring. A
viewer sees the same stopped state without controls. Provider, transport,
transaction, and lost-response recovery resume the exact attempt. A recoverable
turn that has already sealed its stream exposes one **Resume build** action;
the durable incomplete stage restores that action after a cold reload. An error
app with a nonterminal orchestration head also projects incomplete, closing the
window where an infrastructure fault settled the app before it could append a
failure event. It is
editor-only, submits no new message, and carries only the redrive capability,
which makes a fresh exact-build claim without redesigning the frozen plan. A
deterministic failed plan/slice exposes no retry control and cannot be reopened
by another chat turn. A completed app's original design-backed
conversation remains ordinary editable history: its retained design-session
identity does not re-arm the lock after `buildUnfinished` is released.

## Publishing

A publish returns a durable deployment record, and `DeploymentStatus` renders
it on the success screen: the five progress states as a ladder with only the
reached ones filled, each rung stating its own condition in text so nothing is
conveyed by fill alone, and the pending reason printed beside a rung that has
not been reached. `incomplete` draws as a refusal rather than a rung, with the
failure and the phase a retry resumes at. **Never call an uploaded app released,
live, or ready for workers** — Nova cannot make a version or release one, so
those rungs are watched rather than performed, and Check status is what advances
them. CommCare HQ apps an earlier publish left behind are named on the same
screen.

The dialog **opens** on those records, above the publish form, not only after a
publish creates one — the record outlives the request, and without this the only
way to reach Check status would be publishing again, which puts a second app on
the project space. The dialog keeps ONE copy per target: the open-time read
seeds a store, and the publish response and every Check status upsert into it,
so the landed hero and the list can never show the same project space with
disagreeing contents, and a fresh deployment survives the status resets a
destination-select change causes. A refusal renders the ATTEMPT's own failure
(`refusal` on the response) beside the shared record; the record itself
carries a failure only while genuinely `incomplete`. A viewer sees the ladder
without the button (`canRefresh`), because checking writes what it observed;
the button is also withheld when the record is one checking cannot answer.

`PublishPanel` owns one `PublishDialog` with a single destination selector for
direct CommCare HQ upload, a CommCare HQ app file, or a mobile app file. The
selector's supporting line explains the current option; only its fields and
action change below, while shared prerequisite information keeps one stable
place in the dialog.
Show feature-flag information before the action, never for the first time after
the user commits: file options show exact app requirements with unknown domain
state, while HQ probes the selected project space on open/selection and on an
explicit Refresh. A preflight that does not return a report keeps its publish
action disabled and offers an in-place retry. Keep publish outcomes in this
durable modal too: direct
upload re-probes after import and reports flags Nova confirmed missing (or could
not verify) for the exact target; download success retains the artifact's exact
requirements. Viewers may use the file options but never receive the direct HQ
option. The dialog consumes the shared report from
`lib/publish/hqFeatureFlags.ts`; do not re-detect app features or copy the flag
catalog into React. Every actionable flag notice names `support@dimagi.com`, the
target project space when known, and links to the public feature-flag guide in a
new tab.

Access is live, not mount-captured. Any reload/gap/typed write-authority response
immediately pauses editing, masks the Project workspace, clears registered
Project-scoped client state, and fetches blueprint + access + cursor atomically.
Pending edits remain in the reconciler: an Editor snapshot resumes them, a
Viewer snapshot keeps them displayed but paused, and only confirmed loss of
`view` shows the access-removed boundary. Reconnect is neutral/polite rather
than an error modal. A receiver-version rejection performs one session-latched
hard refresh; a repeated rejection has its own “Nova needs to refresh” page and
explicit 44px Refresh action, never false access-loss copy or a reload loop.
The synchronous boundary also retires case/media request continuations and
decoded media elements, strips Project attachment refs from the retained chat
projection, blocks that thread until its destination-authorized transcript is
hydrated, removes scoped toasts/actions, and quarantines body portals from the
source generation. Header controls whose floating surfaces portal outside the
mask (including the account menu) are unmounted until access is authorized, so
there is no visible trigger for a deliberately quarantined popup. App-owned
chat text and unsent composer drafts stay mounted;
if the boundary stopped an optimistic user turn before persistence, only its
absent trailing text/id is folded after the authoritative transcript (fresh
objects, with no source metadata or tool parts). An authoritative thread-read
failure remains blocked behind a durable reload action rather than risking a
stripped transcript write-back.

The running form's attachment lane fences the same transition at the form
owner, not per mounted field: `FormScreen` synchronously installs
`{ appId, entryKey, formUuid, projectId, actorUserId, ownerId, scopeEpoch,
accessPhase, canEdit }` for the current entry, and every queued
upload/retarget/clear carries the exact stable slot key and checks those live
coordinates before and after awaited work. Missing authority is read-only, not
an implicit test mode. A changed tuple aborts its network continuations but
keeps the entry's stable slot, draft, diagnostic, and Submit blocker. Dirty
signature ink is generation-tagged and re-encodes exactly once if the same
entry regains editor authority; it is never silently discarded during an
access refresh.

## Edit vs preview mode

Edit is a frozen, stateless view: inputs empty, validation suppressed, submit bar hidden, and ALL fields render regardless of relevant conditions (hidden ones as compact cards) so the full structure stays editable. Preview is a persistent sandbox: values survive round-trips through edit; validation resets on exit; blueprint mutations recreate the engine but restore only user-touched values, so edited defaults show immediately.

## App setup — Users & personas

`app-setup/` edits the three flat user collections. Text whose intermediate
state can be invalid — worker-information labels and saved keys, accepted-value
lists, role names, and persona names — drafts locally through
`DraftCommitField.tsx`. Names and keys commit on blur or Enter; newline lists
commit on blur, Apply, or Command/Ctrl+Enter. Only a passing normalized value
saves, and Escape restores the committed value. A refusal stays visible beside the
draft, including when a multiplayer peer changed the same value while the local
draft was open, so typing never loses characters or silently clobbers the peer.
Selection controls remain immediate because every offered choice is valid by
construction. Add focuses the new entity's name, successful removal returns
focus to the section's Add action, and the required switch uses the full row as
its label target. `AppSetupWorkspace` is an `@container`; keep subsection
responsiveness scoped to the workspace rather than the viewport. Persona values
have three real states and no magic-string sentinel: absent inherits the role's
value (or means no authored value when there is no role value), `""` is an
explicit blank override, and a nonempty string is explicit. Select controls use
private numeric item identities so authored values such as `__none__` remain
ordinary choices. Each value edit dispatches its own semantic mutation rather
than replacing the whole role/persona value bag. XPath and predicate pickers
bind custom worker information by UUID and display its current saved name; a
rename updates chips and completions live without rewriting the AST. Predicate
source menus keep **Worker information** (UUID catalog only) separate from
**Other user field** (explicit raw built-in/external name); typing a custom
slug in the raw source never upgrades it to identity, and a missing custom UUID
stays visible as an unavailable reference rather than exposing the identifier.
Built-in or external worker fields remain name-backed and admit XML-safe
hyphens after their first character. Removing custom worker
information first queries the shared reference index: while a condition or
calculation reads it, the subsection lists the owning settings and offers no
destructive action; once unreferenced, one gated batch clears its role/persona
values and removes it. Entry disclosures stay mounted while collapsed, so
invalid/refused name, key, and accepted-value drafts plus their explanations
survive both collapse and switching between rows; Base UI retains the hidden
panel's focus/inert semantics. Persona removal remains
disabled until the owner-wide retained-case count succeeds; the confirmation
states that rows of current or retired case types remain stored under that
persona and may still appear in unfiltered data views, without implying
deletion or reassignment. Preview identity and expression-source menus expose
ordinary mutually exclusive choices as checked radio-menu items; color is only
a secondary cue, not the selected-state contract.

## App setup — Organization

`app-setup/OrganizationSection.tsx` presents one authoring concept over two
stores: levels and place-information fields are flat Blueprint collections;
places are an app-scoped, revisioned Postgres tree read through
`useOrganization`. The store snapshot is the only source for place rows. Level
and property edits use the ordinary mutation gate; every place write flushes
pending blueprint changes first and then carries the latest organization
revision. Persona assignment offers only live places whose level holds workers,
stores main place first, and never invents a reassignment for cases. Archive
confirmation is server-described: subtree, displaced personas, owned cases,
and any fixed-place or next-level owner rules the tentative archive would
break. Such an owner-rule blocker disables the gesture until its form rule
changes. Place rows own edits to their external ID, parent, and custom values;
creating a place collects the same level-applicable values, and required values
keep its Add action disabled. Each custom-value save sends one `valuePatch`
entry, then rebases the complete local value bag from the authoritative returned
row, so keeping a draft cannot overwrite a peer's edit to an unrelated
property. Property controls author the required and accepted-values contracts
and preflight every existing place so a catalog change cannot create a
cross-store state the server would refuse.

## App setup: Automations

`app-setup/AutomationsSection.tsx` edits the Blueprint's canonical automation
union. A new rule is born as one complete valid object with caller-minted UUIDs;
editing works on a local complete copy and saves through
`replaceAutomation`, which derives the shared item-granular mutation grammar.
An open editor fingerprints the authoritative automation: if a peer changes or
removes it, Save and Remove both refuse with a visible conflict and keep the
person's local work for comparison. A changed rule tells the author to close
and reopen it to review the newer version; a removed rule says to close the
editor and never offers a nonexistent rule to reopen. The portalized dialog establishes its own
container for every `@md` layout; App setup's outer container does not cross the
portal boundary. Gate findings stay in persistent footer chrome while the body
scrolls, and the responsible control or repeated-row fieldset carries
`aria-invalid` plus its described error; the footer remains the sole alert so a
refusal is announced once. Exact top-level paths include server-modified days,
default language, restart property, and stop-date property. Empty recipient
and schedule-event arrays retain named group fieldsets after their last row
disappears, so those collection-level refusals also have a stable local anchor
without duplicating descendant-row errors. Comma-separated reminder intervals keep their
in-progress text locally while focused, report invalid text into that same
refusal path, and project only positive whole-minute lists into the canonical
automation; blur or Enter canonicalizes a valid list. Automation removal uses
an explicit inline confirmation: opening moves focus into the alert, Cancel
restores the newly rendered Remove trigger, and successful removal returns to
the section's Add action. Invalid reminder text survives blur and Save with its
refusal so the author can correct what is visibly wrong; it never snaps back to
an older valid list while leaving a stale error. Viewers receive the same expanded readable rule,
current-match information, and generated setup guide with every mutating
control absent or disabled; **View full definition** opens the complete editor
projection with its controls disabled, never a reduced summary that hides
recipients, changes, schedules, filters, or content.
The empty state is permission-aware: editors get the Add instruction and
viewers are told that a Project editor can add the first rule. In a new-rule
editor, changing the automation kind preserves the root UUID, custom name,
case type, match operator, setup-only instructions, and criteria valid for the
new kind; it resets kind-specific settings and says so beside the control.
The setup guide and case count share one authoritative refresh, but the count
is optional: a case-query failure stays local to the matching result and never
withholds the regenerated manual HQ guide. A resolved Server Action refusal
clears any prior count, guide, and copy receipt because the authoritative
snapshot was not granted. A rejected Server Action transport stays in the
section's retryable alert and retains the prior count and guide because it
returned no authoritative verdict. Only the latest still-mounted refresh may
replace that state or clear pending.
Because a disabled native button loses focus in real browsers, completion
restores the refresh trigger only when it started focused and focus did not move
to another control while the request was pending.
Place-backed conditions and recipients distinguish the first load, an initial
failure, a failed refresh, an in-flight refresh, and a genuinely empty live
place catalog. The editor names the state and offers the organization reload
action where it can help; adding or changing a place reference stays paused
until the catalog is authoritative. A retry's in-flight state takes precedence
over its retained prior warning. A saved reference whose place cannot be
resolved remains readable as **Saved place unavailable**, never as a raw UUID.
A place loading or refreshing notice owns one `role="status"`; its spinner is
decorative so the notice never nests a second live region. Nested automation
rows use the warm `nova-deep` well, the default `nova-border` hairline, and the
12px card radius rather than black overlays, white borders, or compact radii.

The section is structured vocabulary, never raw CommCare JSON: kind-specific
property criteria, one UUID-backed location criterion, the case-update-only closed-parent filter, explicit setup-only
instructions, typed update targets/values, recipients, content, schedules, and
worker-information filters. Forms, worker properties, organization levels, and
places resolve through current UUID-backed catalogs. HQ-only conditions choose
the structural UCR or registered-custom family and retain an exact setup note,
while case-update
server-modified age is a separate structured field; all are visibly omitted
from the case count. A count is read-only over real open case rows; the persistent note
states that Preview never updates cases, sends messages, advances schedules, or
installs anything in HQ. The regenerated guide names the exact HTML route,
privilege, cadence, cap, omissions, and unsupported historical IVR/callback
activation. A rule with any host-scoped condition, update target, update
source, or message reference has one guide caveat stating that every triggering
case needs exactly one live extension at runtime. Retained extra extension
indices make the case count unavailable, and HQ does not define which extension
it chooses as the host. Copy acts on the derived text only.
Regenerating a changed guide remounts its copy receipt so **Copied** can never
describe bytes from the prior guide.
An alert using a registered custom recipient or custom content handler also
names HQ's system-administrator save requirement; registration alone is not
presented as sufficient for a project administrator.
Content-specific caveats are equally exact: SMS Survey names Inbound SMS access,
and Connect names the `COMMCARE_CONNECT` toggle plus the requirement that every
runtime recipient resolve to a CommCare mobile worker with an active PersonalID
link.

The HQ route is emitted as an actionable template (`/a/<domain>/data/edit/automatic_updates/`
or `/a/<domain>/messaging/conditional/`) beside its breadcrumb. The deprecated
run-on-save flag is never offered on a rule because HQ owns it as a project-wide
switch. Survey content resolves its UUID to the current published
app > module > form path that HQ's picker displays; Nova UUIDs never masquerade
as HQ form identifiers, and the Builder uses that full path to disambiguate
same-named forms while persisting only the UUID. The required default-language control projects an empty
Nova value to **Project Default**, while an explicit code carries the target
project-language configuration prerequisite. Worker/group recipient IDs begin
empty with instructional placeholder copy and cannot commit blank or padded.
Every text control composes the shared `Field` stack and carries the repo's
noncredential input attributes. Dates use `DatePicker`, clock times use `TimeField` plus
the canonical clock parser, and Weekly/Monthly event days use closed choices
that exclude siblings and disable Add when exhausted. Removing any repeated
criterion, setup instruction, update, recipient, recipient filter, or event
hands focus to the next or previous enabled row action, then its Add action.
Nested creation controls use verb-first **Add ...** labels, and an exhausted or
unavailable control replaces that label with the exact reason it is disabled.
The switch label and helper copy take the shared disabled opacity only once,
including when an ancestor fieldset disables the editor.

Message subjects/bodies use the structural template editor. Literal controls
never parse token-looking text; projection doubles literal braces for HQ's
Python Formatter. **Case property reference** inserts an explicit scope plus
`(caseType, property)` identity part, while **Owner or recipient reference**
inserts a closed context/property part. Removal canonicalizes adjacent literal runs, and Save
refuses blank parts or unresolved properties. Registered custom IDs and HQ-only
instructions start empty with descriptive placeholders. Every authored select
passes `wrapValue`/`wrap`, so long place names and published
`app > module > form` paths remain distinguishable in the narrow dialog.

The editor makes the HQ form's cardinality and compatibility rules impossible
to author: case updates expose value/date conditions on case, parent, or host
properties plus at most one standard closed-parent condition; alerts expose
direct-case value/regex conditions and no date, closed-parent, or
server-modified condition. Both offer at most one live-place location
condition and an explicit descendant flag. The guide states that HQ accepts
and executes that form payload while its current visible editors hide the picker.
It also allows no web-user recipient or incompatible case-relative/email/case-group recipient
with Connect content, and no timed reset property unless the start is the rule
trigger. Singleton recipient choices disable once used; list recipients exclude
already-selected concrete targets. Descendant and location-level controls exist
only under a location recipient and clear atomically when that dependency goes
away. Each worker-property filter can be added once. Its accepted values are
individual literal/case-property rows: literal inputs preserve empty and exact
whitespace, case-property rows resolve custom properties by identity, and the
guide announces when the resulting exact JSON needs an HQ system administrator.
HQ filters only contacts that resolve to user accounts, so adding a filter
disables the case, parent/child-case, case-email, case-group, and registered
custom recipient choices; with any such recipient already selected, adding a
filter is disabled and the visible note explains the runtime scope. A
case-property filter value says that every triggering case must contain the
property because HQ's direct lookup raises if it is missing.
Closed-parent exposes no custom index or relationship. Exact HQ
literal inputs start nonblank, and switching dependent schedule choices clears
values the new form cannot save.

Property inputs always show Nova names. Setup guidance projects supported
standard names to the HQ model fields; status and dynamic-only standard values
refuse visibly. Email exposes one schedule-wide target form: plain text with the
Rich text emails prerequisite off, or rich HTML with it on. Switching the form
changes every email event atomically, renders only that body's editor, and
states that HQ sanitizes rich HTML and derives plaintext.

The timed editor projects the canonical runtime encoding into one selectable HQ
form (Custom Daily, Weekly, or Monthly). Content type and timing mode are schedule-wide; shared
Weekly/Monthly timing and content edits fan out to every event. Human day fields
use HQ's one-based Custom Daily values and exact Monthly day set. Weekly labels
project the stored offset through the schedule start weekday; changing the
start remaps and re-sorts offsets so the selected absolute weekdays stay fixed.
Case-property timing explains that, after trimming, a runtime value must begin
with `H:MM` or `HH:MM` and parse completely. It names accepted AM/PM and seconds
suffixes plus HQ's 12:00 PM fallback for blank, nonmatching, or unparseable
case data.
Dependent
survey controls clear and disable the same way HQ's form does, while the domain
gate remains the final cross-field authority.

Save and Remove pass the editor's opening fingerprint to the hook. The hook
compares it with the authoritative record in the same synchronous call that
derives and applies the granular mutations; a peer edit between render and
click is therefore refused instead of being overwritten or deleted.

Responsive behavior is owned by the App setup container. The list and editor
must remain usable at the 320px dock layout, and all repeated rows keep explicit
labels, remove names, keyboard focus, and visible refusal text. Add focuses the
new rule, successful removal returns focus to Add, and no meaning relies on
color alone.

## Preview mode

One global Preview toggle (centered in the BuilderHeader — directly above the canvas for reach; `P`, Escape exits) flips the whole canvas to the running app. Breadcrumbs live in the canvas column's own strip so a long trail can never collide with the centered toggle. **The mode flip is one layout commit choreographed by transforms** — centered (max-width) content can't track a sliding sidebar edge through layout (it stays pinned until the column narrows past the frame, then rushes), so the flip commits the final layout in a single render and everything that travels does so on the shared `SIDEBAR_TRANSITION`: **both flanks are the same shape — an in-flow SPACER that owns the layout width plus an absolute dock that slides via `x`**. Neither the app-tree panel nor the never-unmounted chat panel unmounts on a preview flip (unmounting the tree reset its scroll + expand + search; unmounting chat would sever the live run), so the preview flip is a transform + a spacer-width snap, never a remount. `AnimatePresence` still carries each flank's COARSE enter/exit slide (app open/close, the handset dock swap) — not the preview flip. The collapsed chat rail is a separate `AnimatePresence` element. Every centered surface is a `ContentFrame` gliding a delta computed from the column geometry (`ModeFlipGlideProvider`) — computed, not FLIP-measured, because Activity-swapped frames have no "before" box yet must stay edge-locked with the breadcrumbs. **New centered canvas surfaces must use ContentFrame** or they'll snap while everything else glides. Manual sidebar toggles keep the plain width tween. There is no per-surface preview affordance and no cursor-mode pill. Entering stashes open-state and closes both sidebars atomically (`setPreviewing`), so leaving restores the layout; keep the early return on no-op toggles — without it, entering preview twice overwrites the stash with `{ false, false }`. That close only selects the panel's CONTENT, it never unmounts it: the app-tree panel renders against the EFFECTIVE open-state (`structureStashed ?? structureOpen`), so an open tree stays the mounted `StructureSidebar` (scroll intact) as it slides off rather than swapping to the rail. The layout widths collapse off the `previewing` flag alone, so hiding the flanks never depends on that close.

Below the narrow builder breakpoint, both 56px destination rails remain in flow and the expanded structure/chat/properties surface opens as a contained shadcn/Base UI modal drawer over a scrim. Under 560px, the rails become a labeled 56px bottom panel dock so a 320px handset gives the canvas its full width; the same drawers remain one tap away and reserve the dock's vertical space instead of covering authored controls. Base UI owns initial focus, focus containment, document inertness, outside/Escape dismissal, and focus return to the retained rail or dock trigger; do not recreate those behaviors with listeners or a decorative overlay. The chat drawer uses `keepMounted` because its stream, draft, and attachments must survive every open/close and viewport transition.

## Flipbook (edit ↔ live) invariants

- Scroll sync captures the topmost visible field BEFORE the mode change and corrects `scrollTop` in a layout effect after; the anchor must be React state (the effect depends on it). If the anchor is hidden in the new mode, search outward from its index backward first. A ResizeObserver re-corrects during the ~200ms sidebar animation, then clears after 250ms.
- **Two scroll containers carry `data-preview-scroll-container`**: the always-present outer (`PreviewShell`) is the live scroller; `VirtualFormList` adds its own inner one in edit mode. `document.querySelector` (BuilderLayout's capture + DOM-nudge restore) returns the outer — which IS the live scroller, so that restore only handles landing on LIVE. Landing on EDIT can't go through it: the edit canvas is a virtualized list that is destroyed on every flip, with off-screen rows not in the DOM. So the edit canvas restores through the virtualizer's OWN scroll-restoration API: on unmount `VirtualFormList` saves `{ offset: virtualizer.scrollOffset, measurements: [...virtualizer.measurementsCache] }` per form (`editScrollByForm` in the session store), and the next mount replays them as `initialOffset` + `initialMeasurementsCache`. Both are load-bearing: `initialOffset` (not an after-mount `scrollToIndex`/`scrollTop=`) because the virtualizer applies it in a layout effect on EVERY mount via `getScrollOffset()`, so it survives mount-wiring re-runs, the foreground mode-flip relayout, and a backgrounded tab — whereas an after-mount nudge gets stomped back to 0 by the virtualizer's own `_willUpdate → _scrollToOffset(getScrollOffset())` while the observed offset is still 0; and `initialMeasurementsCache` because without the real row heights the fresh list re-measures from estimates and the content drifts ~half a row per flip. Save reads the VIRTUALIZER's state, never `el.scrollTop` — the passive cleanup runs after React detaches the node, where `scrollTop` is 0. (Two prior fixes — an after-mount nudge, and an `initialOffset`-only restore that read `el.scrollTop` — passed in a backgrounded test tab but snapped to top / drifted on PROD; verify scroll work in a FOREGROUND browser, e.g. Playwright, because a backgrounded tab pauses rAF and hides these.)
- Both renderers must land every row at identical X/Y — scroll sync can't rescue genuinely different layouts. Group/repeat collapse state lives in `FormLayoutContext` (mounted once per form), never in the virtual list, which unmounts on mode switch. Rows pad right with `depthPadding(depth)` (not `depthPadding(0)`), and live-mode labels wrap in `px-[5px] py-[5px]` to match edit mode's idle wrapper — without it every labelled row is 10px shorter live and the flipbook drifts.

## ProseMirror trailingBreak — CSS fix, not DOM

prosemirror-view hardcodes a `<br class="ProseMirror-trailingBreak">` per block. Hide it only where it adds phantom height: `.tiptap .ProseMirror-trailingBreak:not(:only-child)` (sole-child breaks must stay for cursor positioning) and `.tiptap:has(> :not(p)) > p:last-child > .ProseMirror-trailingBreak:only-child` (the structural paragraph after block elements). Preview markdown sets `white-space: break-spaces` + `position: relative` globally to match ProseMirror, so mode switches don't reflow. TipTap 3's class is `tiptap`, not `ProseMirror`.

## Scroll, selection, navigation

- Scroll-to-selection is a rAF loop, not native smooth — panel mount/unmount layout shifts make the browser abandon native `scrollTo` mid-flight. Cross-screen navigation scrolls `"instant"`.
- Clicking empty space never deselects (it would constantly dismiss the inspector).
- Selection is a URL replace; scroll is a separate pending-target request the selected field's wrapper consumes. Undo/redo scrolls directly — never through the pending mechanism.
- The edit guard (XPath editor with unsaved invalid content) blocks navigation two-strike: first attempt warns, second lets through, any keystroke resets. While an XPath editor is mounted, an identity-backed peer rename rebases a clean draft or a non-overlapping local addition. The editor subscribes to the custom-worker catalog independently of the printed expression, so a catalog-only change cannot leave a stale identity baseline. A dirty draft auto-rebases ONLY when the peer projection changes exactly one complete `#user/<slug>` token, that rename is the catalog's only identity change, the before/after entries prove the same unique custom-property UUID, and the cleanly parsed local and base texts each contain the complete old token exactly once. Any catalog-only change that could alter a draft token's identity interpretation, plus namespace matches, bare-slug guesses, parser recovery, token extensions, deletions, repetitions, and broader peer edits, fails closed. If the local and remote edits replace the same text, the controlled CodeMirror value preserves the local draft and refuses save until Escape reloads the shared projection; later external projections update only the shared base and cannot clear that conflict. An external value prop never blindly overwrites focused work.
- Field uuid is the stable UI identity (survives renames); the path is only for mutation calls.

## Drag-and-drop

`pragmatic-drag-and-drop` + TanStack Virtual. Not `@dnd-kit/react`: its sorting plugin physically moves DOM nodes during drag, fighting the virtualizer's absolute layout, and its `position: fixed` overlay breaks under `contain: strict` — pragmatic DnD's browser-managed preview is immune to both.

- During drag, the hovered insertion row is REPLACED by a taller placeholder row (row count stays constant; one slot remeasures). When the cursor is over dead space, the last valid position is preserved — clearing it collapses the gap and flickers.
- At drop time the cursor is over the placeholder, so drop targets carry no useful data: the monitor stashes the resolved position from `onDrag` in a ref that `onDrop` reads. The placeholder registers as a drop target so the native drop is accepted (no snap-back).
- One monitor owns the mutation; row components never mutate. Drop-target payloads are a discriminated union in `dragData.ts` — add new kinds there so the monitor stays one switch.
- The cycle guard (`isUuidInSubtree`) runs in every `canDrop` AND defensively in `onDrop`, reading the doc store imperatively.
- The custom native drag preview renders into a library-owned offscreen container so the source element keeps its size — otherwise the virtualizer's ResizeObserver collapses adjacent rows mid-drag.

## Field wrapper is `div[role=button]`, not `<button>`

Children contain nested interactive elements; HTML forbids interactive content inside `<button>` and SSR parsers mangle the tree. Do not "fix" this. The wrapper sets `pointer-events-none` on children; text-editable zones punch back through via CSS, and the capture-phase click handler selects without stopping propagation for text targets so inline editing also activates.

## Undo / redo

The action runs gate → apply the recorded step → `flushSync` → focus hint → scroll → flash (it does NOT touch the URL — the selection stays put). `flushSync` is required (DOM nodes created by the undo must exist before focus queries); do not replace with rAF. The scroll brings the canvas field ROW into view; the flash lands on the edited property's editor in the rail. Focus restoration consumes a focus-hint string written by a delegated onFocus handler; never query `document.activeElement` (blur has already moved focus). Undo records no step during hydration or an agent write — the empty→populated transition must not enter history, and a whole run is one undoable unit. Do not remove the bracket calls.

## Field editor

Registry-driven: Zod schemas + kind metadata in `lib/domain/fields/<kind>.ts`, editor schemas keyed by `FieldKind` in `editor/fieldEditorSchemas.ts`. Adding a property = one schema entry; adding a kind = one domain file + registry entries. Move targets and first/last flags compute inline in the render body, not `useMemo` — reorder produces new Immer references without changing selection, so memoizing on selection misses it.

**The editor docks in the right-rail inspector** (the shared `InspectorPanel` chrome + `builder/inspector/` bodies the case-list workspace also feeds), not an inline drawer. The rail renders it directly from the URL selection (`useActiveInspector`, § Inspector rail) whenever a field is selected — no claim, no portal, no owning surface injecting it, so it never unmounts across a preview flip. `FieldInspectorBody` composes the `FieldIdentitySection` (id + move/convert/duplicate menu), the registry-driven `FieldEditorPanel`, and a bottom `RemoveRow` delete (removal is always the body's last row). Selecting a field shows ONLY its canvas selection ring — nothing expands beneath it — so edit and preview render 1:1 (hidden fields, compact cards in edit and absent in preview, are the documented exception). Label/hint stay inline-editable in the canvas (`TextEditable`, height-neutral); the rail holds id, binding, logic, appearance. Undo/redo flashes the changed property by tagging the body with `data-field-inspector={uuid}` (`lib/routing/domQueries.ts::findFieldElement`).

**Convert Type asks before it can set saved data aside.** The convert submenu routes through `FieldIdentitySection.requestConvert`: it consults the SAME `planKindConversion` the dispatch will build, and a plan carrying `dataLossRisk` (a case-bound flip whose per-row cast can fail — `castCanFail`) detours to `ConvertImpactDialog` instead of dispatching. The dialog opens immediately in a checking state and fetches `conversionImpactAction` (the store's own cast over the store's own population, held cases included, so its numbers are the migration's numbers); zero uncastable values auto-dispatches (nothing to consent to — the checking state is the only trace), a non-empty count states "N of M saved values … can't become <type>", shows the sample values, and puts the consequence in the destructive action's own label ("Convert and hold N cases"). Cancel changes nothing; consent lives in the dialog, never on the mutations, so undo/replay re-run the migration unconditionally and Data to review stays the recovery path. Total flips and non-case-bound conversions dispatch directly with no check — and so does a retype reached without a convert gesture (retargeting a binding onto an undeclared property holding rows of another type): that path has no conversion to ask about, so write-time detection parks + holds and the conversion toast reports it (the #252 design record's deliberate boundary).

## Adding modules & forms (app tree)

The structure tree has the same hover-reveal insertion affordance the form canvas uses (`appTree/insertion/`), between modules and between a module's forms — literally the same reveal gating, shared through the insertion-intent model (`lib/ui/insertionIntent.ts`, pure and unit-tested; DOM/React binding in `lib/ui/hooks/useInsertionZone.tsx`). The tree's two levels name themselves: the strip opens to a labeled "+ Form" / "+ Module" pill (no tooltip — naming an affordance through a tooltip means naming it while it's invisible), with form strips indented to the form rows' depth so they read as inside the module. Each surface mounts one `InsertionIntentProvider` (AppTree for the tree, VirtualFormList for the form canvas); zones register geometrically and the model opens a gap only on dwell-intent — a decelerating (aiming) pointer opens on arrival, constant-speed passes and sweeps never open, a flick that stops on a gap opens after a settle beat. The reveal expands the gap and pushes neighboring rows apart (shared visuals in `components/ui/insertionReveal.ts`); layout moving under the pointer is safe because containment is geometric and the binding re-measures rects through the reveal animation — never DOM hover state. Because the app is valid by construction, creation can't make an empty shell — each "+" dispatches an ATOMIC born-valid scaffold (`lib/doc/scaffolds.ts`, the UI twin of the SA's `createModule`/`createForm`) committed as ONE gated batch through `useBlueprintMutations` (`createCaseListModule` / `createSurveyModule` / `createForm`), then navigates to the new entity (renamed inline on its screen). A case-list module is born as a VIEWER — a `caseListOnly` module with its case type declared in the catalog and a `Name` column, NO form (a name-only registration form is valid wire, so there's no reason to force one — see `lib/doc/CLAUDE.md` § scaffolds); adding a form later flips the viewer to form-bearing. A `caseListOnly` module IS its case list — it has no form menu anywhere, so creating one (and clicking its tree module row, its home-screen tile, or landing on its module URL) opens the case-list config directly, never the empty module screen (see § Case-list workspace). A survey module is born WITH one survey form (a formless, case-list-less module is a hard CommCare build error — `NO_FORMS_OR_CASE_LIST`, regardless of case type — so a bare module isn't valid). The add-form menu offers every form type but DISABLES the case-managing ones with a reason on a module that has no case type — the same disabled-with-reason rule the case-list pickers follow. `shared/CaseTypePicker.tsx` (existing types + validated create-new + clear) is reused by both the add-module popover and the module-settings Case Type section; its create-new name is gated inline by `lib/doc/identifierVerdicts.ts::caseTypeNameVerdict`. Clearing from module settings is confirmed before mutation; the everyday helper stays brief, while clear consequences and gate rejections live in that confirmation state (and a formless module explains why clearing is unavailable instead of offering a dead action).

Each module/form row carries a two-step inline delete (`appTree/TreeRowDelete.tsx`, revealed on row hover): the first click arms a rose "Delete?" confirm, the second commits — no dialog, mirroring the app-card double-delete. It routes through the gated `removeModule` / `removeForm`, so the removal (and a module's cascaded forms/fields + any retired case-type record) is ONE undoable batch; deleting the open entity falls back to the app home / parent module.

## Settings popovers

Module/form/app media each clears through its dedicated null-carrying mutation. Case-list appearance slots use `setCaseListMeta`; column content, visibility, sort, and Results/Details order use their granular column planners; Search settings use `caseSearchConfigOperation` plus the exact semantic `caseSearchConfigPatch` on `updateModule`. Do not write wholesale `caseListConfig` or `caseSearchConfig` snapshots for ordinary editor gestures: each independently-owned setting has one final mutation payload so a stale editor cannot clobber a fresh peer edit.

CommCare Connect learn-module time estimates are positive whole **hours** on
every authoring surface. Both the app-wide Connect manager and per-form settings
say hours explicitly and show `hr`; a freshly enabled per-form learn module
starts at one hour, the minimum Connect can represent. The stored
`time_estimate` integer emits unchanged, so no surface may label or seed it as
minutes.

The App Settings panel carries a conditional **data-sources row** (`appSettings/AppDataSourcesSection.tsx`): when the app reads case properties no form in it writes (`lib/doc/unwrittenProperties.ts`, via `useUnwrittenPropertyCards`), the row states the count and opens `UnwrittenPropertiesDialog` — an informational list (property, case type, where it's read), deliberately neutral chrome with no semantic color and no action, because a no-writer read is a normal state (viewer apps, staged sample data), not a defect. At zero the row renders nothing.

The media picker (`media/MediaPickerDialog.tsx`) grows an **Icon Library** tab — a searchable grid of the curated built-in icons — gated by its explicit `iconLibrary` prop. `SingleAssetSlot` is a discriminated contract: an uploaded-only slot omits `iconLibrary`, a module/case-list icon slot passes `"module"`, and a form icon slot passes `"form"`. The component never infers identity semantics from `slotKey`. App logos, field/option message media, image-map cells, and audio slots therefore cannot accept built-ins even if their display key happens to resemble an icon slot. The account-menu file manager passes `"all"` (browse-only — clicking previews, since there's no carrier). The picker returns a discriminated uploaded row or closed built-in ref; a built-in never impersonates a library row. Picking stores the exact catalog-closed `nova-icon:<slug>` ref (resolved to shared bytes at emit); `mediaClient.ts::mediaSrc` routes it to `/nova-icons/<slug>.png`, so a built-in chip renders without an `/api/media` round-trip. The module-settings popover also hosts the Case Type section (`ModuleCaseTypeSection`), which sets/clears the type through the gated `updateModule`. A bare `caseListOnly` module has no separate module screen, so that same panel alone adds its ordinary **Module name** input; form-bearing modules keep the one inline name editor on their real module screen. Setting a type seeds a `Name` column (and makes a formless module a `caseListOnly` viewer), and `updateModule` declares a brand-new type in the catalog so the column resolves; clearing drops the case-list/search config AND the `caseListOnly` flag (a typeless viewer is invalid). A change the gate refuses (e.g. clearing the type out from under case forms) surfaces inline.

## Inspector rail (right-rail properties panel)

The right rail is the chat sidebar; when something is selected for inspection the rail renders the properties panel in place of the conversation (`ChatSidebar` reads `useActiveInspector`). `lib/ui/inspector.tsx` holds only the shared rail-width constants. **The rail is ONE live width in both modes**, so selecting something never reflows the canvas. Both open sidebars use 360px on roomy desktops and compact together to 300px below the narrow-desktop breakpoint; never re-introduce a per-mode width. Below the narrow-canvas breakpoint, desktop open-state is preserved but no full panel reserves layout width: structure and chat begin as 56px icon rails, and at most one expanded flank overlays the canvas. On handsets the rail actions move to the labeled bottom dock instead of consuming 112px horizontally. An active inspector takes the right overlay immediately, opening structure dismisses it, and `ChatContainer` remains mounted while parked or overlaid so a draft or live stream can never be severed by responsive layout. The two panel actions remain reachable, the center owns every remaining pixel, and the builder row clips overlay travel so the document never gains horizontal overflow. On short windows, an active inspector gets the vertical space: chat condenses to its single return bar, and expanding chat closes the inspector. On exceptionally short windows (under 360px), the global header and breadcrumb each compact to 60px: 44px controls retain a real 8px breathing margin instead of touching their borders. Fixed workspace chrome must still yield enough real height for its independently scrollable body rather than allowing that body to collapse to zero. A standalone expanded chat at that height replaces the impossible transcript/composer stack with one complete **Chat needs more room** surface and a 44px **Collapse chat** action—never a clipped composer fragment. `ChatContainer` and the hidden composer stay mounted behind that replacement so a live stream and staged input survive the responsive transition. At normal heights the composer and any active status remain docked beneath properties. Resting chat renders no status panel; sending, reading, building, recovering, and completion use one compact plain-language activity row.

The chat sidebar's thread picker is a row list, not a stack of cards. Its header contains only the surface title and the standard right-sidebar collapse glyph; New chat / History are labeled actions in their own row. Thread selection keeps the list mounted while the transcript fetch is in flight, then swaps the keyed conversation root only after the requested thread is active. Every conversation mounts with an instant initial bottom position — never smooth-scroll historical messages into view or expose the prior thread during a switch. The same no-animated-travel rule governs sends: a local turn (a typed message or an answered question round) JUMPS the view back to the bottom and re-engages the stick-to-bottom pin so the reply streams in view, while incoming content alone never scrolls a view the user has deliberately scrolled away from the bottom.

- The rail OWNS the inspector — there is no claim stack and no portal. `useActiveInspector` (`builder/inspector/activeInspector.tsx`) resolves the current selection into a `{kicker, title, body, onClose}` descriptor from two sources: a selected form field (URL, `useSelectedField` → `FieldInspectorBody`), else the case-list workspace's `inspector` (its shared controller — `CaseListWorkspaceProvider`, mounted above the row in `BuilderProvider`). `ChatSidebar` renders that descriptor into `InspectorPanel` as a plain child; `BuilderContentArea` reads the cheap `useInspectorPresence` for rail width + narrow-overlay logic.
- `CaseListWorkspaceProvider` renders its controller host UNCONDITIONALLY — the child element type must stay stable, because swapping it (e.g. gating the controller behind a first-visit flag) remounts the whole builder subtree and severs chat's live run. The controller is inert (`active` false) until a case-list URL opens. Rail + layout consumers read `useCaseListInspector` — a narrow, memoized slice (`{inspector, onClose}`) — not the full `useCaseListWorkspace` controller, so they don't re-render on every workspace change; the center canvas is the only full-controller consumer.
- Scroll survives a preview flip for FREE — the same guarantee chat and the app tree have — because the panel simply never unmounts across the flip. `docked` follows the SELECTION (which the URL retains across a flip), not the preview mode, so the panel stays mounted while the rail parks off-screen; there is no scroll-position bookkeeping. The case-list controller lives ABOVE the preview `<Activity>` boundary precisely so its inspector isn't torn down when the canvas hides in preview (the field's owner, `FormScreen`, already survives the flip). `BuilderContentArea`'s layout signal still gates on `!previewing` — the rail owns its own mount, so the layout must not treat a parked inspector as docked.
- Escape closes only from outside the rail (`[data-inspector-rail]` check) — inside it, CodeMirror/menus own Escape.

## Case-list workspace

The unified case-list authoring surface has three config tabs (Search / Results / Details); **the tab IS the URL kind**, so tab switches are history navigation and deep links land on the right canvas. Selection is the mode; the run-through is the chrome's global Preview toggle — all three URLs preview as one assembled journey (Search → Results → Details, then Continue carries the selected case into the module's case-loading form). Entry point is the structure tree's case-list node, not the module screen — EXCEPT a `caseListOnly` module (a bare case list with no forms), whose module row, home-screen tile, and breadcrumb all open this workspace directly because it has no form menu to land on. The breadcrumb and structure tree already carry that module identity, so the workspace never repeats it in a second title/header tier. Its sole **Module settings** gear shares the existing Search / Results / Details row, and the panel contains the bare module's one name editor plus case type and appearance; form-bearing modules keep those entry points on the module screen. On handsets, the fixed tabs already own current-screen semantics, so the breadcrumb bar omits the redundant Search / Results / Details leaf and collapses its ancestors into one 44px path menu; Back and the full Case data action remain visible without clipped words. The settings panel is the sole appearance home: it names and preserves the module's `icon` / `audioLabel` as **App home tile** and the distinct `caseListConfig.icon` / `audioLabel` as **Case list link**; Results carries no duplicate appearance entry.

**Preview is the running app, not a per-screen mockup — its navigation is read from CommCare's runtime, never approximated.** The shape matches `commcare-core`'s `CommCareSession.getDataNeededByAllEntries` (proven by its own `TemplateStructureTest`): entering a module hoists any datum ALL its forms share.
- **Case-first module** (every form case-loading — `isCaseFirstModule`): the case list IS the module's landing (the home screen / `ModuleScreen` route there) → pick case → detail confirm → **form menu** (when >1 case-loading form) → form. One case-loading form skips the menu.
- **Forms-first module** (a registration form needs a fresh `case_id_new`, breaking the shared datum): the form menu first; tapping a case-loading form → case list → confirm → that form.
- **Display conditions gate these running lists as the device would** (`lib/preview/CLAUDE.md` § Lookup carriers): the home screen's modules, the forms-first menu (session-only), and the case-first post-selection form menu + single-form auto-continue against the SELECTED row — the eligible set drives the menu-vs-skip decision, and a seeded target whose condition is false for that case falls back to it. Hidden entries stay reachable through the ghosted "Hidden items (N)" reveal; edit-mode canvases never hide.

Selecting a case never silently defaults to a form — picking records `previewCaseTarget` (session store: the chosen case-loading form + `caseId`); `PreviewShell` grafts that `caseId` onto the form screen so `FormScreen` preloads it. A module with no case-loading form ⇒ the list is informational. The target clears on every preview toggle. CommCare emits no register-from-case-list shortcut (`case_list_form.form_id` stays null), so case-first modules are purely list → form menu.

The three edit canvases are direct composition surfaces. Search draws its real
input stack; Results and Details arrange stable, label-first information rows.
They deliberately do not sample one arbitrary case beside every field — real
values, variation, and empty-data behavior belong to the global Preview.
Authors add and move rows where workers will encounter them (handle-focused
ArrowUp / ArrowDown / Home / End is the keyboard equivalent), so arrangement
never leaves the center canvas and no horizontal table geometry leaks into
authoring. **Add search field is chooser-first**: it asks which canonical case
property people should search, places Case name first as guidance rather than
silently choosing it, and applies the working widget/match defaults only after
that choice. **Add information is always chooser-first on both display
screens**: it semantically mixes saved display setups absent from this screen
with case properties that have no display definition, never exposes “hidden”
as a category, and never guesses the next property. App-authored information
plus Case name is primary; niche system information is a quieter secondary
group. Selecting a saved setup restores its label/formatting, while selecting a
property creates an explicitly bound definition through granular `addColumn`.
Calculated values and the deliberate second-view path for an already
represented property remain discoverable as quiet footer choices rather than
competing with normal information. Every saved definition is valid
unconditionally, including one hidden from both layouts and absent from sort,
so revealing it is an ordinary presentation edit with no repair state.

The selected field's inspector ends with the reversible **Hide from
results/details** action followed by destructive **Delete information**; rows
never carry a one-item More or trash button. Hide changes only the active screen
and leaves the complete valid setup ready to add again. Delete uses granular
`removeColumn`, removes the shared display definition from Results, Details,
and Default order, and explicitly states that the case property and stored data
remain. It is disabled whenever the column is the last visible Result —
including when selected from Details. Results must keep one visible field so
cases remain pickable; Details may be empty.

Results and Details own independent presentation orders — the config's `listColumnOrder` / `detailColumnOrder`, two sequences over one set of columns; moving a Results row must never move the Details row. Search owns only **Search fields**, the worker-facing input stack. Results owns the always-on **Cases available** rule because that rule defines the population the result list presents. Its complete recursive Predicate AST is edited directly in the center canvas, above the expandable **Default order** composer. A focused AND / OR group shows its immediate conditions with friendly **All conditions must match** / **Any condition can match** choices; its summary and root action stack at the workbench's narrow container breakpoint rather than compressing either label, while every action retains a 44px target. Nested groups, exclusions, search-answer gates, relationship conditions, and calculated values open in the same full-width focus-and-context workbench. Back and breadcrumbs return through the authored tree. Adding a condition appends a valid **is** seed to the focused level, and no projection flattens, approximates, or discards nested structure. There is no filter selection or filter inspector; the right rail remains only for a selected field's source/formatting/behavior and secondary screen options that have no manipulable canvas representation. It never duplicates screen membership, visible order, case availability, or default case ordering. A search field's custom match condition and the Search button's display condition follow the same rule: the rail shows one concise summary and Add/Edit/Clear actions, while `search-condition` selection opens the sole full editor in the center, preserves Search's scroll position, and returns to the owning field or panel. Selection lives in the shared workspace controller (per module — reset when the module identity changes under the never-unmounting controller), cleared on tab switches and Esc — Escape must register through `useKeyboardShortcuts` (the manager preventDefaults matched keys; a raw listener never fires, and later registrations win), and only while the workspace is actually on-screen so a bare Escape still reaches the layout handler.

The chrome's global Preview toggle is the only interactive run-through. It assembles the real Search → Results → Details behavior, so authoring never duplicates a second set of preview controls. While running, that control names the return action (**Back to edit**) rather than presenting a media-style pause button. If Preview has not moved to another running-app surface, exiting preserves the Search / Results / Details authoring tab it entered from; once a worker opens a case record, the visible running Details surface exits to the Details authoring tab rather than resetting to Results. The workspace tab strip is a fixed, non-scrolling sibling of the active body: only the body scrolls, each tab's scroll position is preserved independently, and switching tabs restores that tab where the author left it. The tabs keep the concise Search / Results / Details labels visible with both sidebars open; their decorative icons step away only at the smallest canvas container width, while the text and accessible names remain. In an exceptionally short viewport the strip reduces only its outer padding (its 44px actions stay intact), and the body must retain positive height plus its own scroll range. Attention dots appear only when a screen contains something to fix. On desktop, a Structure or Chat collapse/expand control that is replaced by the state change must hand focus to its visible reciprocal control. Narrow Chat uses the Base UI drawer popup as its initial focus target rather than a tooltip-wrapped header action, so one Escape closes the drawer and restores its retained rail or dock trigger, including with reduced motion.

Running Results rows keep their full-row case action and every authored cell action as sibling controls. Phone links and value explanations remain independently focusable, keyboard/touch usable, and at least 44px; activating one never opens the case. Never place an interactive cell inside the row's primary button.

**Results arranges its fields as rows or as a tile, and the switch lives on the canvas** (`tile/TileLayoutToggle.tsx`, beside the *Information shown* heading) — not in Module settings, which owns the module's MENU appearance and isn't even mounted in this workspace for a form-bearing module. Choosing Tile replaces the row composer with a 12 × 12 grid (`tile/TileGridEditor.tsx`); its cell geometry comes from `lib/preview/caseTileLayout` so the authoring grid and the running tile can never derive differently, and the occupied extent is drawn distinctly from the canvas because the device stretches that extent to the list's full width. Everything the arrangement can do routes through one pure model, `tile/tileModel.ts`: a gesture (drag, arrow key, Shift+arrow resize, typed number, preset) yields either a placement or a stated refusal, and a refused drag holds the last valid place with its reason on screen instead of snapping back. Six consequences bind any change here:

- **Turning the tile on lands a working layout.** `tile/tileMutationPlan.ts::planTileLayoutEnable` seeds a place for every field that lacks one and commits those placements in the SAME gated batch as the switch — the switch alone introduces `CASE_LIST_TILE_COLUMN_NOT_PLACED` and would be refused. Turning it OFF writes only `tilePatch: null`: every cell survives, inert and valid, so switching back restores the drawing. What can't survive is `persistOnForms` (there is no tile to keep on screen), so that switch confirms the loss first rather than letting the setting vanish.
- **Anything JOINING Results on a tile carries a RE-ADJUDICATED place.** Add
  information, an off-screen reveal, and a rebuilt column body
  (`preserveIdentity.ts`, whose swap otherwise drops the cell) all go through
  the gate as one batch with a placement from
  `tileModel.ts::placementForJoiningTile`. A saved cell is honored only while
  it still fits and is free: hiding a field removes it from tile membership, so
  that square may be reused and a later reveal receives a fresh valid
  placement. A full tile is stated at the gesture (Add information disables; a
  reveal announces) rather than dispatched.
- **The tile lays out exactly what Results shows.** A column hidden from Results needs no square whether or not it drives Default order — an ordering one still reaches the wire, but as CommCare's reserved zero-width carrier, which draws nothing. `tileShowsColumn` is the single home of that decision, and a hidden column's stored cell is inert, kept so showing it again restores its place.
- **Presentation exists only for a placed cell.** CommCare's `<style>` cannot exist without a complete `<grid>`, so alignment / text size / border / shading are offered only for a field that holds a place. Absent text size is offered as *Same as the list* — a real first choice in its own menu, because the runtime inherits and has no `medium` default — and border/shading carry the tile-wide consequence in their own words because the runtime computes one boxed/flow mode across the whole tile.
- **Presets are gestures, never slugs** (`tile/tilePresets.ts`). They fill per-column placement only — a preset never touches presentation — and each states why it can't run rather than being silently absent.
- **Tile findings ride `tileIssues`, deliberately outside `brokenColumns`.** A
  tile problem is a Results problem; folding it into the shared set would badge
  the same field on Details, where nothing is wrong. Results unions the two
  itself, and a place outside the grid is drawn in the attention strip below
  the canvas rather than on it (an out-of-range `grid-area` would grow implicit
  tracks and stop the canvas being 12 × 12). `tileLayoutIssues` sees only
  columns the tile shows, so an off-tile saved cell reports nothing. **Saved
  tile place** therefore offers its numeric controls and removal
  unconditionally; a reveal receives one valid re-adjudicated placement.
- **The grid's floor is arithmetic.** A chip insets itself 2px per side, so a 44px pointer target needs a 48px square: `min-w-[36rem]` (12 × 48) and a 3rem row, scrolling sideways below that rather than shrinking. Change one of those three and re-derive the other two.

Rules that aren't enforced by tooling:

- **Add affordances land WORKING entities without inventing intent.** Search first asks which property, then binds that exact canonical choice (never unbound — an unbound field matches nothing and reads as "search is broken"), takes its human label and a legal unique wire name, matches the widget to the property type, and gives text properties fuzzy match. Results/Details follow the same chooser-first rule, then build the working display definition for that exact choice; the explicit Calculated value choice seeds a valid empty-string expression and opens its editor, while Show information another way asks for the already represented property before adding a second definition. The same bar applies to custom→standard match conversion and property changes; hand-typed labels/names are never overwritten.
- **Picker vocabulary is familiar words with exact descriptions**; items a property's type can't run are disabled with the reason, never selectable into a validation error.
- **Authored names are content, not decoration**: they wrap inside rows and picker items instead of truncating or widening the workspace. Search feedback stays concise and never repeats an unbounded query that is already visible in its input.
- Removing a Default order item hands focus to the next or previous item, then to **Add to order** when the sequence is empty; an unmounted row action never drops keyboard focus onto the page. Clearing a Search-action condition or the Results root rule likewise focuses its replacement **Add condition** control.
- **Every interactive control is at least 44px tall, carries a visible text label, and hover text rides the shared `Tooltip`** — never a native `title=`.
- **Material's communication rules apply to the entire workspace, not one editor.** Use sentence case, familiar outcome language, a consistent readable type scale (12px minimum metadata, 13px helper text, 14px body/control text), and the repo's shadcn/Base UI wrappers. A confirmation title names the decision in the user's own verb and object (**Show all cases?**), never a conditional sentence about what the system may do; its body explains the consequence and recovery in one or two short sentences. Destructive dialog actions stay on one row and use concise verbs such as **Cancel**, **Delete**, or **Replace**. The action that opens a destructive/reset confirmation still carries the rose destructive treatment; confirmation is a safeguard, not a reason to visually present removal as neutral. Placeholders describe genuinely empty input; a displayed default belongs in the input value. Nova's visual theme decorates this hierarchy but never replaces it with terse system vocabulary, numbered badges, all-caps labels, or technical wire names.
- **A body never re-titles its panel** — the inspector header already names the entity; bodies open with content, not a second heading. Reversible visibility and destructive deletion actions stay the body's LAST rows. Search-input deletion uses `RemoveRow`; Results/Details place neutral eye-off Hide before confirmed Delete and never imply that deleting the display setup deletes case data.
- **Preview is the only place the Search button exists or submits.** Edit mode exposes the action-oriented **Edit Search screen** instead of depicting a non-functional app button. The input-free path uses **Change when people continue**, not a technical settings label. No in-canvas Preview affordance — the chrome's global toggle owns the run-through.
- **Search fields are one source** (`caseListConfig.searchInputs`) across authoring and the running Search -> Results flow; screen labels and the Search-action condition live in the separate `caseSearchConfig` slot. Owner availability shares that storage slot but has one authoring home beside **Cases available** in Results, progressively disclosed under **More availability settings**: an absent exclusion is **Show in Results**, exactly `term(sessionContext("userid"))` is **Hide from Results**, and every other valid global `ValueExpression` appears only as a read-only **Keep existing rule** state. Replacing a saved custom rule with either standard option requires a consequence-first confirmation, and no ephemeral in-memory recovery is presented after replacement. The builder never exposes the custom rule's expression editor or lets a normal author create one. Owner-only storage is an exact arm and cannot carry Search inputs or Search-screen presentation.
  Owner exclusions constrain Results immediately, with or without Search input or submission, and the Results summary, count, and contextual empty state include them. Owner-only configuration never creates or auto-launches Search. A worker sees the Search input screen only when at least one input exists. Removing the final input always confirms that the screen will disappear; it removes screen-only title/subtitle copy while preserving any authored Search-action label/condition and the independent owner rule.
  With zero inputs, an explicitly enabled Search action auto-launches on web when an effective **Cases available** rule exists and the action is relevant. Without that filter it remains a manual action on the ordinary case list. The Search canvas describes the actual shape without depicting copy for a screen the worker never sees. An always-on `caseListConfig.filter` by itself never invents Search. Clearing the final availability rule removes only a presence-only marker; authored Search-action or owner settings survive.
  Choosing **Always allow Search** confirms before removing a saved Search-action condition. Empty Search enable/disable, final-input cleanup, and owner-only availability ride the canonical semantic fields on `updateModule`; fresh-state reducers preserve peer-authored settings, inputs, and filters. An absent `caseSearchConfig` projects the authored default at preview/wire time.
  Authored information labels stay primary in property pickers (readable-name qualifiers appear only for collisions), while the search input's internal reference name and niche action condition stay behind **More settings** disclosures that open automatically when an active setting needs attention. Pickers and seeds consume the exact effective catalog: `case_name`, `external_id`, and `date_opened` are the only Nova spellings for those standard values, and rejected CCHQ detail names never enter a live Builder state. Every predicate/expression leaf stores the search input's UUID; renaming changes only its projected saved name, so no reference rewrite occurs and a peer may safely reuse the old name. Removing a referenced input never cascades: `searchInputRemovalDependencies` groups every exact AST occurrence by its friendly owning surface, and the review dialog routes to the first occurrence in Cases available, a sibling search field's condition or starting value, a calculated column's formula, Assigned cases, or the Search button's display condition. Returning recomputes the live dependency set; zero uses closes review and restores focus to **Remove search field**. The always-on rule and a search field may narrow the same property: they intersect at runtime, an empty input leaves the base rule alone, and a disagreeing value legitimately returns zero cases.
- **Date range is one paired widget, not a mode layered onto a one-date field.** Choosing **Between dates** atomically changes the field to **Date range**; switching away changes it back to a single-value widget. A date range has no **Starting value** control or scalar `default` slot because one value cannot honestly seed both ends. The mode transition commits the complete target arm atomically.
- **Workspace findings are config-derived, not editor-derived** — the workspace re-derives the whole-config verdict purely, independent of which Activity-preserved tab is visible, mirroring each editor's verdict source so they can't disagree. The same derivation drives the per-tab error dots AND findable canvas marks (`caseListConfigVerdicts` — one walk; a tab dot must point at a visible row, the **Cases available** composer, or an off-screen definition inside **Add information**). Filter findings always route to Results and mark the directly editable condition surface, never Search or a nonexistent filter inspector. The workspace reads the EFFECTIVE case types (`useEffectiveCaseTypes` — the same view the commit gate's validator resolves against, with honest-unknown-permissive column applicability), never the raw catalog. The builder-level **Case data** manager uses `useMaterializableCaseTypes` for case-row creation/replacement (the insert schema's exact shape) and the effective view for its app-wide property inventory, including implicit standard values. The running-app list consumes the materializable view. Case-data creation/replacement never appears inside simulated Preview, and edit mode does not fetch a case merely to decorate its arrangement rows.
- **Case data owns app-wide property identity; “Saves to” owns one field binding.** The field inspector's `CaseWriteEditor` replaces the former property editor outright. It chooses or clears one complete `{caseType, property}` destination, includes declared properties that currently have no writer, and creates a new property only as the complete pair in the same gated batch; field ID remains independently owned and the visible expression projection stays readable as `#<case-type>/property` (for example `#patient/status`). The breadcrumb's **Case data** control is available wherever the app has case types and is the one home for the full property catalog. Standard row scalars remain visible and locked. Editors may author one simultaneous, lossless rename relation across custom properties; swaps, chains, and cycles are supported, while merges, overwrite-by-rename, temporary spellings, and aliases are not. Review is derived from the exact document rewrite walker, then a read-only server preflight counts real rows and held values; a changed mutation cursor requires Review again. The modal remains pending until the exact admitted rename batch is acknowledged. Viewers see the same inventory without rename controls.

## Data review (`data-review/`)

The module-scoped canvas screen (`/build/{appId}/{moduleUuid}/data-review`, edit-mode only — preview shows the running case list for its URL) where saved values a type conversion couldn't carry are put back, overwritten, or dismissed. **The unit is the CASE, and the hold is real**: a case with any active (undismissed) kept value is HELD out of the running app — excluded by default from every case-store read (`QueryArgs.includeHeld`, query/count/form loading/search all inherit it), released the moment nothing is left waiting (every value put back, overwritten, or dismissed; a dismissed entry moved back to review re-holds). Storage stays per-value; availability is per-case. There is no occupancy verdict — nothing can land a newer value in a held slot — so `standing` is `fits` / `blocked` / `undeclared`, and an explicit Put back OVERWRITES whatever the slot holds (a narrow-options flush's surviving subset, a rename's standing destination value); only the review's human decision overwrites — the saga compensation and the convert-back auto-restore never do. **Vocabulary is plain words only** — no coined terms ("set-aside"/"park"/"quarantine" never render; a hyphenated compound invented for the feature reads as jargon the user was never taught): values were "kept", the screen is "Data to review", the restore verb is **"put back"** (always with a success toast naming where the value went — an entry silently leaving the list reads as "no idea what that did"). **Reassurance lives in the verbs, never appended disclaimers** — "kept" and "moves to the Dismissed list" already say nothing was deleted; a trailing "Nothing was deleted." on every surface is banned repetition. **The header explains the interface once; each row then tells its own story in one clause.** The page description states the mechanism (a saved value that no longer fits holds its case out of the app), the actions, the release (nothing left waiting → the case returns), and the automatic return on a type change back — there are NO per-property notice cards collating "convert back" prose above the list. Under each row's chip + value sits the standing phrase (`standingPhrase` in `dataReviewModel.ts`): a short present-tense fact mapped from the server-classified `standing` — "Isn't a date" / "Isn't a single choice" (blocked; the type word comes from the same declaration the chip icon reads, so they can't disagree), "The property was removed" (undeclared), "Fits the property again" (fits). Never park-time history replayed as if current (`fromType`/`toType`/`reason` are captured at park time and go stale; `reason` is developer voice and never renders), never a paragraph. A select block is always a SHAPE mismatch — the stored select schema carries no option enum, so a narrowed-away value stands fits (its case is held; put back overwrites any surviving subset), never blocked-on-membership. **The CASE is the anchor**: one card per case with its waiting values as rows (people review records, not floating values), and each card's **View case** opens `CaseDetailDialog` (the ONE read that passes `includeHeld` — it exists to inspect a held case) — the whole record as a scrollable vertical table (declared properties in catalog order, then undeclared saved keys; select values render their option labels; loading renders a `Skeleton` table in the final column geometry) — so decisions are made against the record, not a floating value. **Identifiers render as `NameChip`** — a variant of the typed case-property reference chip (`lib/references` case-family tint + `CHIP` constants; wrap-enabled and selectable, unlike the editor chip) carrying the property/case-type ID in mono, never a humanized label and never inline prose. A declared property's chip icon is its CURRENT data type (`DATA_TYPE_ICONS`, the same icons the field palette uses) — that icon beside the literal old value shows the mismatch the standing phrase states; an undeclared property keeps the case family's database mark. Used in rows, the Replace editor, the case dialog's table, and the Case data popover's case-type reference alike. Two filter pills — **Ready to review** (active) and **Dismissed** — partition the list; the Dismissed pill disables at zero and the effective filter falls back to Ready when the last dismissed entry leaves. **A row offers every action that works for it**: Put back when the value fits again (`standing === "fits"`; a human decision made against the whole record — it overwrites the slot, and anything non-redundant it displaces is archived as a new dismissed entry, reported in the toast), **Overwrite** whenever the property is still declared (one name through the whole flow: the row action opens the editor, whose commit is the warning-styled **Overwrite value** button — amber `warning` Button variant, no forward-explaining footnote; the outcome toast reports the original archived under Dismissed), and Dismiss always; NO Put back or Overwrite when the park's property is no longer declared (the store rejects an undeclared patch key on every save). A DISMISSED entry is never restorable directly — the store's dismissed gate keeps a stale client's Put back — its one action is Move back to review. A button that couldn't work is never rendered at all, let alone disabled beside a live one — and every action keeps ONE fixed appearance on every row: all ghost with an icon + label, constructive actions (Put back, Replace, Move back to review) in violet action text held through hover, Dismiss in secondary. No per-row "primary" promotion — a variant that changes with the row's sibling buttons reads as random emphasis. Discovery actions that land on this screen (the popover's Review data, the conversion toast) exit preview first — in preview the URL renders the running case list, so the press would read as a no-op. Derivations (case grouping, filter partition, standing phrases, Replace-draft normalization) live in the pure `dataReviewModel.ts` and are unit-tested there; the temporal arms of that normalization hand off to `lib/domain/temporalValues.ts`, so a value put back here is stamped exactly as the identical value entered through a form — a datetime takes the EDITING VIEWER's offset (not `Z`), because that is what the device stamps and what the viewer-local `format-date` reads back; the `standing` verdict is server-computed per entry (`listParkedValues`) and never re-derived client-side. The Replace editor's temporal inputs are the shadcn primitives: date (and the date half of datetime) is `DatePicker` (`components/shadcn/date-picker.tsx` — the same component the running Search screen's date prompts wrap; NEVER a native `<input type="date">`/`"datetime-local"`, whose browser picker pops over Nova's theme, and never a hand-assembled Popover + Calendar), and the time half is `TimeField` in the locale's clock (example "2:30 PM", never a 24-hour spelling worn as theme) whose hand-typed value `replacementDraftToValue` parses strictly through `lib/ui/clockTime.ts` (12-hour or bare 24-hour, shape + ranges) instead of trusting. Discovery is the reconciler's conversion toast (action → this screen), the amber dot on the Case data trigger, and the popover's review section (HELD-CASE count via `heldCaseCount` + Review data button, no property list — the discovery surfaces speak in cases, the unit the app is missing) — all fed by ONE `useParkedValues` list on the shared case-data invalidation channel. The builder's case-data population count (`loadCaseCountAction`) passes `includeHeld: true` — the manager governs stored rows, held or not. There is no tree node — the screen is reached from those signals and shared links.

## Project data (`project-data/`)

The URL-owned workspace for the Project's shared data tables
(`/build/{appId}/project-data[/{tableId}]`), rendered by `ProjectDataWorkspace`
as a centre-canvas surface beside App setup, the case workspace, and data
review. It reaches the author from the expanded sidebar's footer, the collapsed
rail's footer, and therefore the handset structure drawer — never as a tree
node. The `Location` kind carries **no `moduleUuid`**, which is what makes the
boundary structural: every module-keyed helper branches on it explicitly and the
compiler finds any that doesn't. Preview from here leaves for the app home; a
lookup table has no running counterpart.

`ProjectDataWorkspaceProvider` is the single controller, mounted above the
builder row in `BuilderProvider` beside `CaseListWorkspaceProvider` and for the
same reasons — one fetch plus scope-keyed selection, row-draft, and conflict
state shared by the canvas and rail, and a host element whose type never changes
so the subtree cannot remount and sever chat's live run.
`useProjectDataInspector` is the rail's third selection source; the three are
mutually exclusive because the URL makes them so.

**The grid scans; the rail edits.** Cells are typed, and a date column needs
`DatePicker` while a time column needs `TimeField` — floating surfaces that
cannot live in a dense scrolling cell with a 44px target. So the grid is a real
`<table>` in pages of `ROWS_PER_PAGE` (50, matching the running case list) with
a search box over the text it displays, a selected row opens in the rail with
one correctly-typed control per column, and bulk change goes through CSV
replacement. Paging rather than virtualizing is a semantics decision first: it
keeps `<th>`/`<td>` header association and screen-reader table navigation that a
virtualized ARIA grid would have to hand-roll.

**Every dirty row draft and unresolved conflict lives on the CONTROLLER, not in
the row's body.** Close, Escape, another selection, route navigation, row
deletion, and table deletion all unmount the body; none is consent to discard.
The controller keys sessions by Project/table/row, the grid marks and reopens
them, and the table list has one navigable **Row work to review** entry for every
retained session — including conflicts with no dirty edit and tables deleted
while another route was open. A missing table renders a read-only local row copy
from its last authorized snapshot; recreating the same name under a new UUID
does not revive it. Inspector Close only hides; Save and explicitly labelled
discard buttons clear, even when edit access was revoked and the retained values
must render as read-only text. Row/header controls carry their stable identity;
Close/Escape resolves that exact control after selection clears and temporarily
marks it for Base UI's narrow/handset drawer final-focus callback, with the
table's back button as the missing-origin fallback.

Every row editor captures an immutable edit-session baseline: the row, ordered
columns, and table revision as they stood when editing began. A pristine editor
follows realtime; the first edit stores a controller session and every later
save compares against its original baseline. Save-conflict drafts are
reprojected onto the exact fresh columns: stable same-type temporal cells keep
lossless metadata, retyped cells keep raw text but validate as the new type,
and an invalid date/date-time spelling stays visible and copyable beside a
picker that cannot display it. New columns are editable, and removed authored
values are separately retained behind a mandatory acknowledgement. Resolution
buttons accept only parsed fresh-schema values and write against that displayed
generation. If the row is gone, Save as a new row appends, selects the returned
row id, and the grid clears any search and reveals its page. A failed resolution
leaves the conflict and draft on screen.

**The conflict policy lives in `projectDataModel.ts`, pure and unit-tested.** A
table's optimistic token is `max(definitionRevision, rowsRevision)`, so ANY
concurrent change invalidates it. `rowWriteConflictVerdict` retries only when a
fresh read proves the edit is still the same edit — identical row values AND
unmoved columns, because a retype changes what a draft means even when its cells
match — and otherwise shows both versions and asks. `replacementConflictVerdict`
is unconditionally "ask" and a test pins that it can never return `retry`: a CSV
replacement discards every row by definition, so drift is exactly the case where
resending destroys the change. **The draft is never discarded, in any branch.**

One CSV choice is an atomic `LookupCsvSelection`: File, copied bytes, filename,
row count, checked columns/fingerprint, Project/table id, definition revision,
table revision, and the row count it will replace. A monotonic generation makes
the last-started `arrayBuffer()` read win. Project, schema, or row-generation
drift disables Replace until the same bytes are checked and explicitly reviewed
against the latest table. No replacement conflict retries itself, and Dialog
close, Cancel, and file selection are blocked while the upload is in flight. The
native file input clears after capturing the `File`, so the same path can fire a
new choice after a read failure; diagnostic overflow counts subtract the eight
entries actually rendered.

Row drafts store raw text without trimming. Empty text, whitespace text, and an
absent UUID key stay distinct. Time and datetime controls hide storage's
required RFC 3339 timezone suffix while retaining the original suffix and exact
stored spelling — including fractional seconds — for a no-op round trip.
Type-away/type-back is still a no-op because immutable source metadata survives
intermediate edits; edited existing clocks keep their offset, and new temporal
values use `Z` because Nova has no authored app timezone. Viewer rows/columns
render as read-only text, never disabled form controls.

Table name, table export-tag, column label, and column wire-name drafts use the
revisioned-text model in `projectDataModel.ts`: pristine drafts reseed from
realtime, dirty drift requires an explicit Use current / Keep my draft choice,
and writes carry the captured revision. Export tags render on both table screens
and only `delete`-capable authors receive the editor.

Destructive changes (delete table, remove column, retype column) go through
`DestructiveChangeDialog`, which NAMES the apps that would break — including one
in the trash, said as such, because a blocker the author cannot find reads as a
phantom. Its pre-flight read is advisory; the transactional edge check is the
authority, and a refusal renders its own blocking set in the same words. It is a
real `alert-dialog` rather than the confirm-in-place pattern, so it needs no
`useInlineConfirmFocus` — the dialog primitives own focus entry and return. The
row-delete confirm inside the rail IS confirm-in-place and uses the hook.

The advisory preflight is a three-state gate: loading, successful (possibly
with named blockers), or failed with Try again. A failed query never becomes an
empty blocker list and the governed action stays disabled until the scan
succeeds. A transactional `referenced` refusal without resolved app names is
also an authoritative block; it renders **Check references again** and never the
empty-success sentence. An optimistic refusal adopts the returned current
revision, reloads the table, and reruns the preflight before another
confirmation is enabled.

The select's own editor entry (`editor/fields/OptionsSourceEditor.tsx`) owns its
one required `optionsSource`: either an inline source with at least two
UUID-identified options, or a complete lookup table/value-column/label-column
source with an optional row filter. A mode switch edits a staged replacement and
commits the whole valid source atomically; cancelling leaves the current source
untouched. No inactive source is retained. The editor consumes the builder's
shared rows-free Project table catalog and supplies its exact definition
generation to the optimistic client commit gate. Current
Project, manifest Project, definition Project, Project revision, table id, and
manifest/definition revision must all agree; unavailable, failed, mismatched,
cross-Project, and kept-stale context never authorizes a new reference. Equal
Project revisions make a double omission a deletion; any other settled mismatch
is a visible Retry that reloads BOTH resources instead of permanent Loading.
Both list and definition failures have a visible retry, a list failure never
labels the saved selection deleted, and the authoritative writer repeats the
verdict against fresh Project state before persistence.

## Display conditions (`conditions/`)

A module's and a form's navigation display condition are authored on their own
URLs (`/{moduleUuid}/condition`, `/{formUuid}/condition`), rendered by
`DisplayConditionCanvas` as a centre-canvas surface beside the case workspace and
data review. The module/form **settings panels** own the setting — summary plus
Add / Edit / Clear through the shared `ConditionSlotSetting` (extracted from the
Search panel's own row, which now uses it) — and Edit navigates to the URL,
because a recursive condition does not fit a popover.

**The screen leads with where the condition takes effect**, and that is the whole
design problem: the same form condition is checked on the case list in one module
and on the form list in another. `displayConditionCopy.ts` derives every word from
the carrier alone and is unit-tested, so the explanation cannot drift from the
scope the editor enforces. Three scopes now exist (`CaseDataScope`): `per-case`,
`selected-case` (one already-chosen case's OWN properties — relationship walks,
counts, and presence tests are withheld with the scope's own reason, because
CommCare cannot reach them from the case-list screen), and `global`.
`PredicateEditProvider` composes the matching admission oracle in front of any
caller oracle, so a new surface cannot silently offer a read the gate rejects.

Preview from a condition URL runs the surface the condition governs — HOME for a
module (entering the module would route straight past the screen its condition
decides, and a case-first module's screen redirects to its case list, rewriting
the URL), the form itself for a form. `FormScreen` and `ModuleScreen` therefore
accept their `*-condition` URL as identifying the same entity, and every other
Activity gates on `editingDisplayCondition` so exactly one surface is visible.

Removing a condition is confirmed wherever it is offered — the shared
`ClearConditionButton` carries the same words on the settings row and on the
canvas — and dispatches an explicit `null` (`lib/doc/displayConditionMutations.ts`
records what that spelling buys). Commits use the `inline` gate flavor: every
single choice the editor offers is admissible, but "never matches" is a property
of the whole tree, so a deliberately composed one is refused BESIDE the rule
rather than as a toast over a silently reverted edit. `allowsNeverMatch` is its
own axis, not a reading of `caseDataScope` — the Search action's condition is
`global` too and legitimately admits `match-none`.

## Case changes (`case-operations/`)

A form's ordered case operations are authored on `/{formUuid}/operations`, with
`/{operationUuid}` selecting one — the one form-owned configuration URL that
carries a selection, because a form can hold twenty changes and "look at this
one" has to be sendable. The form-settings panel's **Case changes** row states
the count and hands off; Preview from either URL runs the owning form.

**The list and one change's detail are mutually exclusive screens on that one
URL, at every width** — `PreviewShell` picks between them on `operationUuid`
alone. That is a decision, not a missing reflow: no width shows both, so adding
a master/detail mode would be a second layout rather than a responsive tune.
The cost is that walking a long sequence rests on Previous / Next and Back
rather than a visible list, which is what the 20-change end-to-end journey
exercises.

**The rail body is KEYED by the change** (`activeInspector.tsx`), and it is the
only rail body that has to be: it holds per-change confirmation state (an armed
removal, an armed action change), and Previous / Next changes only the
`operationUuid`, so an unkeyed instance is reconciled in place and one Enter
commits a confirmation the author armed for the change they just left. The
canvas siblings in `PreviewShell` key for the same reason.

**The list is the screen the platform never had.** Each row is a sentence
(`operationSentence.ts`) — a display projection with no semantics of its own,
same discipline as the display-condition summary printer — and shows the
conditions it inherits from earlier changes AT REST, not on hover.

**Both reorder gestures read ONE map**, which is what makes them structurally
unable to disagree: `caseOperationMoveVerdicts` (`lib/doc/caseOperationReview.ts`)
answers the move planner for every destination at once. Drag feeds it to
`useReorderableList`'s `canDropAtIndex`; the source is captured on the handle's
`onPointerDown`, which precedes dragstart, so the FIRST pointer move is already
gated rather than one frame late. Keyboard asks the same map through the pure
`planKeyboardMove` before committing. `commitMove` re-asks against the live
document and `view.move` re-plans at commit, so a peer edit mid-gesture cannot
slip an illegal move through — that path says the list changed rather than
silently doing nothing. **A refused keyboard move ANNOUNCES why and names the
operations**; that parity with the pointer's disabled drop zone is the point of
the unit. Refusals go to `role="alert"` (the screen is otherwise unchanged, so
the press would read as a no-op) while the polite region carries only outcomes
that DID something, so an author hears one sentence rather than two.
Moving to the current rank is a real no-op: no store
dispatch, or undo entry.
`dependent-reference` and `execution-order` stay distinct — the second is a
property of the submitted form, never the author's mistake, and the copy never
implies otherwise. **Three refusals, three sentences, and none of them is a
paraphrase of another** (`refusalCopy.ts`): a `reference` dependency names what
uses this change (or, when the moved change is the one that would break, what it
depends on); a `target-type` dependency names whose KIND OF CASE would change and
never says "makes" or "uses", because nothing is made or used and the reference
wording would name an unrelated change; `execution-order` speaks about the
submitted form. The copy layer never re-derives which of the two dependency
constraints refused — the planner carries it — and no sentence names the moved
change back to itself.

**AST in the canvas, choice in the rail.** The detail canvas owns the condition,
the name / rename / owner expressions, the writes with their per-write
conditions, and the links; the rail (`useActiveInspector`'s third source) owns
the discrete settings and removal. Adding is chooser-first and lands a complete
operation the gate already accepts (`seeds.ts`, proved through
`mutationCommitVerdict`); removal asks `removalPlan` first and, when something
depends on it, names each blocker and the exact slot rather than offering a
delete that would bounce. That list is `view.removalBlockers` — the REMOVE
planner's own answer, not a reference walk, so a blocker that depends on the
case TYPE is listed with no slot instead of vanishing and leaving the heading
over an empty list. Inline confirmations use `useInlineConfirmFocus`.

The owner slot additionally owns the app-scoped organization picker. A fixed
place is stored by row UUID; a reverse hop stores the destination level UUID
and the readable case type, then derives the nearest case-owning ancestor's
lineage key at emission. These two terms must be the complete owner expression,
so the generic expression card never renders them. Its location control offers
only live case-owning places and reverse destinations with a case-owning level
above them; the transaction remains authoritative for persona-specific
address-book reachability and races.
Organization location choices share `LocationChoiceSelect`: at the 10,000-row
store bound it searches by name or unique site code, pages 50 rows at a time,
mounts only that page's options, and runs cross-store candidate verdicts only
for that bounded page. Never replace it with a full `SelectItem` map or a
whole-snapshot verdict inside an unbounded `.filter(...)`; either one makes a
single open picker quadratic. A rejected candidate remains in that bounded
page as a disabled option with its exact refusal reason; filtering it out hides
the recovery path. Level authoring menus follow the same visible-reason rule.
A persona's assigned-place list follows the same 50-row paging bound, and its
order-preserving mutation planner deduplicates with a set rather than rescanning
the growing result. The Places hierarchy itself is an ordinary
paginated list of disclosures, not an ARIA treeview: its buttons own keyboard
interaction, while every row carries a visible, non-shrinking numeric depth cue
so compact-width indentation caps never make distinct depths look identical.
Collapsed level rows do not mount their editors or compute cross-store choice
verdicts; only the open row may scan locations. A custom place-value save sends
one UUID-addressed patch, uses `null` for Clear, and rebases the authoritative
response under every draft typed while that response was in flight. When an
active reverse-hop owner rule requires descendants below a newly created source
place, the add form collects the complete required branch and sends it through
the store's one atomic create rather than attempting invalid sequential rows.
Every candidate in the action, case-type, target, identity-key, multiplicity,
retype, and link-type menus asks `view.editVerdict`; a stranded downstream
consumer therefore disables the exact choice with the planner's reason instead
of allowing a commit-gate bounce. That reason is one present-tense line in the
builder's voice (`offeredChoiceRefusal`), never the commit-rejection report — a
menu item's reason span collapses newlines, and nothing was attempted to report. Choosing a different known target is one
`retargetCaseOperation` transformation: target identity and the type established
by all earlier creates/retypes change in the same gated operation patch, while
every other facet stays intact for the verdict to adjudicate. Update/close adds
at the end use that same rolling session-type projection and `addVerdict`, never
the module's stale original type. A link target follows the parallel
`retargetCaseOperationLink` intent: session/prior-create choices atomically
carry their rolling type, an exact expression keeps its AST and asserted type,
and `null` changes only the target (the required `target: null` unlink value is
assigned rather than treated as an optional-slot clear by the granular
reducer). Relationship copy names an extension's host but never promises a
lifecycle cascade: Nova and a default HQ domain close only the case explicitly
named by the submission, so closing a host does not close its extensions.
Runtime-expression link targets immediately mount the same full
text-scoped `ExpressionCardEditor` as the operation's own target; a blank or
out-of-scope case id is a submission-time fact and the running form refuses the
whole atomic submission inline. A saved lookup-carrier-bearing operation is
persistently read-only in both the rail and canvas with the shared carrier
reason; callbacks also fail closed before dispatch. It remains visible and
movable because the move envelope never serializes its hidden AST. Selecting an
already-active target dispatches nothing and uses the exact current value while
computing its verdict, so a new target's `idFrom` and an expression target's AST
cannot be replaced by the menu seed. Viewer rows remain navigation buttons:
details and previous/next traversal are view capability, while handles, add,
remove, and every authored control remain edit capability.

`useCaseOperations` treats the render snapshot as intent, never as commit state.
Every callback reads `docApi.getState()` at invocation. Full-shape edits rebase
only changed scalar/write/link slots onto that fresh operation, refusing a
peer-deleted logical target or same-key peer add before local mutation. Adds,
removes, and moves resolve their targets against the same fresh snapshot; move
announcements use the rank and list length after the synchronous commit, not
the requested index captured by the gesture.

Which answers a change may read is not decided here: `lib/domain/caseOperationScope.ts`
holds the rule and the validator calls the same functions, so `formFieldScope.ts`
only APPLIES it. Every expression slot mounts with the operation's FOUR scope
axes — `formFields` narrowed by multiplicity, `userProperties` (a
worker-information read is legal in an operation: `caseOperations.ts` puts the
slug catalog in its type context), `operationScope` for the submission-local
vocabulary, and `caseDataScope`.

**The last two are not one value across the screen** (`editorScope.ts` owns both
decisions, and `__tests__/caseOperationValidByConstruction.test.ts` drives every
slot × both module shapes against the validator rule itself):

- `caseDataScope` follows the FORM, not the operation or the module's landing
  order. `validateCaseSnapshotUse` refuses a case property, a relationship count,
  and a presence test in ANY slot unless this exact form opens with a case. A
  follow-up or close form therefore uses `"per-case"` even when a registration
  sibling makes the module forms-first; a registration or survey form uses
  `"global"`, and its seeds compare a session value rather than a property
  (neutral, so adding a condition does not change when the change runs until the
  author edits it).
  `"selected-case"` is deliberately not the middle answer: it admits the chosen
  case's own properties and the gate admits none.
- A RUNTIME TARGET slot — the operation's own "which case to change", and a link's
  "work out the id at the other end" — mounts `RUNTIME_TARGET_OPERATION_SCOPE`
  instead of the operation's own. `caseOperations.ts` refuses `id-of` anywhere in
  a target tree (target that create directly), so the create list is EMPTY there.
  Empty rather than absent, because the two owner sentinels stay legal.

## Predicate / expression card editor (shared)

Cross-workspace authoring surface for Predicate / ValueExpression ASTs; lives under `shared/` so workspaces don't import each other's chrome.

- **References are UUID identity, everywhere.** The shared editor reads and
  writes the canonical domain AST directly: form answers carry `field.uuid`,
  prior operations carry `opUuid`, Search answers carry `searchInputUuid`,
  custom worker information carries `userPropertyUuid`, and Project-data leaves
  carry table and column UUIDs. Labels, field paths, operation ids, Search names,
  lookup tags, and column wire names are display projections resolved from the
  current catalogs. A missing UUID stays an explicit unavailable reference; it
  never falls back to mutable text that could retarget it.
- **Valid by construction.** Every picker offers ONLY choices that keep the AST type-correct — a verb the current subject can't take, or a value type/source/kind the slot won't accept, is DISABLED with a reason (never dimmed-but-clickable), and a subject change that tightens a dependent slot reseeds it atomically in the SAME onChange (carrying the typed content where the new type can hold it — `cards/reseed.ts`).
- **Form answers and the submission-local vocabulary are an OPT-IN axis.** `formFields` (already narrowed by the mounting surface to what the commit gate accepts) makes **A form answer** a real term source with its own picker; `operationScope` makes `acting-user`, `unowned`, and `id-of` authorable and supplies `id-of`'s picker over the creates in scope. Both are optional and **absent means unauthorable** — a surface that does not opt in keeps the exact round-trip-only behavior it had, which is the whole safety argument (`__tests__/operationScopeFailsClosed.test.ts` pins it against the checker, not against convention). `buildEditorTypeContext` (`shared/editorTypeContext.ts`, a type-only-import leaf so the pure cascade-reseed helpers can reach it without closing a cycle through the card registry) is the ONE place either axis — plus `userProperties` — becomes a `TypeContext`. **That includes `cards/reseed.ts`, which runs inside an event handler where a hook can't**: the axes have opposite polarity at the checker (an absent worker catalog is permissive, absent `formFields` is fatal), so a reseed resolving against a narrower context returns `undefined` for a form answer, widens the dependent slot's accept-set to everything, skips the reseed, and commits the type-incorrect pair the gate then refuses. Every narrowed `PredicateEditContext` / `ExpressionEditContext` literal a card builds for a menu therefore carries all three axes forward.
- **A lookup filter owns one table-row scope.** Its context offers columns from
  that exact table, literals, worker information, and eligible earlier form
  answers. It omits case properties, Search answers, later questions, and
  answers in child or sibling repeats. The `table-column` card renders the
  current table/column names but stores their UUIDs; changing an export name or
  label never retargets the expression.
- **Which RUNTIME evaluates the rule is a second editor axis.** `PredicateEditContext.evaluationTarget` (`"on-device"` | `"case-search"` | `"on-device-and-case-search"`) decides whether a case-search-only capability is authorable, and the same axis is threaded through `ExpressionEditContext` so value-only carriers cannot forget it. Three of the four match modes — `fuzzy`, `phonetic`, `fuzzy-date` — exist only in CommCare HQ's server-side Elasticsearch compiler; CommCare Core's XPath dispatch registers `starts-with` and nothing else, and Formplayer shares that table (it adds only `here()`). Emitting one is not an install error — Core's dispatch falls through to a custom-runtime function with no arity check, so the app installs clean and throws when the expression is EVALUATED, which in a case list renders `<invalid xpath: …>` into the cell instead of failing. On-device date arithmetic is likewise narrower: only a whole-date base plus seconds, minutes, hours, days, or weeks is offered; datetime bases and months/years are disabled with the concrete reason before mutation. The capability tables and TypeContext-aware date classifier live once under `lib/commcare`; the editor reads them through `lib/doc/commitVerdicts.ts`, which evaluates the complete candidate before offering a value. **Absent means `"on-device"`, and that default is deliberately the STRICT one** — the opposite polarity to `caseDataScope`, whose permissive default means a surface that forgets it silently offers refused reads. A surface that forgets this one offers strictly less, with the reason visible in the menu. A case-list filter in a search-enabled module uses `"on-device-and-case-search"` because the same stored rule emits to both the ordinary device nodeset and the remote query: the editor therefore applies the CSQL and on-device oracles together. A pure server search keeps native date-add/datetime-add, but its non-native interpolated subtrees still take the on-device verdict through the shared dialect-state walker.
- **Raw XPath function names have their own carrier contract.** The text editor admits only JavaRosa-native functions, path initializers in their required path-root position, and extensions with a proven production lowering. Familiar XPath names are not evidence: Core does not implement `last()`, `substring()`, or XForm `here()`. `normalize-space()` remains friendly authoring vocabulary because the wire boundary lowers it structurally to native `replace()` calls. Preview declares a separate implemented subset and throws on unsupported evaluation instead of producing a plausible blank answer.
- **Evaluation scope is a required editor axis.** `PredicateEditContext.caseDataScope` (`"per-case"` | `"selected-case"` | `"global"`) states what the slot may read against a case row — see § Display conditions for the middle value, which admits one already-chosen case's own properties and withholds everything reached through a connection. `"global"` slots — a search field's starting value, the Search button's display condition — resolve once before any case is selected, so the registry drops every case-data-dependent verb (ordered comparisons, match, within-distance, multi-select-contains, exists/missing), seeds compare a session value (`sessionContext("username")`) instead of a property — and every UNCHOSEN placeholder is **truth-neutral for its destination**, because a global placeholder commits immediately and gates a whole surface (a false placeholder would hide the Search action before the author writes anything). The polarity is one bit, `PredicateEditContext.globalPlaceholderHolds` (default true — root and "all" groups; an "any" group's add-clause context flips it to false), consumed by `globalPlaceholder(holds)`; wrap siblings are intrinsically neutral for their combinator (`wrapSiblingDefault`: `and(p, true)` / `or(p, false)` keep `p`), and a fresh "Exclude when" inverts the bit for its inner clause. `__tests__/globalSeedNeutrality.test.ts` pins the actual truth values, the axis the type-check invariants can't see — and the `PredicateEditProvider` composes a case-data admission oracle in front of any caller oracle so value-source and calculated-kind menus disable property/relationship reads with one shared reason (`GLOBAL_SCOPE_CASE_DATA_REASON`). A relation walk's `where` and a count's `where` rebind to `"per-case"` (the destination row exists there whatever the outer slot). The field is REQUIRED so a new surface can't silently offer case reads into a global slot and bounce off the gate. So a user edit can never INTRODUCE a type finding. That is exactly as far as the two shared invariant tests reach, and no further: their oracle is the TYPE CHECKER, while the real authoring oracle is the COMMIT GATE, which is strictly stronger — `lib/commcare/validator/gate.ts` rejects every `soundness` and `completeness` finding on every commit, and the carrier rules report plenty the checker is happy with (a case read in an operation slot, an `id-of` in a runtime target, a match mode no device implements). Proving "the gate is never surprised" therefore needs a PER-CARRIER test whose oracle is that carrier's own validator rule; `components/builder/case-operations/__tests__/caseOperationValidByConstruction.test.ts` is the pattern, and it found three live offer-then-refuse defects on the day it was written. The allowed-set is computed live from the type checker's OWN forward rules — `useResolvedType` resolves a slot's subject through `checkExpression`, and the `SlotConstraint` factories in `lib/domain/predicate/slotConstraints.ts` delegate to the inverse helpers co-located in `typeChecker.ts` (`comparisonOperatorsFor` / `matchModesFor` / `compatibleTypesFor` / `valueExpressionKindResultClass`) — so the offered-set can't drift from the accept-set. Seeds bind a value of the property's OWN type (`seedLiteralForProperty`), never a stray text `literal("")`. **Nothing unfinished may be committed.** The gate has no tolerant class — `gate.ts` gates `completeness` exactly like `soundness` — so a "fill this in" state the editor commits is refused like any other finding. A slot that requires a filled value says so with `SlotConstraint.nonEmpty`, and every path that PRODUCES a value honors it: the text widget holds an emptied draft rather than committing it, and `termSeedForSlot` seeds something non-blank rather than `literal("")`. Where no complete value can be invented, the gesture is disabled with its reason instead — a verb switch to `match` stays disabled until the condition carries a value. Two pure invariant tests prove it: `__tests__/validByConstruction.test.ts` (admission ⟺ checker; reseed lands valid) and `__tests__/verbMenuBuildFuzz.test.ts` (every admitted verb build + every registry seed type-checks). Disabling per the SUBJECT, never auto-changing it, is what makes "**changing how you compare never loses what you compare**" hold.
- **Lookup-row scope is a separate required contract.**
  `caseDataScope: "table-row"` is paired with one `tableScope`, the rows-free
  Project-data catalog, and the earlier-form-answer catalog admitted for the
  active select. It makes only columns from the source table authorable and
  withholds case properties, relations, Search answers, later form answers, and
  answers from child or sibling repeats. Root answers and answers in the current
  or an enclosing repeat are admitted only when they precede the select in
  effective `(order, uuid)` DFS. `OptionsSourceEditor` derives that catalog from
  the same field walk the lookup validator uses, so the picker cannot offer a
  filter the commit gate refuses.
- **Conditions are readable clauses**: subject and verb share a compact first row; the value gets a full-width second row so editing never collapses into a strip of technical controls. A property remains the quiet common-case subject, but the subject is the full `ValueExpression` vocabulary — search answers, session/user information, relationship reads, and calculated expressions are all editable in place through `ExpressionPicker`, never reduced to replacement badges. Nothing titles a row with its AST node name. ONE verb menu holds every behavior plus a Structure group. Changing a verb carries the subject (and value where the target holds one) — **changing how you compare never loses what you compare**. Wrapping shapes (groups, not, when-field-filled) wrap the current condition rather than replacing it; only the always-true/false sentinels rebuild from defaults. **Always match** and **Never match** remain progressively authorable under that existing menu's **Special conditions** section; primary **Add condition** stays focused on common seeds and never duplicates those whole-condition replacements. Container kinds keep titled cards — a box's identity isn't expressible inline.
- Values are unboxed: their source menu uses friendly choices such as **A value**, **A property** (for a condition subject), **Another property** (for an object value), **Worker information** (a UUID catalog), **Other user field** (an explicit raw name), and **Calculated** rather than exposing AST vocabulary such as “Term” or “Typed Value”, so one menu answers “where does this value come from?”. The two user sources never infer or convert into one another. Absence checks disable only a literal placed directly at the subject root; literal inputs nested inside a calculation remain available because the checker permits them.
- Relationship paths are catalog-driven and lossless. Canonical parent steps follow the actual `parent_type` chain; child destinations use direct children, while any-direction destinations use the union of the parent and direct children. Optional case-type hints stay out of the common path when one destination is provable. A custom saved index can reach any declared case type and therefore requires an explicit destination; on a graph leaf, choosing a direction opens one atomic connection-name + case-type step so the editor never commits a half-configured relation. Saved missing or stale hints remain readable with a focused recovery choice. Link names draft locally and commit on blur or Enter only after passing the relation identifier's XML-name rule, so ordinary typing can never hit the commit gate and snap back. Multi-step walks preserve every link name, and structural removal rebinds only position-dependent canonical-parent hints; custom destinations remain explicit and nested conditions are never rewritten.
- `PredicateWorkbench` takes a `rootLabel` naming what the whole rule is called on
  the owning surface (default `"Cases available"`). It is the root breadcrumb, the
  "Back to …" destination, and the screen-reader "Editing …" heading, so it must be
  a lower-case noun phrase — the workbench folds it into those sentences.
- Every kind in both discriminator unions has a card; round-trip preservation is structural — a saved AST must render and re-emit without destruction, and every `ValueExpression` shape mounts its real editor rather than a placeholder badge.
- AST and mapping rows have no persisted UI uuid. Editable value-object lists MUST use the per-mounted `useStableListIdentity` sidecar and stage the exact local operation before dispatch: `replace` preserves keys, `splice` mints/drops only the named occurrences, and `move` permutes the same keys. The next cloned document snapshot adopts that staged vector; external snapshots reconcile exact references and canonical structural occurrences conservatively. React rows and DnD payloads consume the SAME per-occurrence keys, while each DnD container uses a per-mount `useId()`. Active scalar editors key only by stable authored path. This keeps focus, drafts, open pickers, and staged media through planner/reducer `structuredClone` boundaries without putting UI identity in the Blueprint or emitted wire.
- `CheckError.code + path` is the builder's diagnostic contract. The checker may retain detailed developer prose in `message` for validators, logs, agents, and tests, but visible editor feedback maps stable codes and paths to person-facing actions and never renders or parses raw checker messages.
- The validity plumbing (`useValidityPropagator` + its WeakMap per-row shadow, the inline `InlineError`, `configValidity.ts`) is a DISPLAY BACKSTOP, not the authoring guide: new edits cannot reach an invalid state, so it renders malformed imported or corrupt persisted ASTs for repair — the disable gates exempt the node's CURRENT verb/kind/source/shape so a broken value still shows. `OptionalSlotCard`'s slot-presence short-circuit is load-bearing: an undefined slot reports valid regardless of stale inner shadows.
- `setOptionalSlot` drops cleared keys by destructuring — the doc store applies module patches via `Object.assign`, which would persist `key: undefined` as a real own property and break `key in config` checks.

## Preview data binding

Server-only I/O (`caseDataBindingHelpers`, `import "server-only"`) is split from the client-safe surface (`caseDataBindingClient`) because `@google-cloud/cloud-sql-connector` would otherwise leak into the client bundle. Client code imports values only through the client module; vitest aliases `server-only` to its shipped shim because vitest ignores the `react-server` export condition.

Running case-list cells and Quick Filter share `columnCellRenderer.tsx::projectColumnDisplay` as their semantic-text boundary. The projection receives the effective property catalog, resolved calculated temporal types, and one shared `today`; the renderer, row action name, and filter all consume its `text` instead of independently coercing storage values. This keeps option labels, formatted dates/intervals, image labels, localized calculated values, and `Yes` / `No` answers searchable exactly as shown. JSONB multi-select arrays never surface as debug JSON, and malformed/structured values use a keyboard- and touch-accessible disclosure rather than a hover-only explanation.
