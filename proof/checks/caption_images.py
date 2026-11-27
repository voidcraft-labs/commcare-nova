"""Verify a question's image rename against the bytes HQ served and the field that actually displayed it."""

from __future__ import annotations

import base64
import hashlib
import io
import zipfile
from collections import Counter
from dataclasses import replace
from urllib.parse import quote

from proof.checks import (
    android_titles,
    changes,
    formplayer_places,
    native_question_web,
    served,
    served_places,
    xform_parts,
)
from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml
from proof.formplayer.walk import USE_SELECTED_VALUES
from proof.hq.operations import upload_field
from proof.observe.walks import language_of, navigation
from proof.webapps import observe

ROOT = "jr://file/"
CAPTIONS = {"/runs/*/steps/*/response/tree/*/caption_image", "/runs/*/steps/*/tree/*/caption_image"}
WEB = "/runs/*/screens/*/form/questions/*/media/*/src"


def matched_images(captured, upload, wanted):
    """Only the bytes of files actually sent to, and matched by, HQ's bulk image upload."""
    matched = {one["path"] for one in upload.get("matched") or () if one.get("class") == "CommCareImage"}
    wanted = matched.intersection(wanted)
    if not captured or not wanted or upload.get("refused"):
        return {}
    found = {}
    for batch, _ in captured.media_uploads():
        with zipfile.ZipFile(io.BytesIO(upload_field(batch.upload(), "bulk_upload_file"))) as archive:
            for item in archive.infolist():
                if ROOT + item.filename in wanted:
                    found[item.filename] = None if item.filename in found else archive.read(item)
    return {name: content for name, content in found.items() if content is not None}


def _saved_image(document, saved, reads):
    """The exact replacement the person saved, read back from its own multimedia document."""
    old = saved["path"]
    originals = [row for row in reads if row.get("path") == old and row.get("mediaType") == "CommCareImage"]
    if len(originals) != 1 or originals[0].get("status") != 200 or not originals[0].get("multimediaId"):
        return None
    content = base64.b64decode(saved["base64"], validate=True)
    digest = hashlib.sha256(content).hexdigest()
    extensions = {
        asset["extension"]
        for asset in (document.document.get("media") or {}).values()
        if asset["kind"] == "image" and asset["mimeType"] == saved["mimeType"] and asset["base64"] == saved["base64"]
    }
    if len(extensions) != 1 or (originals[0].get("sha256"), originals[0].get("length")) != (digest, len(content)):
        return None
    return old, f"{ROOT}commcare/{digest}{extensions.pop()}", originals[0]["multimediaId"], content


def _label_bindings(xml, path, languages=None):
    """Unambiguous label images of this file, grouped by the control's data binding across translations."""
    labels = {}
    for at, (_, value) in (xform_parts.parts(xml, languages) or {}).items():
        steps = changes.unescaped(at)
        if len(steps) >= 5 and steps[-4:-2] == [":itext", "label"] and steps[-1] == "image":
            labels.setdefault(tuple(steps[:-4]), []).append(value)
    return [binding for binding, images in labels.items() if all(image == path for image in images)]


def source_labels(source, path):
    languages = source.get("langs")
    if (
        not isinstance(languages, list)
        or not languages
        or not all(isinstance(lang, str) and lang for lang in languages)
    ):
        return {}
    found = {}
    for m, module in enumerate(source.get("modules") or ()):
        for f, form in enumerate(module.get("forms") or ()):
            xml = (source.get("_attachments") or {}).get(f"{form.get('unique_id')}.xml")
            namespace = form.get("xmlns")
            if isinstance(xml, str) and namespace:
                for binding in _label_bindings(xml, path, languages):
                    found["form", f"{m}.{f}", "xform", *binding] = namespace
    return found


def installed_labels(files, state, path, source):
    """The label image's source field and primary namespace must agree with this side's installed XForm."""
    differing = (state.get("releaseDiffers") or {}).get("differing") or ()
    installed = android_titles.installed_resources(files or {}, differing)
    namespaces = {ns: pos for ns, pos in served_places.form_namespaces(files or {}).items() if installed.get(pos)}
    labels = set()
    for ns, pos in namespaces.items():
        filename, _ = installed[pos]
        for binding in _label_bindings(files[filename], path):
            owner = ("form", pos, "xform", *binding)
            if source.get(owner) == ns:
                labels.add(owner)
    return namespaces, labels


def formplayer_label_sites(rows, trace, namespaces, owners):
    """Identify only the bound native questions carrying this image in the source and installed form."""
    observed = formplayer_places.locations(rows, trace, namespaces)
    return {key: owner for key, owner in observed.items() if owner in owners}


def installed_picture(files, state, admission, path, *, remote_url):
    """Core installed this particular media resource from the suite the native reader received."""
    from proof.checks import proof3

    entry = path.removeprefix(ROOT)
    directory, _, basename = entry.rpartition("/")
    # HQ's SuiteGenerator.media_resources uses "./{directory}/{name}", including its two slashes
    # for an authored file originally at the root. A local archive names its ZIP member directly.
    local = "./" + entry if remote_url is None else f"./{directory}/{basename}"
    if (
        not proof3.admitted(admission)
        or ROOT + local[2:] not in proof3.installed_media(admission)
        or "media_suite.xml" in ((state.get("releaseDiffers") or {}).get("differing") or ())
        or not (files or {}).get("media_suite.xml")
    ):
        return False
    members = [m for m in admission["media"] if m.get("location") == local]
    if len(members) != 1 or members[0].get("bytesInArchive") is not (remote_url is None):
        return False
    resource_id = members[0].get("id")
    if not resource_id:
        return False
    expected = [{"authority": "local", "location": local}]
    if remote_url is not None:
        expected.append({"authority": "remote", "location": remote_url})
    resources = [row for row in admission.get("resources") or () if row.get("id") == resource_id]
    if (
        len(resources) != 1
        or resources[0].get("installer") != "MediaInstaller"
        or (resources[0].get("status") != "Installed" or resources[0].get("locations") != expected)
    ):
        return False
    try:
        suite = parse_xml(files["media_suite.xml"])
    except XmlNotWellFormed:
        return False
    # The installer writes the basename into the media element's directory. One id and one
    # destination must resolve to this resource; an archived file by itself proves neither.
    destination = "../../" + directory
    matches = []
    for media in suite.findall("media"):
        for r in media.findall("resource"):
            locations = [{"authority": loc.get("authority"), "location": loc.text} for loc in r.findall("location")]
            if r.get("id") == resource_id or any(
                loc["location"] == local
                or (media.get("path") == destination and (loc["location"] or "").rsplit("/", 1)[-1] == basename)
                for loc in locations
            ):
                matches.append((r.get("id"), media.get("path"), locations))
    return suite.tag == "suite" and matches == [(resource_id, destination, expected)]


def browser_url(path, media_id):
    return f"/hq/multimedia/file/CommCareImage/{quote(media_id, safe='')}/{quote(path.rsplit('/', 1)[-1], safe='')}"


def installed_rename(observed, sessions, baseline, states, local_files, side, old, new, media_id):
    """Check the later builds independently of HQ's mapping check when it reported the upload matched."""
    if not (media_id and baseline and states.get(side) and observed.a):
        return False
    if side == "local":
        target = ("local", states[side], local_files, new, None)
    elif observed.b and observed.b_aligned:
        target = ("b", states[side], observed.b_aligned.files, new, observed.b)
    else:
        return False
    for label, state, files, path, app in (
        ("baseline", baseline, observed.a.build.files, old, observed.a),
        target,
    ):
        remote = None
        if label != "local":
            mapping = (app.doc.get("multimedia_map") or {}).get(path) or {}
            if (mapping.get("media_type"), mapping.get("multimedia_id")) != ("CommCareImage", media_id):
                return False
            # proof.hq.localsettings serves the same origin as the corpus's production publish target.
            remote = "https://www.commcarehq.org" + browser_url(path, media_id)
        admission = ((sessions or {}).get(label) or {}).get("admission") or {}
        if not installed_picture(files, state, admission, path, remote_url=remote):
            return False
    return True


def _case_selection_marks(run):
    """A multi-select list returns a fresh token for the cases the walk sent. The browser marks it by draw order."""
    steps = run.get("steps") or []
    navigations = observe._navigations(run)
    choices = navigation(run["script"])
    drawn = observe.selection_marks(
        ((step["request"], step.get("response")) for step in steps if isinstance(step.get("request"), dict)),
        # Stored native traces preserve UUID-shaped IDs from the app or restore as literal IDs.
        served.GENERATED_MARK.fullmatch,
    )
    marked = {}
    seen = set()
    for index, step in enumerate(navigations):
        request = step["request"]
        asked = request.get("selections") or []
        returned = (step.get("response") or {}).get("selections") or []
        if any(value in drawn.values() for value in (*asked, *returned)):
            return None  # A literal case ID collides with a browser mark in this run.
        if USE_SELECTED_VALUES not in asked and "selected_values" not in request:
            seen.update((*asked, *returned))
            continue
        previous = (navigations[index - 1].get("response") or {}) if index else {}
        case = choices[index - 1].get("entity") if 0 < index <= len(choices) else None
        if (
            not case
            or not previous.get("multiSelect")
            or [row.get("id") for row in previous.get("entities") or []].count(case) != 1
            or request.get("selected_values") != [case]
            or asked != [*(previous.get("selections") or []), USE_SELECTED_VALUES]
            or len(returned) != len(asked)
            or returned[:-1] != asked[:-1]
            or returned[-1] not in drawn
            or returned[-1] in seen
        ):
            return None
        marked[returned[-1]] = drawn[returned[-1]]
        seen.update((*asked, *returned))
    return marked


def _caption_steps(trace):
    """Identify each opened form and its final answers by the walk Formplayer actually received."""
    found = {}
    for run_index, run in enumerate(trace.get("runs") or ()):
        script = run.get("script")
        if not isinstance(script, list) or not run.get("steps"):
            continue
        marked = _case_selection_marks(run)
        if marked is None:
            continue
        locale = trace.get("locale")
        expected = language_of(script) or locale
        exchanges = []
        steps = run.get("steps") or ()
        for index, step in enumerate(steps):
            request = step.get("request")
            if not isinstance(request, dict):
                continue
            response = step.get("response") or {}
            locale = request.get("locale", locale)
            asked = request.get("selections")
            returned = response.get("selections")
            if isinstance(asked, list):
                asked = [marked.get(value, value) for value in asked]
            if isinstance(returned, list):
                returned = [marked.get(value, value) for value in returned]
            if isinstance(asked, list) and USE_SELECTED_VALUES in asked:
                if not returned or (response["selections"][-1] not in marked or not request.get("selected_values")):
                    break
                asked = [*asked[:-1], returned[-1]]
            # Keep the actual selected_values and every other request field in the paired comparison.
            exchanges.append(({**request, "selections": asked}, returned))
            if (
                not isinstance(response.get("tree"), list)
                or not locale
                or locale != expected
                or not isinstance(asked, list)
                or asked != returned
            ):
                continue
            walk = (script, returned, locale, tuple(exchanges))
            found[run_index, index] = walk
            if index + 1 < len(steps) and "answers" in steps[index + 1]:
                found[run_index, index + 1] = walk
    return found


def paired_steps(before, after):
    """The same script, effective language, navigation requests and returned selections on both sides."""
    left, right = _caption_steps(before), _caption_steps(after)
    return {key: walk[:2] for key, walk in left.items() if right.get(key) == walk}


def same_step(difference, paired):
    at = changes.unescaped(difference.at)
    return (
        len(at) > 4
        and at[0] == "runs"
        and at[2] == "steps"
        and (at[1].isdigit() and at[3].isdigit() and (int(at[1]), int(at[3])) in paired)
    )


def formplayer_trace(records, state):
    ref = ((state or {}).get("formplayer") or {}).get("trace")
    return records.blobs.get_json(ref) if ref else {}


def _web_sites(web, peer, trace, namespaces, path, url, app_id, paired):
    """Join the two browser form screens to the native walk for their script and its actual question bindings."""
    sites = {}
    for r, (run, other) in enumerate(zip(web.get("runs") or (), peer.get("runs") or (), strict=False)):
        if run.get("viewport") != other.get("viewport") or run.get("script") != other.get("script"):
            continue
        opened_form = native_question_web.opened_form(trace, run)
        if not opened_form:
            continue
        ns, opened, filled = opened_form
        position = namespaces.get(ns)
        screens = [(i, s) for i, s in enumerate(run.get("screens") or ()) if "form" in s]
        if (
            not position
            or not app_id
            or len(screens) != 2
            or any(
                (s.get("route") or {}).get("appId") != app_id
                or (run["script"], (s.get("route") or {}).get("selections")) not in paired.values()
                for _, s in screens
            )
        ):
            continue
        for (s, screen), nodes in zip(screens, native_question_web.question_states(opened, filled), strict=True):
            form = screen["form"]
            questions = form.get("questions") or []
            captions = [node.get("caption") for node in nodes]
            counts = Counter(captions)
            if form.get("title") != opened.get("title") or [q.get("label") for q in questions] != captions:
                continue
            for q, (question, node) in enumerate(zip(questions, nodes, strict=True)):
                binding = node.get("binding")
                if (
                    not binding
                    or not binding.startswith("/")
                    or not node.get("caption")
                    or counts[node["caption"]] != 1
                ):
                    continue
                if node.get("caption_image") != path:
                    continue
                pictures = [
                    (i, media) for i, media in enumerate(question.get("media") or []) if media.get("kind") == "img"
                ]
                if len(pictures) == 1 and pictures[0][1].get("src") == url:
                    i, _ = pictures[0]
                    at = f"/runs/{r}/screens/{s}/form/questions/{q}/media/{i}/src"
                    sites["webapps@B", at] = ("form", position, "xform", *binding[1:].split("/"))
    return sites


def saved_renames(document, name, records, observed, local_files, rows, baseline, states, sites, *, sessions):
    """A next publish after a person's replacement. Check the particular image and its question on both sides."""
    saved = (document.hq_side or {}).get("mediaReplaced")
    candidates = [
        d
        for d in rows
        if d.kind == "changed"
        and (
            (d.artifact in ("formplayer@B", "formplayer@local.ccz") and d.path in CAPTIONS)
            or (d.artifact == "webapps@B" and d.path == WEB)
        )
    ]
    if not candidates or not saved or not baseline:
        return rows
    parts = records.configurations[name]
    reads = (((parts.a or {}).get("apiReads") or {}).get("saved") or {}).get("media") or ()
    image = _saved_image(document, saved, reads)
    if not image:
        return rows
    old, new, media_id, content = image
    source = served_places.reviewed_source(records, name, "saved")
    mapping = (source.get("multimedia_map") or {}).get(old) or {}
    if (mapping.get("media_type"), mapping.get("multimedia_id")) != ("CommCareImage", media_id):
        return rows
    labels = source_labels(source, old)
    if not labels:
        return rows
    entry = new.removeprefix(ROOT)
    upload = ((parts.b or {}).get("publish") or {}).get("media") or {}
    pushed = matched_images(document.exports[name].republish, upload, {new})

    expected = {
        "webapps@B": (browser_url(old, media_id), browser_url(new, media_id)),
        "formplayer@B": (old, new),
        "formplayer@local.ccz": (old, new),
    }
    candidates = [d for d in candidates if (d.before, d.after) == expected[d.artifact]]

    web_candidates = {d.at for d in candidates if d.artifact == "webapps@B"}
    browser = {}
    if web_candidates and baseline.get("webapps") and (states.get("B") or {}).get("webapps"):
        original = records.blobs.get_json(baseline["webapps"])
        # For a newly listed app the comparison can insert ordinary B's worker runs ahead
        # of A's App Preview runs. Those indices cannot identify a pair of A and B screens.
        if (original.get("build", {}).get("workerApp") or {}).get("listed") is not False:
            browser = {"A": original, "B": records.blobs.get_json(states["B"]["webapps"])}
    verified = {}
    original_trace = formplayer_trace(records, baseline)
    for side, files, delivered in (
        ("B", observed.b_aligned.files if observed.b_aligned else {}, pushed),
        ("local", local_files, local_files),
    ):
        target = states.get(side)
        if not target or (delivered or {}).get(entry) != content:
            continue
        if not installed_rename(observed, sessions, baseline, states, local_files, side, old, new, media_id):
            continue
        suffix = "B" if side == "B" else "local.ccz"
        target_trace = formplayer_trace(records, target)
        paired = paired_steps(original_trace, target_trace)
        selected = [d for d in candidates if d.artifact == f"formplayer@{suffix}" and same_step(d, paired)]
        observations = []
        for state, build, path, label, trace in (
            (baseline, observed.a.build.files, old, "A", original_trace),
            (target, files, new, side, target_trace),
        ):
            namespaces, owners = installed_labels(build, state, path, labels)
            found = formplayer_label_sites(selected, trace, namespaces, owners)
            if browser and side == "B":
                other = "B" if label == "A" else "A"
                app = observed.a if label == "A" else observed.b
                web = _web_sites(
                    browser[label],
                    browser[other],
                    trace,
                    namespaces,
                    path,
                    browser_url(path, media_id),
                    app.app_id,
                    paired,
                )
                found.update({key: owner for key, owner in web.items() if key[1] in web_candidates and owner in owners})
            observations.append(found)
        left, right = observations
        verified.update({key: owner for key, owner in left.items() if right.get(key) == owner})
    sites.update(verified)
    return [
        replace(d, path=f"{d.path}:renamed-file") if d in candidates and (d.artifact, d.at) in verified else d
        for d in rows
    ]
