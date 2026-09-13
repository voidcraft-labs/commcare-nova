# Production authoring interface: creation and repair

The shared authored-string boundary completed the earlier client workflow and
its clarified repair through production editor tools. Independent Preview checks
confirmed the requested behavior after repair. Discovery still loaded substantial
context, so these trials support the boundary's feasibility without completing
the broader interface redesign.

This is a new series after the [nine-trial pilot](agent-authoring-pilot-2026-09-12.md).
That pilot's baseline and scope remain unchanged. These two trials used the
production integration later committed in PR #588, before the separate app
overview and revised MCP/plugin guidance. Private request captures and interface
source snapshots identify the exact inputs. The [sanitized results](agent-authoring-2026-09-12/production-interface-results.json)
retain per-step input counts, total usage, termination, and observation limits.

| Trial | Model steps | First request input tokens | Result |
| --- | ---: | ---: | --- |
| Production creation | 10 | 47,323 | Completed after Search configuration repairs |
| Production repair | 11 | 12,336 | Completed the clarified dependent edits |

Both used GPT-5.6 Luna at `xhigh`, `store: false`, the evaluator's 12-request
limit and five-minute abort, and one disposable local app. The creation request
loaded nine tools and reloaded several definitions. Whole-request provider usage
therefore differs substantially from the small initially available tool surface.
The complete authored catalog still estimates about 80,000 tokens. Neither
deferral nor a short role prompt settles the cost of understanding an operation.

Creation kept the existing Survey and added registration, name Search, and
follow-up. Registration required name and age, accepted ages 0 through 120,
rejected -1 and 121, showed optional phone capture from age 18, and interpolated
the client's name into its note. Follow-up initially showed phone capture at
both tested ages, 17 and 18. The same clarification used in the earlier pilot
made the adult-only rule explicit for both forms.

Repair renamed the age field while keeping its identity, requiredness, bounds,
and dependent visibility rule. It changed the note to thank the client without
claiming that an unsubmitted form was saved. Preview then hid follow-up phone
capture at 17 and showed it at 18. Blank phone remained valid. The submission
projection changed only phone for the adult and no property for the minor.
The original Survey and every unrelated persisted value matched the pre-repair
app. An initial observer comparison included the requested changed fields;
the preservation check was corrected to exclude only those three fields, with
the original comparison error recorded in the private evidence.

These observations use the production Preview engine with persisted local
scenario rows and submission projection, without submitting. They do not prove
device behavior, deployed HQ behavior, or Search interaction in a browser. These
two trials have no CCZ artifact check. Earlier pilot artifact checks should not
be attributed to this series. The evaluator soft-deleted its disposable app;
the observer reused its two owned scenario rows.

Conservative generation spend for the entire program is **$0.8024** across
11 trials and 93 completed generation requests. This prices input as uncached
and adds 25%; actual billing may be lower. No broad paid schema sweep ran.

The next changes address operation boundaries, concise outcome facts, scalar
name resolution, and construction the server can derive from accepted design.
The larger evaluation will test the integrated result rather than infer general
quality from this repeated diagnostic task.
