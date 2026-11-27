# Step 7. Finish Nova’s HQ round trip

A person who brings in an app should be able to change the way a worker finds a case, answers a question or
submits a form, then publish back to the same HQ app. Step 6 shipped that process for the vocabulary Nova
already held. Step 7 adds the remaining app vocabulary and proves which parts can travel with an app and which
need resources or authority in the destination project space. The original research ends here. The XForm chapter
is group 8 of this step.

## Starting point and work order

This plan reads shipped Nova at `9a6dc789`. Its [manifest](../../../lib/commcare/surface/entries/) has 1,400
inventory entries. Of these, 299 have disposition `HELD-NEW` and a Step 7 owner. Another three
[reading circumstances](../../../lib/publish/hqFindings.ts) have an owner. The six upstream source revisions
examined for this plan are HQ `d6c6e16d8ae1`, Core `8e9ba8d908e9`, Android `7a5584475580`, Connect
`046c7fd78081`, Formplayer `24383ac71bfb` and Vellum `01215f251c57`. The first five are recorded in
[proof/pins.json](../../../proof/pins.json). Vellum is the revision vendored by that HQ build.

| Group | Starting entries | What the team can do when it ships | Design and delivery slices |
| --- | ---: | --- | --- |
| 1. Project data | 13 + 3 circumstances | Bring in rich lookup values, place assignments and larger resources. See which data a worker can actually use and what another destination needs. | [Project data and settings](step-7/project-data-and-settings.md) |
| 2. App settings | 10 | Edit app-wide behavior, ownership, presentation and languages, including the settings that require action in HQ. | [Project data and settings](step-7/project-data-and-settings.md) |
| 3. Question display | 63 | Choose the actual input and choice presentation and language-specific media seen by the worker. | [Question display and case views](step-7/question-display-and-case-views.md) |
| 4. Case lists and details | 61 | Author the columns, orders, detail layouts, related data and conditional content a worker sees. | [Question display and case views](step-7/question-display-and-case-views.md) |
| 5. Menus | 22 | Author menu relationships and the paths to a case, form or registration, preserving the correct worker context. | [Menus and case search](step-7/menus-and-case-search.md) |
| 6. Case search | 45 | Set up search inputs, matching, result views and target-bound search in the workflow that uses them. | [Menus and case search](step-7/menus-and-case-search.md) |
| 7. Forms and case management | 45 | Select and update the intended cases in the right order, including when a form reuses another form. | [Forms and XForms](step-7/forms-and-xforms.md) |
| 8. XForms | 40 | Edit the remaining question kinds, data structure, load behavior and Connect content that the supported form builder can maintain. | [Forms and XForms](step-7/forms-and-xforms.md) |

Numbers identify feature ownership. Some implementation slices cross group boundaries. Each slice in the linked
designs includes its reader, writer and author-facing behavior. These shared pieces ship with their first
complete use.

1. Group 1 establishes typed lookup cells and attributes, identifier validation, and worker-scoped access to
   Project data. Group 2 reuses that identity and worker context for settings. Worker assignment for lookup
   access and ownership for a new case have separate rules.
2. Group 3 establishes localized media resolution at the actual carrier. Group 4 reuses it for case views. Group
   4 owns named case relations, result typing for an index walk and the first record-slot functions. Groups 5,
   6, 7 and 8 extend the same checked expression vocabulary where their consumers support it.
3. Groups 5 and 6 land the distinct parent-search result name, the parent selection datum and its child
   expression together when a child reads its parent’s results. Group 7 extends these same entry and return
   projections when a form loads additional cases. There is one result identity and one selection identity at
   every use.
4. Group 7 owns the order of case actions, the cases they reach and the case effect observed on submission.
   Group 8 owns where an authored block sits in the XForm, how form data is addressed and when values are set.
   Both use the same ordered effect model. Group 2 carries location capture through the app and form settings
   that group 8’s Connect blocks read.

### Keeping the inventory honest

The scope of each group is every owned ID in the six area files, including off-area rows. For example, the row
for lookup attributes in a search itemset belongs to Project data. Its inventory file is case-search. Seven Save
to Case rows in the questions file belong to forms and case management. Gate entries name what depends on the
feature. They do not add to the 299. Language ordering and the shared machinery above are work even when they
have no separate manifest ID. From the repo root, the following lists the current owners and their exact
entries.

```sh
jq -rs '[.[][] | select(.owner)] | sort_by(.owner, .id) | .[] | [.owner, .id] | @tsv' lib/commcare/surface/entries/*.json
```

When a value class splits, give each resulting class its source predicate, authoring behavior, surface keys,
platform verdict, evidence and successor ID. Keep opportunity for authoring on a supported platform where that
platform and the receiving server agree. A new `REFUSED`, `TARGET-OWNED` or `INERT` standing requires a positive
observation of the reason and a neighboring accepted control. A missing editor, a complicated implementation or
a passing default fixture settles none of those standings. Change the human inventory and the machine manifest
together. Update the gate’s dependents, reader claims, Python parity classifier and matrix exhibition in that
PR. Before removing a group, compare the IDs at the starting commit with their current successor rows. Its
original scope must still be accounted for after splits, merges and renames.

Some situations apply to the reading itself. Preserve bounded responses for exhausted source bytes, work or peer
availability. Group 1 removes lookup limits that a paged read can overcome while keeping a bounded request,
cancellation, quotas and a truthful outcome on an incomplete read. An `unrecognized` or `read-back-differs`
outcome is an internal defect when a source is inside the supported envelope. It stays visible in diagnostics
and fails the proof. It cannot close a feature group.

## One feature from all three editors to a worker

- **Model and authoring.** Store an identity for each authored reference, including references in labels and
  expressions. Resolve text on entry through its parser and on export through its printer. Give each new entity
  its mutation, admission rule, reference edges, rename/delete behavior, undo, multiplayer replay and Markdown
  design contract where relevant. Cover atomic creation with its first references. The builder, shared SA tools
  and MCP use the same commands and the same rejection. Project-owned data goes through its Project service with
  current membership. A stale form, rejected batch or changed scope must leave the document and Project data
  consistent. Check all properties of the authored value even when a setting hides it.
- **Admission and publishing.** The [reader](../../../lib/commcare/reader/CLAUDE.md) proposes typed values and
  compares their production emission with the whole consumed subtree. The gate checks the document and its
  admitted reference facts. Declared platform behavior and independently changing target facts are separate
  inputs. The shared publish lifecycle checks target privileges, identity, drift and ownership before writing.
  Direct publishing, a manual HQ package and a device archive each prove what their actual carrier can convey. A
  target-bound resource gets an identified destination binding or a precise setup stop with a verifiable next
  action. Model the meaning of each supported source value in Nova’s typed vocabulary.
- **Authorization.** Scope each browser route, Project store query, MCP tool and download to the resources its
  response can contain, including review and refusal details. Register new routes on the intended production
  hostname. An HQ key grants no access to another Nova Project’s stored tables or worker assignments. Preserve
  the same-request HQ reachability check for revealing an existing app claim. Exercise a viewer, an editor and
  a bearer whose grant predates a new capability. Reuse an
  existing scope only for authority already described by its consent. A genuinely new grant needs a new scope
  and consent. [Access contracts](../../architecture/contracts.md#who-an-answer-is-for)
- **Review, acceptance and drift.** Include a newly relevant fact in the review digest and recheck it under the
  same acceptance boundary. Add domain deltas to `diffDocsToMutationsSteps` and the later HQ-change review. Test
  bringing a feature in, changing it in each editor, accepting a new HQ edit, publishing, and reading it back.
  Also test a stale review, a permission loss and a conflicting edit in Nova. The atomic claim,
  deployment-specific identifiers, preserved media paths and ownership of shared data apply to all the new
  content. Two apps sharing one table cannot acquire independent authority to overwrite it.
- **Existing adoptions.** A widened reader can discover content that the older reader folded away or handled as
  a first-publish change. The app baseline and the saved Nova document each retain their meaning. Do not
  silently turn source bytes from an old baseline into a new author edit or erase a warning while its change
  would still occur. Re-read the stored baseline with the new semantics when computing the new HQ delta,
  separate an actual HQ edit from a newly understood old value and present a review if adopting that value
  changes saved intent or effects. Test already-published, pending-first-publish and pending-next-publish
  deployments, including one with intervening Nova edits. Ship an explicit scan and conversion when those states
  require a stored change.
- **Compatibility of reviews.** Classify the original `FIRST_PUBLISH_CHANGES` entries against actual
  before/after emissions. Remove only the conditions made exact. Keep applicable sibling conditions, carry
  truthful pending changes forward, and verify both the stored-app and next-publish judges. The deployment
  reader already filters retired IDs from older saved lists. Exercise a mixed old/new list through that real
  path and prove the pending preview still predicts what publishing does. When removing an ID would suppress a
  real difference, rederive the list from its bound baseline and document, or retain its ID and behavior until
  that deployment’s publish clears it.
- **Worker behavior.** Record Web Apps and Android separately, including conditional or ignored controls. A
  feature that changes selection or ordering is exercised on the real Postgres case store and the corresponding
  native consumer. A Preview persona represents the worker while Nova Project membership still governs access to
  the underlying rows. Store-dependent measurements and external setup states stay outside the pure document
  gate. Update platform table, Preview behavior, App Test runtime version, model context version, public docs
  and plugin instructions when the feature changes what they promise.
- **Old storage.** Optional additions preserve the saved meaning of absence across app revisions, deployments
  and seeds. Where absence acquires a different meaning, migrate the old values. Include the live document,
  immutable fold starts and replayable suffix, pending HQ baselines, case data, lookup identities and Project
  reference edges in the scan wherever the change reaches them. Cover empty datasets, shared resources, renamed
  identities, previously hidden values and applications that already published. Never rewrite audit history to
  make a fixture round-trip. Use a migration baseline when the existing replay horizon cannot carry the new
  shape. [Delivery and storage contracts](../../architecture/contracts.md)

### A fold preserves each live deployment’s comparison point

A deployment’s published revision can precede a later editor change. The current
[reference loader](../../../lib/deployment/hqChanges/reference.ts) rejects a published revision older than the
latest immutable fold. Advancing the published revision to the fold sequence would incorrectly mark the
editor’s intervening change as published. Before an incompatible cutover creates a new fold, materialize a
**deployment reference at the fold**, separately for every live baseline/reference pair that is usable in the
old store. Keep the original published revision, mapping and source digest intact.

Under the same app and deployment locks, run the old reference fold to the cutover boundary. Capture its
server-folded published document **before** overlaying head-only values, the effective Project, whether there
was an intervening editor change, the composed property renames and participating actors. Persist its
converted document and these facts with the exact deployment, baseline digest, published revision and new
fold sequence. Verify before committing that applying the head-only projection and identity collision rules
reproduces the pre-cutover comparison after representation conversion. Preserve a prior unavailable outcome
with its reason. A target missing or changing an input required to certify a previously usable reference
blocks the migration. Keep the immutable app log and existing fold baseline as historical evidence.

Extend `usablePair` and `loadReferenceDocument` to use this saved reference only for a matching deployment,
digest, original revision and fold. Resume server-only folding and compose rename, actor and editor-before-move
state from the subsequent rows. Apply head-only fields and identity disambiguation at the current head.
A later incompatible fold advances a verified saved reference the same way. Two ordinary reads also matter.
Refreshing target-kept settings and recording an HQ save that reads as the same app can each change the
baseline’s source digest while keeping its pre-fold published revision. In the transaction that records
either read, compare the previous baseline and reference to the pair that the read verified. Rebind the
reference to the resulting digest and any refreshed target identities, media or pending-publish facts.
Keep the published document, revision and intervening edits. Honor the existing observed-time and deployment
fences, including an idempotent repeat. A stale refresh cannot move the reference to its own digest or old
identities. A new published revision with a usable fold supersedes the reference. Ending the deployment or
replacing its mapping retires it in the same transaction. Scope every read and write to its app, Project
and deployment.

Exercise a real Postgres app published to two targets at different revisions, with a Nova edit, chained rename
and independent HQ edit across the fold. Compare the conflict, actor attribution, current identity and publish
effects on both sides of the conversion, including an unpublished first/next-publish list and the first
publish after conversion. On one target refresh a kept setting, and on the other record an HQ save that
changes an identity but reads as the same app. Follow both with a real HQ edit while a Nova edit is still
unpublished. Each review must use its own refreshed facts and still report the intervening edit. Deliver a
stale refresh after the newer read and prove that neither stored pair moves. Count usable, already unavailable
and migrated pairs before and after conversion. A mismatched reference must refuse. Group 8’s Connect
conversion uses this procedure.

## What proves completion

Each row that becomes authorable gets an HQ-authored base with a non-default value. Its saved source, the first
reading, the published result and an HQ editor’s subsequent save must each exercise that value. Change it again
in Nova and check the independent readers. Pair it with the smallest control that would fail if the old
simplification returned. A different value class still needing a finding retains its variant. Claims about
worker-visible behavior require a native walk to its intended end on the affected platform, including the
submitted case/data effects. An emitter and its own parser agreeing cannot establish that the worker sees the
right answer.

Use the existing [proof matrix](../../../proof/matrix/), [sixth proof](../../../proof/checks/proof6.py),
[reader parity](../../../proof/checks/test_parity.py),
[first-publish](../../../proof/checks/test_first_publish_changes.py) and
[next-publish](../../../proof/checks/test_next_publish_changes.py) judges. Run the relevant witnesses for source
identity, HQ build, behavior, editor saves and edit locality in proofs 1–5. Prove Project isolation and
transactions against real Postgres. Exercise the first edit and refusal recovery in a browser, including
keyboard and compact layouts. Match each UI, SA and MCP claim to the production authoring path used by that
test.

Three combined witnesses catch errors that a base confined to one group would miss. Add these to the matrix
alongside the smaller controls.

| Synthetic worker journey | Compare independently |
| --- | --- |
| Two workers open the same grid menu in different languages. Its case list and form both use localized media and a question draws choices from an assigned lookup table. A third worker has no assignment. | Compare ordered fixture attributes/values using distinct business keys and a duplicate-looking pair, language-specific asset bytes, and each worker’s visible choices. Use a full worker restore or a verified base plus deltas. An omitted incremental fixture proves no change to the base. The restore supplies no remote row UUID. Inspect a general archive for cross-worker rows. Change a media translation in HQ and bring it back. |
| A child form opens from its parent’s search, where a related case supplies a displayed value. A second menu reuses the form with another valid selection. | Record the chosen case IDs and search inputs, result order, entry datums, the namespace submitted and exactly which case row changed. Reorder the menus in Nova and edit the search in HQ. Both paths must still select the intended cases without borrowing another menu’s context. |
| Publish an HQ-adopted multilingual app after a Nova edit while a second app reads its lookup table. Try its manual package and a second destination with incomplete bindings. | Compare both apps’ source identities, management rights and shared rows before and after. Changed review inputs require renewed consent. Check the second destination’s setup refusal before a write, then complete the supported setup and verify the resulting worker behavior. |

A group closes when every original entry and owned circumstance has a successor with the promised behavior, all
new gate and configuration classes have independent evidence, and its HQ-authored apps pass the applicable
proofs. For the final group close, run the full union of new and affected witnesses, including unchanged
controls shared by groups. Require no remaining `HELD-NEW` entries, no outstanding circumstance owner, no
missing parity or exhibition, no supported base stopped as unrecognized, and no new allowance standing in for a
feature. Compare retained expectations against actual HQ and native records. Remove exhausted
implementation-only group labels and their tests when no production or historical reader consumes them.

The Step 7 production release excludes the 499,998-row global lookup table that exceeds HQ’s workbook
capacity and Nova’s supported JSON transfer. Existing transfer limits still apply and the compatibility entry
stays open. The cutoff applies to that transfer only. The other compatibility, release, and cutover checks still apply.

Publish the durable contracts and remove the completed roadmap and its parts from `docs/plans/`.

### Verification and cutover

Start with the smallest distinguishing operation, retain its output, and rerun just that input after an edit.
Use [the proof lane’s durable checkpoints](../../../proof/README.md) and bounded single-operation replay for
supported stages. Store identity includes the input, checkout, image, environment and reader configuration. A
fresh observation after a source change must identify its new inputs. A completed part can accelerate diagnosis.
Only a complete applicable verdict counts toward the exit. Scheduled lanes continue the repo-wide coverage. A
queued unrelated audit adds no release gate.

Before merging a product slice, verify its exact reviewed tree, the required PR checks, feature-specific native
results, any before/after migration witness and the plugin diff. Where an additive change is compatible in both
directions while old writers are live, build and verify its migration, move all traffic as soon as the new
revision is ready, then probe the actual feature. Collect each group’s incompatible persisted changes into one
direct cutover. When two groups must change the same stored representation atomically, land that representation
and its first complete uses together in the same cutover. For an incompatible persisted shape, prebuild and
record the exact candidate and verified restore point, fence ingress and independent writers, and drain only
until actual in-flight writers and transactions have stopped. Rerun the blocking scan under the migration locks,
migrate once, prove the new image reads it, direct all traffic to it and resume writers. A failure after
changing storage leaves the writer fence in place until the new shape or the verified restore is safe.
[Deployment procedure](../../architecture/deployment.md)

Keep branches and migrations scoped to deliverable slices. Verify the ready revision, image digest, 100% traffic
and post-migration counts before merging corresponding plugin instructions. Probe the affected user surface with
a synthetic fixture, check bounded error logs, fast-forward both main worktrees, and remove merged branches,
worktrees and temporary repair machinery. Keep evidence required to explain a native result. A plan-only PR has
no feature flag, schema migration or plugin release.

## Where this roadmap ends

The worker-app vocabulary and the bring-in/author/publish cycle are the deliverable. Five adjacent workflows
have explicit product outcomes. None belongs to a later numbered step.

| When someone wants to… | What Nova supports at this boundary |
| --- | --- |
| Keep independent concurrent edits made in HQ and Nova | Review both sets of changes, choose the complete version to keep, then reapply desired edits. An automatic or per-field merge would require conflict semantics for every pair of mutations. |
| Use changed HQ rows for a Nova-managed table | The publish conflict names the table. Manage its source from the table’s page and review the affected schema, rows and consuming apps as described in group 1. Resolving a single app’s publish cannot silently replace shared Project data. |
| Take over an HQ organization | Read and refresh places as HQ-managed data, retaining references needed by saved cases. Changing the source organization’s administration is a separate grant and reconciliation workflow. |
| Restore an earlier app revision | Keep the durable app-change history and the normal editor undo contract. A whole-app restore would also have to specify target deployments, current case rows and already published identities. |
| Adopt an existing second HQ copy as another target of the same Nova app | Publish to a newly created app in another project space with its own resource checks. Updating an independently existing copy requires a second adoption, a new claim, its own baseline and agreement on identities. |

The same ownership boundary applies to target-controlled settings, outside services and unavailable worker
platforms. The chapters specify the edit, setup, refusal or alternate supported path for each such case. A
synthetic app composed of supported features must make the complete round trip under the conditions stated for
it.
