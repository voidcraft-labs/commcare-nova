"""Proof 2, build equivalence: ``build(A)`` against ``build(B)`` for a publish with no edit.

B is aligned to A first (``proof.observe.alignment``), so identity is judged
once, by proof 1. Then everything HQ's build returns is compared:

- both ``validate_app()`` results (``validate_app``, as JSON) and what each
  build step raised (``build``, as JSON), each after the spelling rules
  registered for its artifact;
- every file ``create_all_files()`` and each build profile's
  ``create_all_files(build_profile_id)`` wrote, each parsed by its comparator
  (``proof.checks.compare.build_files``, which refuses a file it has no
  comparator for), after the registered spelling rules, with the version
  clause (``proof.checks.compare.versions``) deciding which version numbers
  may differ: HQ's own ``set_form_versions`` set each form's, with
  ``build(A)`` as the previous build.

The alignment must leave none of B's identities in what HQ built from the
aligned copy, or proof 2 would judge identity again (``AlignmentIncomplete``).

Where there is no B to compare because HQ refused a publish, the bar reports
the refusal (``import@<state>``) and proof 2 reports nothing more (decision
12: one class per symptom); a state missing for any other reason is a
refusal naming it (``build`` ``/no-<state>``).

On a document whose ``hq-side.json`` saves add-ons (``addOns``, what a person
turns on or off in HQ's add-ons section over A), what HQ's app, menu and form
pages offer of each saved add-on is compared too, A's against B's
(``add_ons@B``, ``offered_add_ons``, from the intent observation's
``addOnsOffered``): Nova's next publish writes only the add-ons its app needs
over the map HQ holds, so a page offers each saved add-on at B as at A.

On a document made in CommCare HQ (``hq-authored``) a form's built XML is left
out (``judged``, ``eligibility.form_xml_unjudged``): HQ builds both suites,
the profiles, the app strings and the media suite from the two stored apps, so
they compare, while a form's bytes are Nova's own spelling of the form HQ's
form builder wrote, which proof 3 and intent judge.

The comparison itself is the observation's (``proof.observe.builds``), which
makes it with no rule to decide whether B's sessions run; this module makes
it after the registered rules and judges the records.
"""

from __future__ import annotations

from proof.checks.differences import Difference
from proof.checks.eligibility import form_xml_unjudged
from proof.observe import builds
from proof.rules import RULES


def parsed_build(outcome, rules=None):
    """Every file of one build, default and build profiles, parsed; keyed by the path HQ gave it.

    ``rules`` are the spelling rules applied (the registered set when None,
    ``()`` for the raw files; ``proof.observe.builds.parsed_build``).
    """
    return builds.parsed_build(outcome, rules=RULES if rules is None else rules)


def build_equivalence(document, observed, rules=None):
    """Every difference between ``build(A)`` and the build of B aligned to A: none where HQ refused B or Nova
    stopped it before it sent anything.

    ``rules`` are the spelling rules applied (the registered set when None);
    the observation compares the raw builds (``()``) to decide whether B's
    sessions run, and the judge compares after the registered rules.
    """
    if observed.a is None or observed.b is None or observed.b_aligned is None:
        refused = {refusal.state for refusal in observed.refusals} | observed.stopped
        missing = [name for name, held in (("A", observed.a), ("B", observed.b)) if held is None] or ["B-aligned"]
        if any(name in refused for name in missing):
            return []
        cause = f"/no-{missing[0]}"
        return [Difference("proof2", document, "build", cause, cause, "refused", None, f"No {missing[0]} to compare.")]
    return build_differences(document, observed.a.build, observed.b_aligned, observed.alignment, rules=rules)


def build_differences(document, before, after, alignment, *, rules=None):
    """Every difference between two builds, the second built from an app aligned to the first's by ``alignment``
    (``proof.observe.builds.build_differences``; ``rules`` the registered set when None)."""
    return builds.build_differences(document, before, after, alignment, rules=RULES if rules is None else rules)


def _offered(record):
    """What HQ's pages offered of each add-on at one state (the intent observation's ``addOnsOffered``), or None
    where HQ holds no such state."""
    if not (record or {}).get("state"):
        return None
    observed = ((record.get("hooks") or {}).get("intent") or {}).get("addOnsOffered")
    if observed is None:
        raise AssertionError(
            "A state's intent observation holds no addOnsOffered, what HQ's pages offer of each add-on"
            " (proof/observe/intent.py::add_ons); it was made without it."
        )
    return observed


def offered_add_ons(document, saved, a, b) -> list:
    """Each add-on a person saved (``saved``, by slug) that a page offers at A and not at B, or the other way:
    ``add_ons@B``, ``/<page>/<slug>`` for the app's page and ``/<page>/*/<slug>`` for a menu's or a form's (its
    position in ``at``)."""
    found = []
    pages = [("app", None)]
    pages += [("modules", position) for position in sorted(set(a.get("modules") or {}) | set(b.get("modules") or {}))]
    pages += [("forms", position) for position in sorted(set(a.get("forms") or {}) | set(b.get("forms") or {}))]
    for page, position in pages:
        before = a.get(page) if position is None else (a.get(page) or {}).get(position)
        after = b.get(page) if position is None else (b.get(page) or {}).get(position)
        for slug in sorted(saved):
            offered_a = (before or {}).get(slug)
            offered_b = (after or {}).get(slug)
            if offered_a != offered_b:
                place = f"/{page}" if position is None else f"/{page}/{position}"
                path = f"/{page}" if position is None else f"/{page}/*"
                found.append(
                    Difference(
                        "proof2",
                        document,
                        "add_ons@B",
                        f"{path}/{slug}",
                        f"{place}/{slug}",
                        "changed",
                        offered_a,
                        offered_b,
                    )
                )
    return found


def form_artifact(artifact) -> bool:
    """Whether a built file's artifact is a form's XML (``form:<m>.<f>``, or a build profile's
    ``<profile id>/form:<m>.<f>``; ``proof.checks.compare.build_files.artifact_for``)."""
    return artifact.rpartition("/")[2].startswith("form:")


def judged(document, found):
    """``found`` without what proof 2 leaves out on the document: on an app made in HQ, every difference in a form's
    built XML (``eligibility.form_xml_unjudged``)."""
    if not form_xml_unjudged(document.source):
        return found
    return [difference for difference in found if not form_artifact(difference.artifact)]


def document_build_equivalence(document, records):
    """Proof 2's differences on one document: each configuration it is exported under, judged from its records, less
    what it leaves out there (``judged``)."""
    from proof.checks import observations

    found = []
    saved = (document.hq_side or {}).get("addOns") or {}
    for name in sorted(document.exports):
        found += build_equivalence(document.id, observations.republish_view(records, name))
        if saved:
            held = records.configurations[name]
            a, b = _offered(held.a), _offered(held.b)
            if a is not None and b is not None:
                found += offered_add_ons(document.id, saved, a, b)
    from proof.checks.discards import discarded

    found = discarded("proof2", document.id, document.hq_side, found)
    return judged(document, found) + observations.soft_assertion_differences(records, "proof2")


# Where the build elements a difference names only by position stand ---------------------------------------------


def build_sites(files, source=None, *, profile=None):
    """What one build's files say of where its elements stand that a difference's pointer names only by position
    (``changes.Sites``): each suite's ``entry``, ``remote-request`` and ``xform`` by the menu or form it is of
    (an entry's and a request's command, ``id_strings.form_command`` and ``search_command``; an XForm resource's
    local path, ``./modules-<m>/forms-<f>.xml``, ``sections/resources.py::FormResourceContributor``), each Search prompt's key and stored property index where its source is given, and each
    media resource by the media path it installs (``generator.py::media_resources``: its ``media`` element's path
    under ``jr://file/`` and the file's name, the last step of its remote location)."""
    from urllib.parse import unquote, urlsplit

    from proof.checks import changes
    from proof.checks.compare.build_files import artifact_for
    from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml, qname

    built, media = {}, {}

    def children(element, name):
        return [child for child in element if isinstance(child.tag, str) and qname(child.tag)[1] == name]

    for path, content in sorted((files or {}).items()):
        if not isinstance(content, bytes | str):
            continue
        name = path.rpartition("/")[2]
        if name not in ("suite.xml", "media_suite.xml"):
            continue
        try:
            root = parse_xml(content)
        except XmlNotWellFormed:
            continue
        if name == "media_suite.xml" and profile is None:
            for element in children(root, "media"):
                install = (element.get("path") or "").removeprefix("../../")
                for resource in children(element, "resource"):
                    remote = [
                        location.text or ""
                        for location in children(resource, "location")
                        if location.get("authority") == "remote"
                    ]
                    file_name = unquote(urlsplit(remote[0]).path.rpartition("/")[2]) if remote else ""
                    if resource.get("id") and file_name:
                        media[resource.get("id")] = "jr://file/" + "/".join(
                            part for part in (install, file_name) if part
                        )
            continue
        artifact = artifact_for(path, profile) if profile is not None else artifact_for(path).rpartition("/")[2]
        for element_name in ("entry", "remote-request"):
            for position, element in enumerate(children(root, element_name), start=1):
                commands = children(element, "command")
                place = changes.command_place(commands[0].get("id") if commands else None)
                top = f"{element_name}[{position}]"
                built[(artifact, top)] = place or None
                if place and source is not None:
                    menu = place[1].split(".")[0]
                    modules = source.get("modules") or []
                    if int(menu) < len(modules):
                        properties = (modules[int(menu)].get("search_config") or {}).get("properties") or []
                        for key, field, field_index in search_prompt_sites(element, properties, children):
                            built[(artifact, top, *key)] = (
                                "menu", menu, "search_config", "properties", str(field_index), "validations", field,
                            )
        if profile is not None:
            continue
        for position, element in enumerate(children(root, "xform"), start=1):
            place = None
            for resource in children(element, "resource"):
                for location in children(resource, "location"):
                    held = (location.text or "").removeprefix("./")
                    module, slash, form = held.removesuffix(".xml").partition("/")
                    if slash and module.startswith("modules-") and form.startswith("forms-"):
                        menu, form = module.removeprefix("modules-"), form.removeprefix("forms-")
                        if menu.isdigit() and form.isdigit():
                            place = ("form", f"{menu}.{form}")
            built[(artifact, f"xform[{position}]")] = place
    return changes.Sites(builds=built, media=media)


# A sort element's field CommCare HQ reads as the column it names (``const.py::CALCULATED_SORT_FIELD_RX``).
CALCULATED_SORT_FIELD = "_cc_calculated_"


def search_prompt_sites(element, properties, children):
    """Locate each suite prompt through the exact field key HQ read from the stored menu."""
    positions = {}
    for index, field in enumerate(properties):
        name = field.get("name")
        positions[name] = index if name not in positions else None
    for index, session in enumerate(children(element, "session"), 1):
        for query_index, query in enumerate(children(session, "query"), 1):
            for prompt_index, prompt in enumerate(children(query, "prompt"), 1):
                field = prompt.get("key")
                field_index = positions.get(field)
                if field and field_index is not None:
                    yield (
                        f"session[{index}]", f"query[{query_index}]", f"prompt[{prompt_index}]",
                    ), field, field_index


def header_sites(doc):
    """What one stored app says of where each app string its key does not place stands (``changes.Sites.builds``
    under ``("app_strings", key)``): the header of each sort-only element of a case list. HQ's build writes a
    sort element whose field no column of the list shows as a column of its own, after the list's columns
    (``suite_xml/sections/details.py::get_detail_column_infos``, ``util.py::get_sort_and_sort_only_columns``, the
    last element of a field standing for it), whose header is the element's ``display`` and whose position is its
    order among the sort elements, from 1 (``util.py::create_temp_sort_column``), so its header's key,
    ``m<m>.case_short.case_<field>_<order + 1>.header`` (``id_strings.py::detail_column_header_locale``), spells
    no column's index: it stands at the sort element."""
    from proof.checks import changes

    built = {}
    for m, module in enumerate((doc or {}).get("modules") or []):
        short = ((module or {}).get("case_details") or {}).get("short") or {}
        by_field = {}
        for index, element in enumerate(short.get("sort_elements") or []):
            field = (element or {}).get("field")
            if field:
                by_field[field] = index
        for column in short.get("columns") or []:
            by_field.pop((column or {}).get("field"), None)
        for field, index in by_field.items():
            calculated = field.removeprefix(CALCULATED_SORT_FIELD)
            if field.startswith(CALCULATED_SORT_FIELD) and calculated.isdigit():
                continue
            mobile = field.replace("#", "").replace("=", "")
            key = f"m{m}.case_short.case_{mobile}_{index + 2}.header"
            built[(changes.APP_STRINGS, key)] = (
                "menu",
                str(m),
                "case_details",
                "short",
                "sort_elements",
                str(index),
                changes.BELOW,
            )
    return changes.Sites(builds=built)


def document_sites(document, records):
    """``build_sites`` of each build proof 2 compares on one document, A's and B's aligned to A under each
    configuration, and ``header_sites`` of the two stored apps they are built from, as one
    (``changes.merged_sites``: an element two builds place apart is no place)."""
    from proof.checks import changes, observations, xform_parts
    from proof.checks.compare.build_files import artifact_for

    found = []
    for name in sorted(document.exports):
        observed = observations.republish_view(records, name)
        if observed.a is not None and observed.a.build is not None:
            found.append(build_sites(observed.a.build.files, observed.a.doc))
            found.extend(
                build_sites(files, observed.a.doc, profile=profile)
                for profile, files in observed.a.build.profile_files.items()
            )
            found.append(header_sites(observed.a.doc))
            # Only the brought-in saves judge form XML. Tie the removed itext value in A's build to
            # its own control or bind, including its language, media kind and original file.
            if changes.UNSHOWN_MEDIA in document.next_publish:
                build = observed.a.build
                for profile, files in [(None, build.files), *build.profile_files.items()]:
                    for path, xml in (files or {}).items():
                        artifact = artifact_for(path, profile)
                        if form_artifact(artifact):
                            found.append(changes.Sites(builds=xform_parts.unshown_media_sites(xml, artifact)))
        if observed.b_aligned is not None:
            aligned_source = observed.b.doc if observed.b is not None else None
            found.append(build_sites(observed.b_aligned.files, aligned_source))
            found.extend(
                build_sites(files, aligned_source, profile=profile)
                for profile, files in observed.b_aligned.profile_files.items()
            )
        if observed.b is not None:
            found.append(header_sites(observed.b.doc))
    return changes.merged_sites(*found)
