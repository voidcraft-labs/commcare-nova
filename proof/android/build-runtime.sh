#!/bin/sh
# build-runtime <directory> [--android <checkout>] [--core <checkout>]
#
# Builds the Android reader's runtime (proof/android/README.md) in <directory>: commcare-android's own unit-test
# build at the commit proof/pins.json names, beside commcare-core at its pin, where the project's build expects
# it (settings.gradle: ../commcare-core). It leaves
#
#   <directory>/commcare-android, commcare-core   the two checkouts, built
#   <directory>/gradle-home                       Gradle's distribution and every dependency the build resolved
#   <directory>/classpath.txt                     the classpath Gradle gives the project's unit-test task
#   <directory>/robolectric/                      Robolectric's Android runtime for the project's tests
#   <directory>/runtime.json                      what proof/android/client.py reads
#
# The paths inside it are absolute (Gradle's classpath, and the build directories commcare-android's test
# application reads its classes from, BuildConfig.BUILD_DIR), so a runtime is used where it was built: build it
# at the path it will be read at.
#
# It needs JDK 17, git, curl, the network (Gradle's distribution, the project's dependencies from Google's and
# Maven Central's repositories and jitpack, the Android SDK packages the Android Gradle plugin asks for), and
# ANDROID_HOME naming an Android SDK whose licenses a person has accepted: the plugin installs what the build
# needs into it (platforms;android-37.0, platforms;android-36, build-tools;35.0.0, platform-tools). The plugin's
# resource compiler (aapt2) is an x86-64 binary on Linux, so on Linux this builds on amd64 alone.
#
# With --android and --core it copies local checkouts at the pinned commits instead of fetching them.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
target="$1"
shift
android_source=""
core_source=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --android) android_source="$2"; shift 2 ;;
    --core) core_source="$2"; shift 2 ;;
    *) echo "build-runtime: unknown argument $1" >&2; exit 2 ;;
  esac
done
if [ -z "${ANDROID_HOME:-}" ] || [ ! -d "$ANDROID_HOME/licenses" ]; then
  echo "build-runtime: set ANDROID_HOME to an Android SDK directory holding the licenses a person accepted" >&2
  exit 2
fi

pin() {
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]][sys.argv[3]])' \
    "$here/../pins.json" "$1" "$2"
}

# Robolectric's Android runtime for the SDK level the project's tests name (unit-tests/resources/
# robolectric.properties, sdk=23) at the Robolectric version the project builds with (app/build.gradle, 4.16.1).
# Robolectric fetches it from Maven Central when a test first runs; it is fetched here, by its checksum, so the
# reader runs offline.
ROBOLECTRIC_RUNTIME=android-all-instrumented-6.0.1_r3-robolectric-r1-i7.jar
ROBOLECTRIC_RUNTIME_URL=https://repo1.maven.org/maven2/org/robolectric/android-all-instrumented/6.0.1_r3-robolectric-r1-i7/$ROBOLECTRIC_RUNTIME
ROBOLECTRIC_RUNTIME_SHA256=bc9148d548ce6875f0df9aadb0535ef2e3a5a8cf385f47a5c6c4060a7aab4e75

mkdir -p "$target"
target="$(cd "$target" && pwd)"

checkout() {
  name="$1"; source="$2"
  commit="$(pin "$name" commit)"
  if [ -d "$target/$name/.git" ] && [ "$(git -C "$target/$name" rev-parse HEAD)" = "$commit" ]; then
    return
  fi
  rm -rf "$target/$name"
  if [ -n "$source" ]; then
    git clone -q --local "$source" "$target/$name"
    git -C "$target/$name" -c advice.detachedHead=false checkout -q "$commit"
  else
    sh "$here/../image/fetch-commit.sh" "$(pin "$name" repository)" "$commit" "$target/$name"
  fi
  test "$(git -C "$target/$name" rev-parse HEAD)" = "$commit"
}
checkout commcare-android "$android_source"
checkout commcare-core "$core_source"

mkdir -p "$target/robolectric"
if [ ! -f "$target/robolectric/$ROBOLECTRIC_RUNTIME" ]; then
  curl -fsSLo "$target/robolectric/$ROBOLECTRIC_RUNTIME.part" "$ROBOLECTRIC_RUNTIME_URL"
  mv "$target/robolectric/$ROBOLECTRIC_RUNTIME.part" "$target/robolectric/$ROBOLECTRIC_RUNTIME"
fi
actual="$( (sha256sum "$target/robolectric/$ROBOLECTRIC_RUNTIME" 2>/dev/null || shasum -a 256 "$target/robolectric/$ROBOLECTRIC_RUNTIME") | cut -d' ' -f1)"
if [ "$actual" != "$ROBOLECTRIC_RUNTIME_SHA256" ]; then
  echo "build-runtime: $ROBOLECTRIC_RUNTIME has sha256 $actual, expected $ROBOLECTRIC_RUNTIME_SHA256" >&2
  exit 1
fi

# commcare-core's build runs its own tests before it makes the jar commcare-android builds against
# (build.gradle: jar.dependsOn test), and one of them reads the machine's zone (DateRangeUtilsTest), so the
# build runs in UTC, as the project's own CI does.
cd "$target/commcare-android"
TZ=UTC GRADLE_USER_HOME="$target/gradle-home" ./gradlew --no-daemon --no-configuration-cache \
  -Dorg.gradle.parallel=false -Dorg.gradle.jvmargs="-Xmx3g -Dfile.encoding=UTF-8" \
  -I "$here/reader.init.gradle" -PnovaAndroidClasspathFile="$target/classpath.txt" \
  :app:writeNovaAndroidClasspath
test -s "$target/classpath.txt"

printf '{"classpath": "classpath.txt", "robolectric": "robolectric", "workdir": "%s"}\n' \
  "$target/commcare-android/app" > "$target/runtime.json"
echo "The Android reader's runtime is at $target."
