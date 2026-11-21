"""Formplayer's sessions over one state of a document's app, as a record (``proof/README.md``).

Where proof 3 runs Core's sessions (``proof.observe.sessions``), the unit
runs Formplayer's over the same states, each served to it by HQ's own views
(``proof.formplayer.hq``): the app released as HQ's Releases page releases
it, a worker HQ made, the document's case database saved through HQ's
receiver, and every request Formplayer makes of HQ answered by the view
HQ's URLconf names. The walk is derived on the baseline state
(``proof.formplayer.walk``: every menu command, the first case of each
list, each list action once, each search) and replayed on every other, as
Core's script is. Nova's local archive is walked too, with HQ answering
everything but the archive itself, which HQ does not hold: Formplayer is
handed Nova's bytes for it, its runtime URLs naming the working app as the
archive Nova compiles for the deployment does
(``proof.hq.operations.with_runtime_app_id``, ``local``). Nova hands that
archive to CommCare Android alone, which registers its own strings as the
default locale's first source before the app's files
(``CommCareApplication.initializeDefaultLocalizerData``), where Formplayer
registers its own after them (``FormplayerConfigEngine.initEnvironment``),
and they lack keys Android's name (``home.sync``). Formplayer reads the
archive as Android does: with Android's strings registered first, through
the one channel the lane has into Formplayer's install, a locale resource
of the archive's suite ahead of the app's own (``as_android_reads_it``), as
the Core runner admits the archive (``proof.core.client.ANDROID_DEFAULT_STRINGS``).

What a side's record holds (``walked``):

- ``trace``: the marked trace as a blob (``proof.formplayer.canonical``;
  the released build's id, the working app's and the worker's user case's,
  which HQ draws for each state it serves, are written ``@build``, ``@app``
  and ``@usercase``): every
  request the client sends, Formplayer's own JSON for each, what Formplayer
  asked HQ during each (HQ's view by its URL name, and HQ's status), and
  each submission HQ received;
- ``hq``: every request an HQ view did not answer 2xx, by the view's URL
  name, its status and what HQ said or raised, in order. An HQ view that
  raises answers Formplayer a 500, as production's does;
- ``asked``: how many times Formplayer asked each HQ view (the archive
  download left out: whether Formplayer asks for it again depends on what
  the same Formplayer process installed before);
- ``searches``: each search's parameters as HQ's view received them.

``runtime`` is Formplayer's commit and the Core it vendors, as the runner
announced them. The record holds no id Formplayer or HQ drew and no path,
so the same inputs give the same bytes (``proof/formplayer/test_walk.py``).
"""

from __future__ import annotations

from collections import Counter

from proof.formplayer import apps, canonical
from proof.formplayer.walk import Walk, script_of

# What a trace writes for the released build's id, which HQ draws afresh for every build it makes.
BUILD = "@build"
# And for the working app's id, which HQ draws for every state it serves and a local archive's runtime URLs name
# (its search and case fixture URLs, its ``PostURL``), as the device's and Connect's records write it.
APP = "@app"
# And for the id of the user case HQ made for the worker, which HQ also draws afresh for every state it serves.
USERCASE = "@usercase"
# And for the address of Formplayer's own web server, a loopback port drawn as each runner starts, which Formplayer
# writes into an error's answer (``BaseExceptionResponseBean.url``, the request's URL).
FORMPLAYER = "@formplayer"
LOCAL_APP = "nova-local-archive"
# A saved build's profile names the build itself (its own id in the addresses it gives a runtime), where the
# profile HQ writes for the app it is building names the app, so the two are never the same bytes.
PROFILES = frozenset({"profile.ccpr", "profile.xml", "media_profile.ccpr", "media_profile.xml"})


def runtime(runner) -> dict:
    """Formplayer's commit and the Core it vendors, as the runner announced them."""
    return dict((runner.ready or {}).get("formplayer") or {})


def runner_origin(runner) -> str | None:
    """Where the runner asks Formplayer's own web server (``Runner.java``: the loopback port it announced)."""
    port = (getattr(runner, "ready", None) or {}).get("port")
    return f"http://127.0.0.1:{port}" if port else None


def marked(trace, *, served, app_id=None, archives=(), runner=None):
    """A served state's trace as a record keeps it: every id Formplayer generated marked, the ids HQ's restores
    and the archives hold left as they are, the id Formplayer was given for the app written ``BUILD``, the working
    app's id written ``APP``, and the runner's own address written ``FORMPLAYER``."""
    given = canonical.given_ids(served.hq.restores, archives)
    drawn = {app_id or served.build_id: BUILD}
    if served.app_id and served.app_id not in drawn:
        drawn[served.app_id] = APP
    origin = runner_origin(runner)
    if origin:
        drawn[origin] = FORMPLAYER
    if served.usercase_id:
        # HQ draws the worker's user case an id of its own each time it makes the worker.
        drawn[served.usercase_id] = USERCASE
    value, generated = canonical.mark(canonical.replace_text(trace, drawn), given)
    return {**value, "generated": generated}


def _refusals(hq) -> list:
    """Every request an HQ view did not answer 2xx, as a record keeps it."""
    found = []
    for asked in hq.exchanges:
        if 200 <= asked.status < 300:
            continue
        entry = {"view": asked.url_name, "method": asked.method, "status": asked.status}
        if asked.raised:
            entry["raised"] = asked.raised
            entry["error"] = (asked.error or "").rstrip().splitlines()[-3:]
        else:
            entry["said"] = (asked.refusal or "")[:400]
        found.append(entry)
    return found


def walked(served, runner, blobs, *, script=None, app_id=None, archives=(), places=None):
    """Formplayer's walk of one served state, as a record, and the trace: derived where ``script`` is None, else
    replayed. ``app_id`` names an archive HQ does not hold in place of the released build (the local archive);
    ``places``, the place the Web Apps client's map gives each location question a derived run answers
    (``proof.webapps.observe.derived_places``)."""
    hq = served.hq
    first = len(hq.exchanges)
    walk = Walk.of(served, runner=runner, app_id=app_id, places=places)
    reference = blobs.put_json(marked(walk.run(script), served=served, app_id=app_id, archives=archives, runner=runner))
    # The trace as its record holds it (JSON's own values), which is what a judge reads.
    trace = blobs.get_json(reference)
    asked = hq.exchanges[first:]
    recorded = {
        "trace": reference,
        "hq": _refusals(hq),
        "asked": dict(
            sorted(
                Counter(
                    entry.url_name or "unresolved"
                    for entry in asked
                    if entry.url_name not in ("direct_ccz", "named-archive")
                ).items()
            )
        ),
        "searches": [[[key, list(values)] for key, values in search.params] for search in hq.searches],
    }
    return recorded, trace


def release_is_the_build(served, files) -> dict | None:
    """None where the archive HQ's download serves of the released build holds the files of the build the lane's
    other checks read, entry for entry; else what differs. The release is made by HQ's ``make_build`` and the
    lane's build by ``validate_app`` and ``create_all_files`` over the same stored app and previous build, so
    the two are one build but for the profile (``PROFILES``); this holds that."""
    import io
    import zipfile

    from proof.observe.build import arranged

    built = {name: content for name, content in arranged(files)}
    released = {}
    # A build's files name the app they were built from by its id (the addresses of its searches and claims);
    # HQ builds a release on a copy of the app with an id of its own, so that id is read as the app's.
    build_id, app_id = served.build_id.encode(), served.app_id.encode()
    with zipfile.ZipFile(io.BytesIO(served.archive())) as archive:
        for name in archive.namelist():
            released[name] = archive.read(name).replace(build_id, app_id)
    differing = sorted(
        name for name in set(built) | set(released) if name not in PROFILES and built.get(name) != released.get(name)
    )
    return {"differing": differing} if differing else None


# The suite's own name in an archive, and where the archive Formplayer is handed holds Android's strings.
SUITE = "suite.xml"
ANDROID_STRINGS = "default/android_translatable_strings.txt"
ANDROID_STRINGS_ID = "android_translatable_strings"


def as_android_reads_it(archive: bytes, strings: bytes | None = None) -> bytes:
    """The archive with CommCare Android's own strings (``strings``, by default the pinned checkout's
    ``android_translatable_strings.txt``) registered as the default locale's first source: a ``<locale
    language="default">`` resource ahead of the suite's first ``<locale>``, which Core's suite parser adds to the
    resource table, and its install registers, in document order (``SuiteParser``, ``ResourceTable.
    initializeResources``), so the app's own default text is read over Android's, as on a device. Every other entry is
    the archive's own."""
    import io
    import zipfile

    from lxml import etree

    if strings is None:
        from proof.core.client import ANDROID_DEFAULT_STRINGS

        strings = ANDROID_DEFAULT_STRINGS.read_bytes()
    with zipfile.ZipFile(io.BytesIO(archive)) as held:
        if ANDROID_STRINGS in held.namelist():
            raise ValueError(f"The archive already holds {ANDROID_STRINGS}, where Android's own strings are added.")
        suite = etree.fromstring(held.read(SUITE))
        namespace = etree.QName(suite).namespace

        def named(name):
            return etree.QName(namespace, name).text if namespace else name

        locale = etree.Element(named("locale"), language="default")
        resource = etree.SubElement(locale, named("resource"), id=ANDROID_STRINGS_ID, version="1")
        etree.SubElement(resource, named("location"), authority="local").text = f"./{ANDROID_STRINGS}"
        first = next((child for child in suite if etree.QName(child).localname == "locale"), None)
        if first is None:
            suite.append(locale)
        else:
            first.addprevious(locale)
        written = io.BytesIO()
        with zipfile.ZipFile(written, "w", zipfile.ZIP_DEFLATED) as copy:
            for info in held.infolist():
                data = held.read(info.filename)
                if info.filename == SUITE:
                    data = etree.tostring(suite, encoding="utf-8", xml_declaration=True)
                copy.writestr(info, data)
            copy.writestr(ANDROID_STRINGS, strings)
    return written.getvalue()


def local(served, runner, blobs, document, *, script, configuration):
    """Formplayer's walk of Nova's local archive over the served state's HQ: the archive Nova compiles for the
    project space the configuration ``configuration`` names (``Document.local_ccz_for``), its runtime URLs naming
    the working app (``with_runtime_app_id``) and Android's own strings first (``as_android_reads_it``), handed to
    Formplayer where it asks HQ's download for the app; the worker, the restore, each search, each claim and each
    submission are HQ's own."""
    from proof.hq.operations import with_runtime_app_id

    nova = with_runtime_app_id(document.local_ccz_for(configuration).read_bytes(), served.app_id)
    archive = as_android_reads_it(nova)
    app_id = apps.build_id(LOCAL_APP, archive)
    served.hq.archives[app_id] = archive
    try:
        return walked(served, runner, blobs, script=script, app_id=app_id, archives=[archive])
    finally:
        served.hq.archives.pop(app_id, None)


__all__ = [
    "APP",
    "BUILD",
    "as_android_reads_it",
    "local",
    "marked",
    "release_is_the_build",
    "runtime",
    "script_of",
    "walked",
]
