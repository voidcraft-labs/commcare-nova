#!/bin/sh
# build.sh <formplayer checkout> <application directory>
#
# Builds Formplayer's own boot jar at the checkout's commit with Formplayer's
# own Gradle build (the artifact its Dockerfile runs, build/libs/*.jar), and
# unpacks its BOOT-INF into the application directory: BOOT-INF/classes and
# BOOT-INF/lib are exactly the classes and libraries production's JarLauncher
# loads, in the order BOOT-INF/classpath.idx gives. The order is written to
# <application directory>/classpath.txt, one absolute path per line, so the
# harness's Formplayer runner (proof/formplayer/client.py) starts
# org.commcare.formplayer.Application on that classpath.
#
# The checkout keeps its sources (the runner recompiles Core's three clock
# readers from libs/commcare) and loses its build output.
set -eu
checkout="$1"
application="$2"
test -f "$checkout/build.gradle" && test -f "$checkout/libs/commcare/build.gradle"
cd "$checkout"
# One JVM for the whole build: the Kotlin compiler runs inside Gradle's.
gradle --no-daemon -Dorg.gradle.jvmargs=-Xmx2g -Pkotlin.compiler.execution.strategy=in-process bootJar
set -- build/libs/*.jar
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "build.sh: Formplayer's bootJar left $# jars in build/libs, expected exactly one" >&2
  exit 1
fi
jar_file="$checkout/$1"
mkdir -p "$application"
cd "$application"
jar xf "$jar_file" BOOT-INF
test -d BOOT-INF/classes/org/commcare/formplayer
test -s BOOT-INF/classpath.idx
{
  echo "$application/BOOT-INF/classes"
  # classpath.idx is one `- "BOOT-INF/lib/<name>.jar"` line per library.
  while IFS= read -r line; do
    entry="${line#- \"}"
    entry="${entry%\"}"
    if [ ! -f "$application/$entry" ]; then
      echo "build.sh: classpath.idx names $entry, which the jar does not hold" >&2
      exit 1
    fi
    echo "$application/$entry"
  done < BOOT-INF/classpath.idx
} > classpath.txt
# Every library the jar holds is on that classpath but Spring Boot's own
# jar-mode tools, which the index leaves out and only `-Djarmode` loads.
for library in BOOT-INF/lib/*.jar; do
  case "$library" in
    BOOT-INF/lib/spring-boot-jarmode-*) continue ;;
  esac
  if ! grep -qxF "$application/$library" classpath.txt; then
    echo "build.sh: the jar holds $library, which classpath.idx does not list" >&2
    exit 1
  fi
done
# The Core commit Formplayer vendors, which is the Core this Formplayer runs.
git -C "$checkout/libs/commcare" rev-parse HEAD > "$application/vendored-core-commit"
rm -rf "$checkout/build" "$checkout/libs/commcare/build" "$checkout/.gradle"
