"""``hq-nova-then-builder``: Nova's first publish of ``targeted-save-to-case-shapes``, saved in HQ's form builder.

1. The corpus document ``targeted-save-to-case-shapes``'s first publish, as
   the corpus captured it, applied to HQ through HQ's own import view
   (``proof.observe.publish.create``), as ``proof/hq/test_retained_reads.py``
   publishes ``navigation-base``. The document is read through
   ``proof/matrix/conftest.py``'s ``documents`` fixture, whose ``DOCUMENTS``
   names it, so a change to its capture runs the package again.
2. Every form saved once in HQ's form builder (``vellum``): its Save to Case
   blocks and the nodes Nova generates beside them as the builder writes them
   back (``Vellum/src/saveToCase.js``).

The document holds every shape of Save to Case block Nova's emitter writes (a
root create, a keyed create, a create in a repeat, a conditional update, a
close, a several-case form, the own case in a block, the own close's block),
and one form with no Save to Case block whose validation holds a count Nova
lifts into a Hidden Value beside the question
(``proof/targeted/documents/saveToCaseShapes.ts``), so the builder's save
meets each generated node. It is the one base Nova's emitter can make stale:
a change to that document's capture changes what this base holds, which
``test_retained.py`` reports and ``python3 -m proof.matrix.adopt`` takes in.
Its configuration is the document's minimum configuration, which the build
holds the base's to: a several-case form runs in Web Apps alone, so
the app declares Web Apps (``CLOUDCARE``); the menu it sits in lets a worker
choose several households, which Nova's publish check asks
``CASE_SEARCH_ADVANCED`` for (``lib/commcare/projectSpaceCompatibility.ts``,
``multi-select-case-lists``), the flag HQ's menu settings offer that choice
under (``templates/app_manager/partials/modules/bootstrap5/case_list_multi_select.html``);
and its forms hold Save to Case blocks (``VELLUM_SAVE_TO_CASE``).
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.registry import Base

DOCUMENT = "targeted-save-to-case-shapes"
CONFIGURATION = Configuration(
    flags=frozenset({"CASE_SEARCH_ADVANCED"}), privileges=frozenset({"CLOUDCARE", "VELLUM_SAVE_TO_CASE"})
)


def build(authoring) -> str:
    from proof.observe import publish

    export = authoring.documents[DOCUMENT].exports["minimum"]
    configuration = export.configuration.hq()
    if configuration != CONFIGURATION:
        raise ops.MatrixChangeRefused(
            f"{DOCUMENT}'s minimum configuration is {configuration.canonical().decode()}, and hq-nova-then-builder is"
            f" authored under {CONFIGURATION.canonical().decode()}. The base applies that document's first publish"
            " where Nova's publish of it applies it, so give proof/matrix/bases/nova_then_builder.py's CONFIGURATION"
            " the document's."
        )
    with authoring.step("build:first-publish"):
        app_id, refusal, lookups = publish.create(authoring.state, export)
    if refusal is not None or (lookups is not None and lookups["errors"] != []):
        raise ops.MatrixChangeRefused(
            f"HQ refused the captured first publish of {DOCUMENT} while the lane authors hq-nova-then-builder:"
            f" {refusal or lookups}. The corpus's capture of that document is what Nova sends, so look at what HQ's"
            " import now asks of it."
        )
    return app_id


BASE = Base(
    id="hq-nova-then-builder",
    build=build,
    configuration=CONFIGURATION,
    exhibits=(
        "questions/text-input-xsd-string",
        "questions/integer-xsd-int-xsd-integer-read-as-the-same",
        "questions/repeat-group-user-controlled",
    ),
    vellum=((0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (1, 0)),
)
