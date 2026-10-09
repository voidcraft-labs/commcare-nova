# syntax=docker/dockerfile:1.7
#
# The proof harness image (proof/README.md). Built by
# .github/workflows/proof-image.yml from proof/pins.json; every input is pinned
# here or passed as a build argument (proof/image/build-args.mjs), so one set
# of pins builds one image. The image holds HQ, Core, Android and Formplayer at
# their pins, HQ's virtualenv from HQ's own lock, Core compiled with its test
# classpath recorded, Formplayer's own boot jar unpacked with its classpath
# recorded, a Redis for Formplayer, HQ's Elasticsearch at HQ's own version,
# HQ's migrated database schema, HQ's page
# bundles (the editors' and the Web Apps client's) with HQ's node packages
# and the sass its stylesheets compile with, node, Chromium, and what
# Connect's receiver runs on (its Python, its virtualenv from its own lock, a
# Postgres 15 with PostGIS and a Redis) without any of Connect's source,
# which carries no license and is fetched at its pin when a proof runs.
# Nova's checkout is mounted at run time.
#
# The Android reader's runtime (proof/android) is not in this image: it is
# built from the pins on linux/amd64 by proof/android/build-runtime.sh, since
# Robolectric's native runtime has no linux/arm64 build and the runtime holds
# SDK-derived and Google libraries. Nothing here copies or imports
# proof/android; /opt/android is the pinned source the surface extractor reads.
#
# Two images come from it. `full` (--target full) is everything the stages
# install. The default target, `slim`, is `full` without what the lane never
# opens, flattened into one layer: it is the image proof/image.lock records
# and every run pulls. The image workflow runs the lane on both and compares
# what they observe.

ARG PYTHON_IMAGE=python:3.13-slim-bookworm@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.10.4@sha256:4cac394b6b72846f8a85a7a0e577c6d61d4e17fe2ccee65d9451a8b3c9efb4ac
# Connect's Python (its pyproject.toml requires 3.11, and its own Dockerfile
# runs python:3.11-slim-bookworm), on the same Debian as the image's.
ARG CONNECT_PYTHON_IMAGE=python:3.11-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89
# What the Connect runtime is laid over: the stage holding everything else
# (`hq-full`), or an image already built from this recipe, which rebuilds the
# Connect runtime alone:
#   docker build $(node proof/image/build-args.mjs) --build-arg FULL_BASE=<image> \
#     --target full -f proof/image/Dockerfile -t nova-proof:dev .
ARG FULL_BASE=hq-full

FROM ${UV_IMAGE} AS uv

# ---------------------------------------------------------------------------
# Upstream sources, each fetched at exactly its pinned commit.
FROM ${PYTHON_IMAGE} AS sources
ARG HQ_COMMIT
ARG CORE_COMMIT
ARG ANDROID_COMMIT
ARG FORMPLAYER_COMMIT
RUN test -n "$HQ_COMMIT" && test -n "$CORE_COMMIT" && test -n "$ANDROID_COMMIT" && test -n "$FORMPLAYER_COMMIT"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY proof/image/fetch-commit.sh /usr/local/bin/fetch-commit
RUN fetch-commit https://github.com/dimagi/commcare-hq.git "$HQ_COMMIT" /opt/hq --submodules
RUN fetch-commit https://github.com/dimagi/commcare-core.git "$CORE_COMMIT" /opt/core
RUN fetch-commit https://github.com/dimagi/commcare-android.git "$ANDROID_COMMIT" /opt/android
# Formplayer with the Core it vendors (libs/commcare, a submodule at the commit
# Formplayer's own tree records): the Core Formplayer runs is that one, whatever
# the Core pin is, and the harness's self-test says where the two differ
# (proof/formplayer/test_boot.py).
RUN fetch-commit https://github.com/dimagi/formplayer.git "$FORMPLAYER_COMMIT" /opt/formplayer --submodules
# The HQ pin's commit time, the clock HQ's operations start from
# (proof/hq/determinism.py::EPOCH), readable where no git is installed.
RUN git -C /opt/hq log -1 --format=%cI > /opt/hq-pin-time && test -s /opt/hq-pin-time

# ---------------------------------------------------------------------------
# HQ's virtualenv, from HQ's own lock (the groups HQ's own test image
# installs). Only the lock's git and URL sources and the package index are
# reached, and only here. Bytecode is compiled here so each check's HQ boot
# reads it instead of compiling HQ's dependencies.
FROM ${PYTHON_IMAGE} AS hq-venv
COPY --from=uv /uv /usr/local/bin/uv
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     build-essential git pkg-config \
     libpq-dev libxml2-dev libxmlsec1-dev libxmlsec1-openssl libxslt1-dev libmagic1 \
  && rm -rf /var/lib/apt/lists/*
ENV UV_PROJECT_ENVIRONMENT=/opt/hq-venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
COPY --from=sources /opt/hq/.python-version /opt/hq/pyproject.toml /opt/hq/uv.lock /tmp/hq-project/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --group test --no-install-project --project /tmp/hq-project \
  && rm -rf /tmp/hq-project

# ---------------------------------------------------------------------------
# Connect's virtualenv, from Connect's own lock at its pin, on Connect's
# Python: the environment Connect's own tests run in (its default groups),
# which holds the factories the Connect proof makes an opportunity with
# (proof/connect/driver.py). Connect's checkout carries no
# license file, so only its lock is read here and none of its source reaches
# the image: the lane fetches Connect at its pin when it runs
# (proof/connect/runtime.py). The interpreter and the virtualenv keep these
# paths in the final image, where `python3` is another version, so the
# virtualenv names its interpreter by version.
FROM ${CONNECT_PYTHON_IMAGE} AS connect-venv
ARG CONNECT_COMMIT
RUN test -n "$CONNECT_COMMIT"
COPY --from=uv /uv /usr/local/bin/uv
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git build-essential libpq-dev \
  && rm -rf /var/lib/apt/lists/*
COPY proof/image/fetch-commit.sh /usr/local/bin/fetch-commit
ENV UV_PROJECT_ENVIRONMENT=/opt/connect-venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
RUN --mount=type=cache,target=/root/.cache/uv \
    sh /usr/local/bin/fetch-commit https://github.com/dimagi/commcare-connect.git "$CONNECT_COMMIT" /tmp/connect \
  && mkdir /tmp/connect-project \
  && cp /tmp/connect/pyproject.toml /tmp/connect/uv.lock /tmp/connect-project/ \
  && uv sync --frozen --no-install-project --project /tmp/connect-project \
  && rm -rf /tmp/connect /tmp/connect-project \
  && ln -sfn /usr/local/bin/python3.11 /opt/connect-venv/bin/python \
  && printf '%s\n' "$CONNECT_COMMIT" > /opt/connect-venv/proof-connect-pin

# ---------------------------------------------------------------------------
# CommCare Core compiled at its pin, with the Gradle cache that its tests
# resolve against, so the image runs Core's build offline.
FROM ${PYTHON_IMAGE} AS core-build
# Core's sources and tests hold UTF-8 text; javac reads them in the locale's
# encoding, which the slim image leaves at US-ASCII.
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
ARG GRADLE_VERSION=8.1.1
ARG GRADLE_SHA256=e111cb9948407e26351227dabce49822fb88c37ee72f1d1582a69c68af2e702f
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip openjdk-17-jdk-headless \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/gradle.zip "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
  && echo "${GRADLE_SHA256}  /tmp/gradle.zip" | sha256sum -c - \
  && unzip -q /tmp/gradle.zip -d /opt \
  && mv "/opt/gradle-${GRADLE_VERSION}" /opt/gradle \
  && rm /tmp/gradle.zip
ENV GRADLE_USER_HOME=/opt/gradle-home PATH=/opt/gradle/bin:$PATH
COPY --from=sources /opt/core /opt/core
COPY proof/image/core-classpath.init.gradle /opt/proof-image/core-classpath.init.gradle
WORKDIR /opt/core
RUN gradle --no-daemon -I /opt/proof-image/core-classpath.init.gradle \
      -PnovaClasspathFile=/opt/core/proof-test-classpath.txt \
      testClasses writeNovaTestClasspath \
  && test -s /opt/core/proof-test-classpath.txt

# ---------------------------------------------------------------------------
# Formplayer's own boot jar, built by Formplayer's own Gradle build at its pin
# (its wrapper names the Gradle this stage holds), unpacked so the harness's
# runner starts Formplayer's application on exactly the classes and libraries
# production's launcher loads (formplayer/build.sh). Its Gradle home is its
# own and is left behind: the image never builds Formplayer again.
FROM core-build AS formplayer-build
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
COPY --from=sources /opt/formplayer /opt/formplayer
COPY proof/image/formplayer/ /opt/proof-image/formplayer/
RUN GRADLE_USER_HOME=/tmp/formplayer-gradle-home \
      /opt/proof-image/formplayer/build.sh /opt/formplayer /opt/formplayer-app \
  && rm -rf /tmp/formplayer-gradle-home

# ---------------------------------------------------------------------------
# Node at Nova's version (.nvmrc), npm at Nova's (package.json devEngines), and
# yarn classic, which HQ's own lock is written for.
FROM ${PYTHON_IMAGE} AS node
ARG NODE_VERSION
ARG NPM_VERSION
ARG YARN_VERSION=1.22.22
ARG TARGETARCH
RUN test -n "$NODE_VERSION" && test -n "$NPM_VERSION"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && node_file="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
  && curl -fsSLo "/tmp/${node_file}" "https://nodejs.org/dist/v${NODE_VERSION}/${node_file}" \
  && curl -fsSLo /tmp/SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
  && (cd /tmp && grep " ${node_file}\$" SHASUMS256.txt | sha256sum -c -) \
  && mkdir -p /opt/node \
  && tar -xJf "/tmp/${node_file}" -C /opt/node --strip-components=1 \
  && rm "/tmp/${node_file}" /tmp/SHASUMS256.txt
ENV PATH=/opt/node/bin:$PATH
RUN npm install --global "npm@${NPM_VERSION}" "yarn@${YARN_VERSION}" --ignore-scripts --no-audit --no-fund

# ---------------------------------------------------------------------------
# HQ's node packages from HQ's own lock (HQ's .yarnrc sets ignore-scripts).
# The final image keeps them whole, where HQ finds them: HQ's build runs its
# XPath validator on two (xpath_validator/nodejs/), HQ's static finders and
# stylesheet precompiler read the rest for the Web Apps page, and the page
# bundles are built from them.
FROM node AS hq-node
COPY --from=sources /opt/hq/package.json /opt/hq/yarn.lock /opt/hq/.yarnrc /opt/hq-node/
WORKDIR /opt/hq-node
RUN yarn install --frozen-lockfile --non-interactive --no-progress \
  && test -f node_modules/xpath/dist/js-xpath.js \
  && test -f node_modules/underscore/underscore.js

# ---------------------------------------------------------------------------
# HQ's editor pages' and Web Apps page's JavaScript, bundled from HQ's node
# packages with esbuild under a configuration read from HQ's own webpack
# configuration (editors/build.mjs), for the editor driver (proof/editors)
# and the Web Apps driver (proof/webapps). HQ's node
# packages sit where HQ's own build finds them; the image's Node tools
# (tools/package.json) supply esbuild and acorn.
FROM hq-node AS editors
COPY --from=sources /opt/hq /opt/hq
COPY proof/image/tools/package.json proof/image/tools/package-lock.json /opt/proof-tools/
RUN cd /opt/proof-tools && npm ci --ignore-scripts --no-audit --no-fund
COPY proof/image/editors/ /opt/proof-image/editors/
RUN mv /opt/hq-node/node_modules /opt/hq/node_modules \
  && node /opt/proof-image/editors/build.mjs --hq /opt/hq --out /opt/editors --tools /opt/proof-tools

# ---------------------------------------------------------------------------
# HQ's Elasticsearch: the version and the one plugin HQ's own image of it
# holds (docker/files/Dockerfile.es.6, which proof/hq/test_elasticsearch.py
# holds this to), as Elastic's Apache-licensed OSS tarball, which runs on the
# image's JDK on both architectures (Elastic published no arm64 image of 6.8).
# Each pytest worker starts one of its own (proof/hq/elasticsearch.py), with
# a copy of this configuration where ES writes its keystore. Three of the
# tarball's JVM options are left out: UseAVX=2 (a workaround for JDK 10 on
# AVX-512 hardware, which an arm64 JVM refuses as an unknown option), and the
# GC log and crash files, which the tarball writes beside itself and the
# runtime's own user cannot.
FROM core-build AS elasticsearch
ARG ELASTICSEARCH_VERSION=6.8.23
ARG ELASTICSEARCH_SHA512=14dbb2809b06499373c3ec5035d829d62255c2c93103618fbfe3d7d03cecf8847f654e83c78f765f23224126ff18ed713b959857e8ecf435c475b11bcd143d3f
ARG ELASTICSEARCH_PHONETIC_SHA512=1aae7a94a9cb16f07115b2236d54114a3754eb7bc171a8195772d229cba083c18d4055baab66abde82270583e736aa7f3e9ae56df04f657319810497ef19e5c4
RUN curl -fsSLo /tmp/elasticsearch.tar.gz \
     "https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-oss-${ELASTICSEARCH_VERSION}.tar.gz" \
  && echo "${ELASTICSEARCH_SHA512}  /tmp/elasticsearch.tar.gz" | sha512sum -c - \
  && curl -fsSLo /tmp/analysis-phonetic.zip \
     "https://artifacts.elastic.co/downloads/elasticsearch-plugins/analysis-phonetic/analysis-phonetic-${ELASTICSEARCH_VERSION}.zip" \
  && echo "${ELASTICSEARCH_PHONETIC_SHA512}  /tmp/analysis-phonetic.zip" | sha512sum -c - \
  && tar -xzf /tmp/elasticsearch.tar.gz -C /opt \
  && mv "/opt/elasticsearch-${ELASTICSEARCH_VERSION}" /opt/elasticsearch \
  && /opt/elasticsearch/bin/elasticsearch-plugin install --batch file:///tmp/analysis-phonetic.zip \
  && rm /tmp/elasticsearch.tar.gz /tmp/analysis-phonetic.zip \
  && sed -i -e '/UseAVX/d' -e '/Xlog:gc/d' -e '/^8:-X/d' -e '/HeapDumpPath/d' -e '/ErrorFile/d' \
     /opt/elasticsearch/config/jvm.options \
  && ! grep -E 'UseAVX|Xlog:gc|HeapDumpPath|ErrorFile|^8:-X' /opt/elasticsearch/config/jvm.options \
  && test -d /opt/elasticsearch/plugins/analysis-phonetic \
  && chown -R root:root /opt/elasticsearch \
  && chmod -R a+rX,go-w /opt/elasticsearch

# ---------------------------------------------------------------------------
# HQ's database as HQ's own migrations leave it (hq-schema/migrate.py),
# dumped once here; each check clones it.
FROM ${PYTHON_IMAGE} AS hq-schema
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/opt/hq-venv/bin:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
     libpq5 libxml2 libxmlsec1 libxmlsec1-openssl libxslt1.1 libmagic1 gettext \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSLo /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
     > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-14 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=sources /opt/hq /opt/hq
COPY --from=sources /opt/hq-pin-time /opt/hq-pin-time
COPY --from=hq-venv /opt/hq-venv /opt/hq-venv
COPY proof/__init__.py /opt/proof-image/py/proof/__init__.py
# The harness's boot and every module it may import (proof/hq/boot.py::boot):
# the package's Python without its tests (Dockerfile.dockerignore), and the
# process owner HQ's Elasticsearch is started under (proof/hq/elasticsearch.py).
COPY proof/processes.py /opt/proof-image/py/proof/processes.py
COPY proof/hq/ /opt/proof-image/py/proof/hq/
COPY proof/image/hq-schema/ /opt/proof-image/hq-schema/
RUN /opt/proof-image/hq-schema/build.sh

# ---------------------------------------------------------------------------
# Everything but the Connect runtime.
FROM ${PYTHON_IMAGE} AS hq-full
ARG JAVAPARSER_VERSION=3.28.2
ARG JAVAPARSER_SHA256=b5499a3b1c40b16c0671fabe478c9aafeab38160c6fde74a6c13f42d86716ecd
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates curl gnupg git openjdk-17-jdk-headless redis-server \
     libpq5 libxml2 libxmlsec1 libxmlsec1-openssl libxslt1.1 libmagic1 gettext \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSLo /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
     > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-14 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node /opt/node /opt/node
ENV PATH=/opt/node/bin:$PATH
# The image's own Node tools (proof/image/tools): esbuild, acorn,
# playwright-core with the Chromium it drives, and the sass HQ's stylesheet
# precompiler runs.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
COPY proof/image/tools/package.json proof/image/tools/package-lock.json /opt/proof-tools/
RUN cd /opt/proof-tools \
  && npm ci --ignore-scripts --no-audit --no-fund \
  && node node_modules/playwright-core/cli.js install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*
# JavaParser, which the surface extractor uses to read Core's and Android's
# Java sources.
RUN mkdir -p /opt/proof-tools/java \
  && curl -fsSLo "/opt/proof-tools/java/javaparser-core-${JAVAPARSER_VERSION}.jar" \
     "https://repo1.maven.org/maven2/com/github/javaparser/javaparser-core/${JAVAPARSER_VERSION}/javaparser-core-${JAVAPARSER_VERSION}.jar" \
  && echo "${JAVAPARSER_SHA256}  /opt/proof-tools/java/javaparser-core-${JAVAPARSER_VERSION}.jar" | sha256sum -c -
# Python imports the harness as the package `proof`, from the worktree the
# harness mounts at /work, and nothing else from the worktree is importable.
RUN mkdir -p /opt/proof-py && ln -s /work/proof /opt/proof-py/proof
COPY --from=sources /opt/hq /opt/hq
COPY --from=sources /opt/hq-pin-time /opt/hq-pin-time
COPY --from=sources /opt/android /opt/android
COPY --from=hq-venv /opt/hq-venv /opt/hq-venv
COPY --from=core-build /opt/gradle /opt/gradle
COPY --from=core-build /opt/gradle-home /opt/gradle-home
COPY --from=core-build /opt/core /opt/core
COPY --from=formplayer-build /opt/formplayer /opt/formplayer
COPY --from=formplayer-build /opt/formplayer-app /opt/formplayer-app
COPY --from=hq-schema /opt/hq-schema /opt/hq-schema
# HQ's Elasticsearch, and the user it runs as: Elasticsearch refuses to run
# as root, which the lane's container is.
COPY --from=elasticsearch /opt/elasticsearch /opt/elasticsearch
RUN useradd --system --no-create-home --shell /usr/sbin/nologin elasticsearch
# HQ's node packages, where HQ finds them: its XPath validator
# (corehq/apps/app_manager/xpath_validator/nodejs/), which HQ's build runs on
# every module and form filter, reads js-xpath and underscore from them, and
# HQ's static file finders and its stylesheet precompiler read the rest for
# the Web Apps page (settings.py::STATICFILES_DIRS,
# hqwebapp/precompilers.py::SassFilter; proof/webapps).
COPY --from=hq-node /opt/hq-node/node_modules /opt/hq/node_modules
# HQ's own sources compiled once, so each HQ boot reads bytecode.
RUN /opt/hq-venv/bin/python -m compileall -q -j0 -x '/node_modules/' /opt/hq
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    GRADLE_USER_HOME=/opt/gradle-home \
    PATH=/opt/hq-venv/bin:/opt/gradle/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PROOF_HQ=/opt/hq \
    PROOF_CORE=/opt/core \
    PROOF_ANDROID=/opt/android \
    PROOF_FORMPLAYER=/opt/formplayer \
    PROOF_FORMPLAYER_APP=/opt/formplayer-app \
    PROOF_HQ_SCHEMA=/opt/hq-schema/hq.sql \
    PROOF_ELASTICSEARCH=/opt/elasticsearch \
    PYTHONPATH=/opt/proof-py \
    PYTEST_DISABLE_PLUGIN_AUTOLOAD=1
# HQ's editor bundles (editors/build.mjs), last, so a change to them rebuilds
# nothing above.
COPY --from=editors /opt/editors /opt/editors
# HQ's webpack manifests, where HQ's own build writes them and HQ reads them
# (hqwebapp/utils/webpack.py::WEBPACK_BUILD_DIR).
COPY --from=editors /opt/hq/webpack/_build /opt/hq/webpack/_build

# ---------------------------------------------------------------------------
# The full image: the Connect runtime over everything else. It holds what
# Connect's form receiver runs on and none of Connect: its Python and its
# virtualenv, the libraries its own Dockerfile installs for GeoDjango and
# WeasyPrint, and the two services its docker-compose.yml starts beside it, a
# Postgres 15 with PostGIS and a Redis, which the lane starts as its own
# processes for a Connect group and stops with it (proof/connect/runtime.py).
# No cluster is created here: each run makes its own in a temporary directory.
FROM ${FULL_BASE} AS full
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-common \
  && sed -i 's/^#\?create_main_cluster.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf \
  && grep -qx 'create_main_cluster = false' /etc/postgresql-common/createcluster.conf \
  && apt-get install -y --no-install-recommends \
     binutils libproj-dev gdal-bin \
     libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
     postgresql-15 postgresql-15-postgis-3 redis-server \
  && rm -rf /var/lib/apt/lists/*
COPY --from=connect-venv /usr/local/bin/python3.11 /usr/local/bin/python3.11
COPY --from=connect-venv /usr/local/lib/libpython3.11.so.1.0 /usr/local/lib/libpython3.11.so.1.0
COPY --from=connect-venv /usr/local/lib/python3.11 /usr/local/lib/python3.11
COPY --from=connect-venv /opt/connect-venv /opt/connect-venv
RUN ldconfig \
  && /opt/connect-venv/bin/python -c "import django, psycopg2, rest_framework, oauth2_provider, geopy, jsonpath_ng, factory; from django.contrib.gis import gdal, geos; print(django.get_version(), gdal.gdal_version().decode(), geos.geos_version().decode())"
ENV PROOF_CONNECT_VENV=/opt/connect-venv \
    PROOF_CONNECT_POSTGRES=/usr/lib/postgresql/15/bin

# ---------------------------------------------------------------------------
# The full image without what the lane never opens (a traced run of the lane,
# its editors and the surface extraction opened none of it):
# - the full Chromium: every launch the harness makes is headless with no
#   channel (proof/editors/driver/driver.mjs, proof/surface/js/
#   vellum_registry.mjs), and playwright-core 1.63 then runs the headless
#   shell (Chromium.getExecutableName: options.headless ?
#   "chromium-headless-shell" : "chromium");
# - the upstream checkouts' git objects, each repository keeping its HEAD,
#   refs, index and the HEAD commit itself, which is all the harness reads
#   (git rev-parse HEAD, git log -1 --format=%cI);
# - the JDK's jmods (jlink's input) and Node's C headers (native addons' input);
# - Mesa's DRI drivers and GLX, and the LLVM and z3 they load: the headless
#   shell renders with the SwiftShader it bundles and links only libgbm of
#   Mesa, which stays. Postgres's JIT is the one other thing that loads LLVM,
#   and the Connect runtime's Postgres runs with it off
#   (proof/connect/runtime.py); what the Connect runtime links is held whole
#   below.
FROM full AS pruned
RUN set -eu; \
    rm -rf /opt/ms-playwright/chromium-[0-9]*; \
    test -x /opt/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell; \
    for gitdir in $(find /opt/hq/.git /opt/core/.git /opt/android/.git /opt/formplayer/.git \
                    -type f -name HEAD -path '*/.git*' \
                    -not -path '*/refs/*' -not -path '*/logs/*' -exec dirname {} \;); do \
      test -d "$gitdir/objects" || continue; \
      head="$(git --git-dir="$gitdir" rev-parse HEAD)"; \
      git --git-dir="$gitdir" cat-file commit "$head" > /tmp/head-commit; \
      rm -rf "$gitdir/objects" "$gitdir/logs" "$gitdir/FETCH_HEAD"; \
      mkdir -p "$gitdir/objects/info" "$gitdir/objects/pack"; \
      test "$(git --git-dir="$gitdir" hash-object -t commit -w /tmp/head-commit)" = "$head"; \
    done; \
    rm -f /tmp/head-commit; \
    for checkout in /opt/hq /opt/core /opt/android /opt/formplayer /opt/formplayer/libs/commcare; do \
      git -C "$checkout" rev-parse HEAD >/dev/null; \
      git -C "$checkout" log -1 --format=%cI >/dev/null; \
    done; \
    rm -rf /usr/lib/jvm/*/jmods /opt/node/include; \
    rm -rf /usr/lib/*-linux-gnu/dri /usr/lib/*-linux-gnu/libLLVM-*.so* /usr/lib/*-linux-gnu/libz3.so* \
           /usr/lib/*-linux-gnu/libGLX_mesa.so* /usr/lib/*-linux-gnu/libglapi.so*; \
    ldconfig; \
    ! ldd /opt/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell | grep 'not found'; \
    ! ldd /usr/lib/postgresql/15/bin/postgres /usr/lib/postgresql/15/lib/postgis-3.so /usr/bin/redis-server | grep 'not found'; \
    /opt/connect-venv/bin/python -c "from django.contrib.gis import gdal, geos; gdal.gdal_version(); geos.geos_version()"

# The image every run pulls: the pruned tree as one layer, so nothing pruned
# is downloaded, with the full image's configuration restated (a scratch
# stage inherits none); the image workflow holds the two configurations equal.
FROM scratch AS slim
COPY --from=pruned / /
ENV PATH=/opt/hq-venv/bin:/opt/gradle/bin:/opt/node/bin:/usr/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    GPG_KEY=7169605F62C751356D054A26A821E680E5FA6305 \
    PYTHON_VERSION=3.13.15 \
    PYTHON_SHA256=1e66a7945a48390ee4c2a4268a0e4185884059a13c4aab6d148aa208deea4a76 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    GRADLE_USER_HOME=/opt/gradle-home \
    PYTHONDONTWRITEBYTECODE=1 \
    PROOF_HQ=/opt/hq \
    PROOF_CORE=/opt/core \
    PROOF_ANDROID=/opt/android \
    PROOF_FORMPLAYER=/opt/formplayer \
    PROOF_FORMPLAYER_APP=/opt/formplayer-app \
    PROOF_HQ_SCHEMA=/opt/hq-schema/hq.sql \
    PROOF_ELASTICSEARCH=/opt/elasticsearch \
    PYTHONPATH=/opt/proof-py \
    PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
    PROOF_CONNECT_VENV=/opt/connect-venv \
    PROOF_CONNECT_POSTGRES=/usr/lib/postgresql/15/bin
CMD ["python3"]
