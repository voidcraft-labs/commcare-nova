# Hidden fields carry one value source: release sequence

A hidden field's value comes from exactly one of `calculate` and
`default_value`. JavaRosa evaluates every calculate after the `xforms-ready`
seeds, so a default beside a calculate is dead. Every authoring surface now
refuses to write the pair (the SA and MCP tool schemas, `editField`'s
cross-call normalization, the builder's single Value control), but documents
written before that hold it, and the validator rule that would make the pair
unrepresentable at the document level cannot ship while they do: every app
read runs the absolute commit gate (`lib/db/canonicalCommitKernel.ts`) and
every deploy's migration probe audits every `apps` row, so a release carrying
the rule over an offender fails admission.

This is ordering, not a flag. Nothing branches on a version.

## Release N (shipped with this plan)

- The authoring surfaces refuse the pair; `hiddenFieldCarriesBothValueSources`
  in `lib/domain/fields/hidden.ts` is the one recognizer.
- `scripts/scan-hidden-value-both-sources.ts` and
  `scripts/migrate-hidden-value-both-sources.ts` (pure modules under
  `scripts/lib/`) find and clear the pair; the writer rides the explicitly
  built maintenance image as `hidden-value-both-sources-repair.cjs` through
  the generic `commcare-nova-historical-repair` Job. Mechanics:
  `docs/architecture/deployment.md` § Historical repairs.

## Between N and N+1: production repair

Run the sequence in `docs/architecture/deployment.md` once release N is
serving. The execute report must show `blockedApps: []` and the closing
`--prod` scan must print `CLEAN` with exit code 0; paste both into the
release N+1 pull request. A blocked app needs its own owned repair first.

## Release N+1

- Add the validator rule `HIDDEN_VALUE_BOTH_SOURCES`
  (`lib/commcare/validator/errors.ts`, class `soundness` in
  `gate.ts::VALIDITY_CLASS_BY_CODE`, `rules/field.ts::hiddenValueBothSources`
  registered after `hiddenNoValue`, location `field: "default_value"`), its
  builder copy in `lib/doc/userFacingErrors.ts`, and its tests.
- Convert the expander fixtures that carry both slots to `default_value`-only.
- Upgrade the SA prompt's "Hidden Values" sentence to state the refusal, and
  the `hidden.ts` header, `lib/domain/CLAUDE.md`, and `lib/commcare/CLAUDE.md`
  to name the rule.
- Re-run the `--prod` scan immediately before merge. A straggler fails N+1 at
  the migrate probe, fail-closed; recovery is re-executing the Job from N's
  maintenance image and re-triggering the build.

## Release N+2

Remove the two scripts, the pure modules, their tests, the Dockerfile bundle
line, the Job allowlist entry in `scripts/rollout/deploy-cloud-run.py`, the
README and deployment-doc entries, and this plan. Nothing repair-specific
stays in the build pipeline; git is the archive. Retiring the generic
historical-repair Job definition itself is a separate, confirm-first decision.
