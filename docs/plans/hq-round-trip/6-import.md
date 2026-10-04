# Step 6: Import (outline)

Planned in full when step 5 exits. The design is the research's "The reader",
"What HQ's API provides", "Reference targets" and "Living with HQ after import".

## What it builds

1. **The reader.** It reads the stored app source and form JSON through HQ's
   API, and the media files the source's media map names, into one construction
   batch that passes the absolute gate, or refuses with the place and the
   reason. It derives every entity's UUID as UUIDv5 over the new app's UUID and
   the per-kind key the research's table gives, so every reading of one HQ app
   gives the same ids. It treats HQ-generated content as derived and reads each
   spelling of one meaning into Nova's one concept.
2. **The `hq-import` birth owner**, the third owner of the one genesis writer
   (`lib/db/appGenesis.ts`). Lookup tables and media are materialized in Project
   storage atomically with sequence 1, and the HQ app is recorded in the
   deployment ledger as explicitly adopted.
3. **Referenced and adopted project-space data.** A table or location an app
   only reads is recorded as referenced in its project space and never written
   there; adoption belongs to a Project table (or the app's location) and a
   target together. Each publish reads referenced data first.
4. **Drift merging.** Where step 2's drift check stops a publish, Nova also
   offers to bring HQ's changes in as ordinary mutations on the current
   document, matching entities by external identity, with conflicts shown.
5. **Entry points.** Import from the builder and over MCP, each confirming the
   platform declaration before the app exists.
6. **Grammar widenings.** Every `widen:` change a HELD row of the manifest names
   that no earlier step builds.
7. **Feature-matrix apps.** At least one HQ app per manifest entry, built through
   HQ's own models, plus generated combinations. This step builds them,
   because the reader is the first consumer of HQ-authored apps; the proof
   lane's corpus holds none before it.

## Cutover and migration

One cutover: each lookup table's per-app deployment records merge into one
record per Project table and project space, adopted where any app adopted it
and Nova-created otherwise.

## Contracts

The contracts table's step 6 rows: the `hq-import` birth owner, the deployment
record key for lookup tables, "no arm for matched by name", creating afresh
after an ended deployment, and "every export mode carries the data".

## Exit

Every feature-matrix app made only of held entries reads, re-exports and passes
the proof, and every other app is refused with the right reason.
