"""The surface extractor: everything CommCare's upstreams accept in an app, read from their code.

``python -m proof.surface --out <path>`` reads the checkouts the proof image
holds at the pins (``/opt/hq``, ``/opt/core``, ``/opt/android``) and writes
one JSON document: ``pins`` (the commit of each checkout, from ``git
rev-parse``) and ``items``, keyed ``<family>:<name>``. Each item holds
``source`` (where it was read, as ``<repository>/<path>::<symbol>``) and the
facts whose change matters. The same pins always give the same bytes: keys are
sorted, JSON is tab-indented, and nothing depends on the time, the machine or
an absolute path.

Every family is read from its authoritative source by the method that sees
every reader: HQ's registries after HQ's own boot, Python's ``ast`` over HQ's
source, JavaParser and reflection over Core's and Android's Java (the Java
helper in ``java/``), acorn over HQ's JavaScript with scope-aware value flow
(``js/surface.mjs``), and HQ's vendored Vellum run headless in Chromium
(``js/vellum_registry.mjs``) on the image's editor build's Vellum host page.
HQ's Underscore templates are compiled with HQ's own Underscore and read with
acorn (``js/prompts.mjs``), HQ's Django templates through Django's own template
lexer, and Core's compiled classes answer what reflection or a run of them
settles (the tests' readings, ``probe``, run Core the same way).
Kotlin, which no parser in the image reads, is read as tokens of its lexical
grammar (``java/.../Kotlin.java``). Nothing matches source text with a regular
expression. The data, runtime, profile, search, hashtag, string, XForm and
evaluation families percent-encode whitespace and ``%`` in the names they take from
upstream text (``lookup-workbook:field%20{i%20+%201}``); every other family's
names are identifiers and paths, and the collector refuses a key with
whitespace in its name rather than print one.

The families and their key grammars (each module's docstring says how its
families are read and what each item records):

``families/app_schema.py``
    ``schema:<Class>``, ``schema:<Class>.<key>``, ``schema:<Class>.<undeclared>``,
    ``schema:<Class>.<attribute>`` (a data descriptor), ``schema:dispatch(<dispatcher>)``
``families/formats.py``
    ``format:<slug>``, ``format:<unregistered>`` (HQ's fallback for any other slug), ``detail-field-type:<type>``
``families/flags.py``
    ``toggle:<SYMBOL>``, ``feature-preview:<SYMBOL>``, ``privilege:<CONSTANT>``, ``plan:<name>``
``families/version_gates.py``
    ``version-gate:<property>``, ``version-gate:<path>::<qualname>``,
    ``version-gate:<template path>``, ``version-gate:<script path>``
``families/registries.py``
    ``setting:<type>.<id>``, ``add-on:<slug>``, ``instance-scheme:<scheme>``, ``instance-ignored:<src>``
``families/profile.py``
    ``profile-property:<key>``
``families/data.py``
    ``csql-fn:<name>``, ``csql-metadata:<key>``, ``csql-op:<operator>``, ``csql-unit:<unit>``,
    ``lookup-model:<Model>.<field>``, ``lookup-workbook:<word>``, ``lookup-code:<path>::<qualname>``,
    ``lookup-code:<path>::<CONSTANT>``, ``media-class:<Class>``, ``media-code:<path>::<qualname>``,
    ``project-setting:<Model>.<field>``
``families/search.py``
    ``csql-key:<key>`` (``csql-key:indices.*`` for the index prefix), ``prompt-input:<value>``,
    ``prompt-appearance:<value>``
``families/hashtags.py``
    ``hashtag:<hashtag>``
``families/hq_api.py``
    ``hq-api:<view or resource>``, ``hq-api-decorator:<module>.<name>``, ``hq-api-support:<module>.<Class>``,
    ``hq-api-permission:<HqPermissions field>``
``families/vellum.py``
    ``vellum-feature:<key>``, ``vellum-plugin:<name>``, ``vellum-configuration:<name>``, ``mug:<Type>``,
    ``vellum-markup:<element>@vellum:<name>`` and ``vellum-markup:<parent>/vellum:<name>`` (what Vellum's parser
    asks of its own markup; ``<element>`` ``model/instance//*`` inside an instance)
``families/runtime.py``
    ``jr-fn:<name>``, ``jr-type:<type>``, ``jr-control:<element>``, ``jr-action:<element>``,
    ``jr-event:<event>``, ``jr-extension:<Parser>``, ``parser:<Parser>``, ``parser:<Parser>/<element>``,
    ``parser:<Parser>/<element>@<attribute>`` (and ``parser:SuiteParser/suite@<attribute>`` for one HQ's suite
    model writes and no Core parser reads, ``readBy: []``), ``appearance:<reader>/<token>``
``families/xforms.py``
    ``xform:<path>``, ``xform:<path>@<attribute>`` (a path from the element a handler table dispatches;
    ``*`` any element, ``X//*`` any descendant; a bare step is an element Core matches by its local name
    in any namespace, a prefixed step (``repeat/jr:addCaption``, ``label/h:*``, else ``{uri}name``) one
    whose namespace Core tests, as each element's ``namespace`` fact says; an attribute's namespaced name
    takes HQ's prefix, ``jr:count``, the XForms namespace bare; ``@xmlns`` the element's own namespace, with
    ``when``, the tests Core made before it reads it, where it reads it only under some; an attribute of the
    data root HQ writes and reads and Core does not, ``readBy: ["hq"]``),
    ``itext-form:<reader>/<form>`` (``<reader>`` ``core``, ``android`` or ``hq``)
``families/evaluation.py``
    ``session-path:<path>``, ``instance-source:<token>``, ``instance-source:(none)``, ``jr-handler:<name>``,
    ``xpath-token:<TOKEN>``, ``xpath-axis:<AXIS_...>``, ``xpath-test:<TEST_...>``, ``xpath-expr:<Class>``
``families/strings.py``
    ``ui-string:<id>``, ``ui-string:<pattern>`` (a read whose id the code names only in part, ``*`` for the
    unnamed part: ``ui-string:android.package.name.*``, and ``ui-string:*`` for reads of ids the code does
    not hold)

``families/authored.py``
    ``csql-fn:search-value-mixes-quote-marks``, ``profile-property:<key>`` for each key Nova's local profile
    sets that HQ's profile does not write: items whose facts no checkout the image holds can give (Nova's own
    vocabulary, or a key only Formplayer reads), authored there with ``authored: true`` and where each fact was
    settled

``media-format:`` is authored beside the manifest's entries, not generated here.
"""
