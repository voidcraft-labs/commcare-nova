"""What HQ's build works out again from the same input, kept the first time: pure functions, cached.

HQ builds an app many times in a unit (A, B, each sensitivity flip, each
save proof 4 makes), and each build repeats work whose result is a function
of its input alone. Each seam here keeps that result and hands back exactly
what the function returns for the input, so HQ computes every byte it
computed before (``proof.hq.speed`` installs them with its other seams, and
``PROOF_HQ_SPEED=0`` leaves them out):

- **eulxml's XPath.** HQ's suite is built from eulxml ``XmlObject``s, and
  every field eulxml reads or writes is found by evaluating its XPath on the
  element (``eulxml/xmlmap/fields.py``: ``_find_xml_node``,
  ``_create_attribute_node`` and ``NodeList.matches`` call
  ``node.xpath(path, namespaces=...)``, which compiles the expression for
  every call). ``CompiledXPaths`` compiles each (expression, namespaces)
  once as lxml's ``etree.XPath`` and evaluates that on the element: lxml's
  one XPath engine, the element the context node, the same namespaces and
  the same EXSLT regular expressions and smart strings by default
  (``XPathElementEvaluator`` and ``XPath`` take the same defaults). An
  expression lxml cannot compile, or a compiled one that raises, is
  evaluated as eulxml evaluates it, so what that raises is lxml's own.
- **lxml's ElementPath.** HQ reads its XForms with ``find``/``findall``
  (``app_manager/xform.py::WrappedNode``), whose paths lxml compiles into a
  selector (``lxml/_elementpath.py::_build_path_iterator``) kept in a cache
  that lxml empties whenever it holds more than 100, and a form's binds
  alone are more paths than that. ``Selectors`` keeps each selector by the
  path, the namespaces and the prefix reading it was compiled for, each
  compiled by lxml's own builder with its cache emptied around the call: the
  selector lxml builds for those arguments with nothing cached. lxml's own
  cache leaves the prefix reading out of its key, so where it holds a path
  compiled for one reading it answers a search under the other with it (an
  HTML document's search, ``with_prefixes`` false, after an XML document's of
  the same path, or the other way round); the seam compiles that search for
  its own reading. That is the one place the two differ, and no lane path
  searches an lxml HTML document (neither ``proof/`` nor the HQ code on the
  lane's paths parses one: ``lxml.html`` and ``etree.HTML`` appear only in
  ``motech/openmrs`` and a management command).
- **LooseVersion.** ``ApplicationBase.build_version`` and every minimum
  version check parse the app's CommCare version again
  (``looseversion.py::LooseVersion.parse``); ``VersionParses`` keeps the
  components of each text and gives each object its own list of them.
- **The previous build's files.** ``Application.set_form_versions`` reads
  each form's file from the previous build (``fetch_attachment``: a
  ``BlobMeta`` query and a file read). A saved build the harness made
  (``proof.hq.operations.Build.saved_build``) keeps the bytes it put
  (``KEPT_ATTACHMENTS``), and ``fetch_attachment`` answers with them while
  the unit's blob store holds those same bytes for that attachment, which it
  does wherever the saved build's blobs are part of the state.
- **Every other attachment.** Each read of an app (``get_app``) is a fresh
  object, and reading a form's source from it reads its attachment again:
  the ``BlobMeta`` query HQ's ORM builds and the file. ``Attachments`` keeps
  each answer by the blob it read (the document's id and the blob's key) and
  gives it again while one statement finds that blob's metadata row as it
  was (its parent, key and compression) and the file holds the same bytes:
  everything HQ's answer is a function of.
- **A form's questions.** HQ keeps them in its cache by the form's source
  (``FormBase.get_questions``), which the harness empties before every
  build; ``QuestionsMemo`` keeps each computed answer past those clears and
  gives it back exactly where HQ would compute it, making again the flag
  reads that computing it makes.
- **The language names file.** ``app_manager/util.py::languages_mapping``
  parses ``langs.json`` whenever its cache is empty; ``JsonMemo`` parses
  each file once by its content and hands back a fresh copy.

Every stand-in for a function HQ or a library defines is held to that
function's source at the image's pins (``SOURCES``). With
``PROOF_VERIFY_MEMOS=1`` every kept answer is computed again, as HQ computes
it, and must be the same (``MemoMismatch``); lxml's selectors, whose
closures cannot be read back, are not kept at all.
"""

from __future__ import annotations

import hashlib
import inspect

from proof.hq.seams import VERIFY_MEMOS, MemoMismatch

# The attribute a saved build keeps the bytes of its attachments under (``KEPT_ATTACHMENTS``).
KEPT_ATTACHMENTS = "_proof_kept_attachments"

# The sha256 of the source of each function a seam here repeats or answers for, at the image's pins: each
# stand-in repeats that code but for what it keeps, so other code is refused (``SeamOutOfDate``).
SOURCES = {
    "eulxml.xmlmap.fields._find_xml_node": "a9399482f05be00bd8d8f386aa9971c679ffd3828b89225a8c494c06eafd64fe",
    "eulxml.xmlmap.fields._create_attribute_node": "9eb57e688fb0b79b17b46abe169b28b9601a8c10e237ec1c7be0cb5a2771005e",
    "eulxml.xmlmap.fields.NodeList.matches": "9c9c75c803c0379269bf44fce47baa04184719f1798376502854493259c9360e",
    "looseversion.LooseVersion.parse": "7429373d5c934a564669366abf77e9cc9ef73ea5fe894ab9a2b922f5ae33e3cf",
    "corehq.blobs.mixin.BlobMixin.fetch_attachment": "85692e312969ac4aa828519097d44a1a622ef81c5a00bb90c5e2981c0651b470",
    "corehq.blobs.metadata.MetaDB.get": "7da91c63cda161637edf68b929dcdba00ab0c52e695390806af1beb2bf2e8ddf",
    "corehq.blobs.models.BlobMeta.open": "7501846c747fcfd6bc909b30216dd49f76498fe3f14c5e73d29b31aded1dea79",
    "corehq.blobs.fsdb.FilesystemBlobDB.get": "7f53c3a024c2866147db16b0bfd2964ed33a5b8d5106b802cfabebd77d0a38d2",
    "corehq.apps.app_manager.models.forms.FormBase.get_questions": (
        "fd6923fc00731c5fbb3d557df178f5481a18b273e0e67656554fcb21742131d9"
    ),
    "corehq.apps.app_manager.xform.XForm.__init__": "e1ccb286d51ccf17331ec2cdac8cadffb0aac14c23778857a2c4d46558c2d3e9",
    "corehq.apps.app_manager.xform.XForm.get_questions": (
        "ea80f6ac5bf754ff4bcc9afa4d73f4fb235eeaaf253a2c4d0408550582f631de"
    ),
}


class SeamOutOfDate(RuntimeError):
    """A function a build seam stands in for is no longer the code the seam was written against."""


def _source_digest(function):
    return hashlib.sha256(inspect.getsource(function).encode()).hexdigest()


def check_sources(functions):
    """Refuse a seam over a function whose source is not the one ``SOURCES`` names (``{name: function}``)."""
    changed = [name for name, function in functions.items() if _source_digest(function) != SOURCES[name]]
    if changed:
        raise SeamOutOfDate(
            f"proof/hq/buildcache.py repeats {', '.join(changed)} as the image's pins had them, and the code there"
            " is no longer that. Compare the new code with the stand-in, bring the stand-in to it, and record the"
            " new source's sha256 in SOURCES."
        )


# eulxml's XPath ----------------------------------------------------------------------------------------


def _same_result(a, b):
    """Whether two XPath results are the same: the same nodes, and strings with the same text and origin."""
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same_result(x, y) for x, y in zip(a, b, strict=True))
    if type(a) is not type(b):
        return False
    if hasattr(a, "getparent") and not isinstance(a, str):
        return a is b
    if isinstance(a, str):
        same = str(a) == str(b)
        if hasattr(a, "getparent"):
            same = same and a.getparent() is b.getparent() and a.attrname == b.attrname
            same = same and (a.is_attribute, a.is_text, a.is_tail) == (b.is_attribute, b.is_text, b.is_tail)
        return same
    if isinstance(a, float) and a != a:
        return b != b
    return a == b


class CompiledXPaths:
    """lxml's evaluation of an XPath on an element, as ``node.xpath(path, **context)``.

    Each expression is compiled once.
    """

    LIMIT = 65536

    def __init__(self):
        self.compiled = {}
        self.hits = 0

    def evaluate(self, node, path, context):
        from lxml import etree

        if context.keys() - {"namespaces"}:
            return node.xpath(path, **context)
        namespaces = context.get("namespaces")
        try:
            key = (path, None if namespaces is None else frozenset(namespaces.items()))
            compiled = self.compiled.get(key)
        except (AttributeError, TypeError):
            return node.xpath(path, **context)
        if compiled is None:
            try:
                compiled = etree.XPath(path, namespaces=namespaces)
            except Exception:
                # Raised as lxml raises it for eulxml's own call, if it does.
                return node.xpath(path, **context)
            if len(self.compiled) >= self.LIMIT:
                self.compiled.clear()
            self.compiled[key] = compiled
        else:
            self.hits += 1
        try:
            found = compiled(node)
        except Exception:
            return node.xpath(path, **context)
        if VERIFY_MEMOS:
            fresh = node.xpath(path, **context)
            if not _same_result(found, fresh):
                raise MemoMismatch(
                    f"The XPath {path!r}, compiled once and evaluated on an element, gave {found!r}, and the element's"
                    f" own evaluation gave {fresh!r}. eulxml's evaluations are not the compiled expression's here,"
                    " so proof/hq/buildcache.py must stop compiling them."
                )
        return found


XPATHS = CompiledXPaths()


def _find_xml_node(xpath, node, context):
    # eulxml/xmlmap/fields.py::_find_xml_node, its evaluation compiled once.
    matches = XPATHS.evaluate(node, xpath, context)
    if matches and isinstance(matches, list):
        return matches[0]
    elif matches:
        return matches


def _create_attribute_node(node, context, step):
    # eulxml/xmlmap/fields.py::_create_attribute_node, its evaluation compiled once.
    from eulxml.xmlmap import fields

    node_name, node_xpath, nsmap = fields._get_attribute_name(step, context)
    node.set(node_name, "")
    result = XPATHS.evaluate(node, node_xpath, {"namespaces": nsmap})
    return result[0]


def _matches(self):
    # eulxml/xmlmap/fields.py::NodeList.matches, its evaluation compiled once.
    return XPATHS.evaluate(self.node, self.xpath, self.context)


# lxml's ElementPath -------------------------------------------------------------------------------------


class Selectors:
    """lxml's ``_build_path_iterator``, each selector kept by everything it is compiled from (the module's note
    says where that differs from lxml's own cache, which leaves the prefix reading out)."""

    def __init__(self, build):
        self._build = build
        self.kept = {}
        self.hits = 0

    def _fresh(self, path, namespaces, with_prefixes):
        from lxml import _elementpath

        held, _elementpath._cache = _elementpath._cache, {}
        try:
            return self._build(path, namespaces, with_prefixes)
        finally:
            _elementpath._cache = held

    LIMIT = 65536

    def __call__(self, path, namespaces, with_prefixes=True):
        if VERIFY_MEMOS:
            # Each selector is lxml's own builder's for exactly these arguments; verified, nothing is kept and
            # lxml compiles every path as it does with no cache.
            return self._fresh(path, namespaces, with_prefixes)
        try:
            key = (path, None if not namespaces else frozenset(namespaces.items()), bool(with_prefixes))
            found = self.kept.get(key)
        except (AttributeError, TypeError):
            return self._fresh(path, namespaces, with_prefixes)
        if found is None:
            found = self._fresh(path, namespaces, with_prefixes)
            if len(self.kept) >= self.LIMIT:
                self.kept.clear()
            self.kept[key] = found
            return found
        self.hits += 1
        return found


# LooseVersion ------------------------------------------------------------------------------------------


class VersionParses:
    """``LooseVersion.parse``, each text's components worked out once and each object given its own list."""

    def __init__(self, parse):
        self._parse = parse
        self.kept = {}
        self.hits = 0

    def parse(self, version, vstring):
        if type(vstring) is not str:
            return self._parse(version, vstring)
        components = self.kept.get(vstring)
        if components is None:
            self._parse(version, vstring)
            self.kept[vstring] = tuple(version.version)
            return None
        self.hits += 1
        version.vstring = vstring
        version.version = list(components)
        if VERIFY_MEMOS:
            fresh = type(version).__new__(type(version))
            self._parse(fresh, vstring)
            if fresh.version != version.version or fresh.vstring is not vstring:
                raise MemoMismatch(f"LooseVersion parsed {vstring!r} into {fresh.version}, not the kept {components}.")
        return None


# A form's questions -------------------------------------------------------------------------------------


def _same_state(a, b):
    """Whether ``b`` is ``a`` as a separate copy: the same types throughout, equal values, and equal state (the
    instance attributes of every object, ``ItextValue``'s parts among them)."""
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_same_state(a[key], b[key]) for key in a)
    if isinstance(a, (list, tuple)):
        return len(a) == len(b) and all(_same_state(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, (str, int, float, bool, type(None))) and a != b:
        return False
    state_a, state_b = getattr(a, "__dict__", None), getattr(b, "__dict__", None)
    if state_a is not None or state_b is not None:
        return state_a is not None and state_b is not None and _same_state(state_a, state_b)
    return isinstance(a, (str, int, float, bool, type(None)))


def _kept_copy(value):
    """The pickle of ``value`` where unpickling it gives back the same state (``_same_state``), else None."""
    import pickle

    try:
        dumped = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception:
        return None
    return dumped if _same_state(value, pickle.loads(dumped)) else None


class Replayed:
    """The flag reads a kept computation made, read again through the open flag seams on each use.

    A computation is kept only where every seam answer it took was a flag read
    through ``enabled`` (so it can be made again, with the same arguments) and
    HQ noted no soft assertion in it; a use reads each flag again, so the
    seams record what the computation would, and is kept only while each
    verdict is the one the computation was given.
    """

    def __init__(self):
        self.reads = []
        self.other = False

    def __call__(self, toggle, item, namespace, via, verdict):
        if via != "enabled":
            self.other = True
        self.reads.append((toggle, item, namespace, verdict))

    @staticmethod
    def same_verdicts(reads):
        from proof.hq.seams import FLAG_ANSWERS

        if not FLAG_ANSWERS:
            return not reads
        answer = FLAG_ANSWERS[-1]
        return all(answer(toggle, item, namespace) == verdict for toggle, item, namespace, verdict in reads)

    @staticmethod
    def replay(reads):
        for toggle, item, namespace, _ in reads:
            if namespace is Ellipsis:
                toggle.enabled(item)
            else:
                toggle.enabled(item, namespace)


def _seam_answers():
    """How many answers the open unit's seams have given (flags aside): privileges, Elasticsearch, Formplayer."""
    from proof.hq import branch

    if not branch._OPEN or branch._OPEN[-1].record is None:
        return None
    record = branch._OPEN[-1].record
    return (
        len(record.privileges),
        len(record.elasticsearch_reads),
        len(record.elasticsearch_refusals),
        len(record.form_validations),
    )


class QuestionsMemo:
    """The computation behind ``FormBase.get_questions``, each answer kept past the harness's cache clears.

    HQ caches the answer by the form's source and the arguments
    (``models/forms.py::FormBase.get_questions``: ``time_method`` over
    ``quickcache`` over the computation), and the harness empties that cache
    before every build, so every build computes each form's questions
    again: ``XForm(source, domain).get_questions(...)``, the parse of the
    source, the questions read from it, and the one flag the ``XForm`` reads
    of the domain (``xform.py::XForm.__init__``,
    ``SAVE_ONLY_EDITED_FORM_FIELDS``). This stands in for the computation
    alone, where HQ's cache missed (its timer, which draws a ``uuid4`` for
    each timed call, and its cache run as before): an answer computed before
    for the same source, domain and arguments is given back with the flag
    reads its computation made made again (``Replayed``, each verdict the
    same, or it is computed again), as a copy with the same state throughout
    (``_kept_copy``: a pickle round trip, as HQ's cache hands its answers
    back). A computation is kept only where it took no seam answer but those
    flag reads, HQ noted no soft assertion in it, it drew no entropy
    (``proof.hq.determinism.entropy_mark``) and its answer copies whole.
    """

    LIMIT = 4096
    VARIANTS = 4

    def __init__(self, compute):
        self._compute = compute
        self._signature = inspect.signature(compute)
        self.kept = {}
        self.hits = 0

    def key(self, form, args, kwargs):
        bound = self._signature.bind(form, *args, **kwargs)
        bound.apply_defaults()
        arguments = dict(bound.arguments)
        arguments.pop("self")
        langs = arguments.pop("langs")
        source = form.source
        if not isinstance(source, str):
            raise TypeError("a source that is not text")
        digest = hashlib.sha256(source.encode("utf-8")).digest()
        return (digest, form.get_app().domain, tuple(langs), tuple(sorted(arguments.items())))

    def __call__(self, form, *args, **kwargs):
        import pickle

        from proof.hq import determinism
        from proof.hq.boot import soft_assertions
        from proof.hq.seams import FLAG_READ_LISTENERS

        before = _seam_answers()
        if before is None:
            return self._compute(form, *args, **kwargs)
        try:
            key = self.key(form, args, kwargs)
            hash(key)
        except TypeError:
            return self._compute(form, *args, **kwargs)
        kept = next(
            (variant for variant in self.kept.get(key, ()) if Replayed.same_verdicts(variant[1])),
            None,
        )
        if kept is not None:
            self.hits += 1
            Replayed.replay(kept[1])
            found = pickle.loads(kept[0])
            if VERIFY_MEMOS:
                fresh = _uncached_questions(form, *args, **kwargs)
                if not _same_state(fresh, found):
                    raise MemoMismatch(
                        "The questions HQ reads from a form's source differ from the ones kept for the same source,"
                        f" domain and arguments ({key[1:]}), so proof/hq/buildcache.py must stop keeping them."
                    )
            return found
        replayed = Replayed()
        drawn = determinism.entropy_mark()
        FLAG_READ_LISTENERS.append(replayed)
        try:
            with soft_assertions() as notes:
                found = self._compute(form, *args, **kwargs)
        finally:
            FLAG_READ_LISTENERS.remove(replayed)
        quiet = not (replayed.other or notes) and _seam_answers() == before and determinism.entropy_mark() == drawn
        if quiet:
            dumped = _kept_copy(found)
            if dumped is not None:
                if len(self.kept) >= self.LIMIT:
                    self.kept.clear()
                # One answer per set of verdicts its reads were given (a flip's beside the plain build's).
                variants = self.kept.setdefault(key, [])
                variants.append((dumped, tuple(replayed.reads)))
                del variants[: -self.VARIANTS]
        return found


def _uncached_questions(
    form,
    langs,
    include_triggers=False,
    include_groups=False,
    include_translations=False,
    include_fixtures=False,
    include_locked_status=False,
):
    # models/forms.py::FormBase.get_questions without its cache (and its XFormException's rewording, which a
    # kept answer never carries: only answers are kept).
    from corehq.apps.app_manager.xform import XForm

    return XForm(form.source, domain=form.get_app().domain).get_questions(
        langs=langs,
        include_triggers=include_triggers,
        include_groups=include_groups,
        include_translations=include_translations,
        include_fixtures=include_fixtures,
        include_locked_status=include_locked_status,
    )


# A JSON file's parse ----------------------------------------------------------------------------------


class JsonMemo:
    """``json`` as a module reads its files: ``load`` parses each file once, by its name and content, and gives
    back a fresh copy of that parse (a pickle round trip, which gives JSON's dicts, lists, text,
    numbers, booleans and None back whole); everything else is ``json``'s. With ``PROOF_VERIFY_MEMOS=1`` every
    copy is held to a parse of the file made again (``MemoMismatch``)."""

    def __init__(self, json_module):
        self._json = json_module
        self.parsed = {}
        self.hits = 0

    def __getattr__(self, name):
        return getattr(self._json, name)

    def load(self, fp, **kwargs):
        import pickle

        text = fp.read()
        if kwargs:
            return self._json.loads(text, **kwargs)
        if not isinstance(text, (str, bytes)):
            return self._json.loads(text)
        key = (getattr(fp, "name", None), text)
        kept = self.parsed.get(key)
        if kept is None:
            found = self._json.loads(text)
            self.parsed[key] = pickle.dumps(found, protocol=pickle.HIGHEST_PROTOCOL)
            return found
        self.hits += 1
        found = pickle.loads(kept)
        if VERIFY_MEMOS:
            fresh = self._json.loads(text)
            if not _same_state(fresh, found):
                raise MemoMismatch(
                    f"The file {key[0]!r} parses as JSON into something other than the parse kept for its content,"
                    " so proof/hq/buildcache.py must stop keeping parses."
                )
        return found


# The previous build's files --------------------------------------------------------------------------


def keep_attachments(saved, files):
    """Keep on the saved build ``saved`` the bytes it put as each attachment (``{name: bytes or str}``)."""
    kept = {}
    for name, content in files.items():
        # put_attachment stores text as its UTF-8 (corehq/blobs/mixin.py::BlobMixin.put_attachment).
        if isinstance(content, str):
            kept[name] = content.encode("utf-8")
        elif isinstance(content, (bytes, bytearray)):
            kept[name] = bytes(content)
    setattr(saved, KEPT_ATTACHMENTS, kept)


def _stored(document, name, content):
    """Whether the unit's blob store holds exactly ``content`` as ``document``'s attachment ``name`` now.

    The unit's store mirrors every file it holds (``proof.hq.branch``: its
    ``files``, kept as each write and restore changes them), and its
    ``BlobMeta`` rows and files are written and restored together.
    """
    import os

    from corehq.blobs import get_blob_db

    db = get_blob_db()
    files = getattr(db, "files", None)
    ref = document.external_blobs.get(name)
    if files is None or ref is None or not hasattr(db, "_root"):
        return False
    path = os.path.relpath(db.get_path(ref.key), db._root())
    return files.get(path) == content


def _blob_row(parent_id, key):
    """Whether the blob store's metadata holds a row for ``parent_id`` and ``key``, and if so whether it says the
    blob is compressed: True or False, or None for no row. It reads the database HQ's ``MetaDB.get`` reads (the
    router's for a ``BlobMeta`` read partitioned by ``parent_id``), in one statement; ``key`` is unique."""
    from corehq.blobs.models import BlobMeta
    from corehq.sql_db.routers import HINT_PARTITION_VALUE
    from django.db import connections, router

    alias = router.db_for_read(BlobMeta, **{HINT_PARTITION_VALUE: parent_id})
    with connections[alias].cursor() as cursor:
        cursor.execute(
            f'SELECT "compressed_length" IS NOT NULL FROM "{BlobMeta._meta.db_table}"'
            ' WHERE "parent_id" = %s AND "key" = %s',
            [parent_id, key],
        )
        rows = cursor.fetchall()
    return rows[0][0] if len(rows) == 1 else None


def _file_bytes(path):
    """The bytes of the file at ``path``, or None where there is none."""
    try:
        with open(path, "rb") as stream:
            return stream.read()
    except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
        return None


class Attachments:
    """HQ's reads of a document's attachment, each kept by the blob it read and given again while that blob is
    as it was.

    HQ reads an attachment (``corehq/blobs/mixin.py::BlobMixin.fetch_attachment``)
    as the blob key the document names for it, the ``BlobMeta`` row with the
    document's id as its parent and that key (``metadata.py::MetaDB.get``; a
    key is unique), and the file at the key's path in the filesystem blob
    store, read whole, through gzip where the row says the blob is compressed
    (``models.py::BlobMeta.open``, ``fsdb.py::FilesystemBlobDB.get``), and
    raises ``ResourceNotFound`` where the row or the file is missing. So its
    answer is a function of whether that row exists, whether it says
    compressed, and the file's bytes. A kept answer is given again where the
    document names the same key and all three are as they were when HQ read
    it: one statement reads the row's compression (no query HQ's ORM builds
    and no model), and the file is read. A stream, a name the document holds
    no external blob under, and a blob store that is not on the filesystem
    are read as HQ reads them.
    """

    # The bytes the kept answers may hold before they are let go, all at once.
    LIMIT = 64 * 1024 * 1024

    def __init__(self):
        self.kept = {}
        self.size = 0
        self.hits = 0

    def fetch(self, fetch, document, name, stream):
        from corehq.blobs import get_blob_db

        if stream:
            return fetch(document, name, stream=stream)
        db = get_blob_db()
        get_path = getattr(db, "get_path", None)
        try:
            ref = document.external_blobs.get(name)
            parent_id, key = document._id, ref.key
            path = get_path(key)
        except Exception:
            # No external blob of that name, or no filesystem path for its key: read as HQ reads it.
            return fetch(document, name, stream=stream)
        if not isinstance(parent_id, str) or not isinstance(key, str):
            return fetch(document, name, stream=stream)
        kept = self.kept.get((parent_id, key))
        if kept is not None:
            compressed, stored, answer = kept
            if _blob_row(parent_id, key) is compressed and _file_bytes(path) == stored:
                self.hits += 1
                if VERIFY_MEMOS:
                    fresh = fetch(document, name, stream=stream)
                    if fresh != answer:
                        raise MemoMismatch(
                            f"The attachment {name!r} of {parent_id!r} reads {len(fresh)} bytes through HQ, not the"
                            f" {len(answer)} kept for its unchanged blob, so proof/hq/buildcache.py must stop"
                            " keeping attachments."
                        )
                return answer
        answer = fetch(document, name, stream=stream)
        compressed, stored = _blob_row(parent_id, key), _file_bytes(path)
        if compressed is not None and stored is not None and isinstance(answer, bytes):
            if stored == answer:
                stored = answer
            if self.size >= self.LIMIT:
                self.kept.clear()
                self.size = 0
            self.kept[parent_id, key] = (compressed, stored, answer)
            self.size += len(stored) + (0 if stored is answer else len(answer))
        return answer


ATTACHMENTS = Attachments()


def kept_fetch(fetch):
    """``BlobMixin.fetch_attachment`` answering a saved build's attachment with the bytes it kept, while stored,
    and every other attachment through ``ATTACHMENTS``."""

    def fetch_attachment(self, name, stream=False):
        kept = getattr(self, KEPT_ATTACHMENTS, None)
        if stream or not kept or name not in kept:
            return ATTACHMENTS.fetch(fetch, self, name, stream)
        content = kept[name]
        if not _stored(self, name, content):
            return ATTACHMENTS.fetch(fetch, self, name, stream)
        if VERIFY_MEMOS:
            fresh = fetch(self, name, stream=stream)
            if fresh != content:
                raise MemoMismatch(
                    f"A saved build's attachment {name!r} reads {len(fresh)} bytes from the blob store, not the"
                    f" {len(content)} it kept, so proof/hq/buildcache.py must stop answering it."
                )
        return content

    fetch_attachment.__wrapped__ = fetch
    return fetch_attachment


# Installing ----------------------------------------------------------------------------------------------


def seams():
    """Each build seam, a context that applies it until it exits."""
    import json
    from unittest import mock

    import looseversion
    from corehq.apps.app_manager import util as app_manager_util
    from corehq.apps.app_manager.models.forms import FormBase
    from corehq.apps.app_manager.xform import XForm
    from corehq.blobs.fsdb import FilesystemBlobDB
    from corehq.blobs.metadata import MetaDB
    from corehq.blobs.mixin import BlobMixin
    from corehq.blobs.models import BlobMeta
    from eulxml.xmlmap import fields
    from lxml import _elementpath

    from proof.hq.seams import rebound

    hq_get_questions = vars(FormBase)["get_questions"]
    # time_method over quickcache over the computation: quickcache's helper calls the computation on a miss.
    questions_cache = hq_get_questions.__wrapped__.get_cached_value.__self__
    check_sources(
        {
            "eulxml.xmlmap.fields._find_xml_node": fields._find_xml_node,
            "eulxml.xmlmap.fields._create_attribute_node": fields._create_attribute_node,
            "eulxml.xmlmap.fields.NodeList.matches": fields.NodeList.matches.fget,
            "looseversion.LooseVersion.parse": looseversion.LooseVersion.parse,
            "corehq.blobs.mixin.BlobMixin.fetch_attachment": BlobMixin.fetch_attachment,
            "corehq.blobs.metadata.MetaDB.get": MetaDB.get,
            "corehq.blobs.models.BlobMeta.open": BlobMeta.open,
            "corehq.blobs.fsdb.FilesystemBlobDB.get": FilesystemBlobDB.get,
            "corehq.apps.app_manager.models.forms.FormBase.get_questions": questions_cache.fn,
            "corehq.apps.app_manager.xform.XForm.__init__": XForm.__init__,
            "corehq.apps.app_manager.xform.XForm.get_questions": XForm.get_questions,
        }
    )
    questions = QuestionsMemo(questions_cache.fn)

    # The computation's own parameters: HQ's cache reads its arguments by name (inspect.getcallargs).
    def get_questions(
        self,
        langs,
        include_triggers=False,
        include_groups=False,
        include_translations=False,
        include_fixtures=False,
        include_locked_status=False,
    ):
        return questions(
            self,
            langs,
            include_triggers=include_triggers,
            include_groups=include_groups,
            include_translations=include_translations,
            include_fixtures=include_fixtures,
            include_locked_status=include_locked_status,
        )

    get_questions.memo = questions
    return [
        mock.patch.object(questions_cache, "fn", get_questions),
        mock.patch.object(app_manager_util, "json", JsonMemo(json)),
        rebound(fields._find_xml_node, _find_xml_node),
        rebound(fields._create_attribute_node, _create_attribute_node),
        mock.patch.object(fields.NodeList, "matches", property(_matches)),
        mock.patch.object(_elementpath, "_build_path_iterator", Selectors(_elementpath._build_path_iterator)),
        mock.patch.object(
            looseversion.LooseVersion,
            "parse",
            _parse_method(VersionParses(looseversion.LooseVersion.parse)),
        ),
        mock.patch.object(BlobMixin, "fetch_attachment", kept_fetch(BlobMixin.fetch_attachment)),
    ]


def _parse_method(parses):
    def parse(self, vstring):
        return parses.parse(self, vstring)

    parse.parses = parses
    return parse
