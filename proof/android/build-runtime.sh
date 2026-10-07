#!/bin/sh
# build-runtime <directory> [--android <checkout>] [--core <checkout>] [--write-verification <file>]
#
# Builds the Android reader's runtime (proof/android/README.md) in <directory>: commcare-android's own unit-test
# build at the commit proof/pins.json names, beside commcare-core at its pin, where the project's build expects
# it (settings.gradle: ../commcare-core). It leaves
#
#   <directory>/commcare-android, commcare-core   the two checkouts, built
#   <directory>/gradle-dist                       Gradle's distribution
#   <directory>/gradle-home                       every dependency the build resolved
#   <directory>/classpath.txt                     the classpath Gradle gives the project's unit-test task
#   <directory>/robolectric/                      Robolectric's Android runtime for the project's tests
#   <directory>/runtime.json                      what proof/android/client.py reads
#
# The paths inside it are absolute (Gradle's classpath, and the build directories commcare-android's test
# application reads its classes from, BuildConfig.BUILD_DIR), so a runtime is used where it was built: build it
# at the path it will be read at.
#
# Everything it downloads is named exactly (proof/android/toolchain.json, proof/pins.json):
#
# - the two checkouts, each at its pinned commit;
# - Gradle's distribution and Robolectric's Android runtime, each by its sha256; the distribution is the
#   version the project's own wrapper names, and the build refuses another;
# - the Android SDK packages the build reads, which the Android Gradle plugin installs into ANDROID_HOME
#   itself where they are missing (platforms;android-37.0, platforms;android-36, build-tools;35.0.0,
#   platform-tools): once the build ends, each must be at the revision the toolchain names and hold the bytes
#   it names, or this fails and leaves no runtime.json, so nothing reads with what was built;
# - every dependency Gradle resolves, held to verification-metadata.xml beside this file where it exists
#   (Gradle's own dependency verification, the sha256 of each artifact). PROOF_ANDROID_VERIFICATION=lenient
#   reports an artifact the file does not hold and goes on, and =off skips it; --write-verification writes the
#   file a build on this platform needs, for a person to review and commit.
#
# It needs JDK 17, git, curl, unzip, python3 and the network, and ANDROID_HOME naming an Android SDK directory
# that holds the license acceptances the plugin installs under (licenses/, a person's or a runner image's:
# this script accepts none; `python3 proof/android/toolchain.py prepare-sdk <dir>` makes one that holds
# nothing else, so every package is installed afresh). The plugin's resource compiler (aapt2) is an x86-64
# binary on Linux, so on Linux this builds on amd64 alone.
#
# With --android and --core it copies local checkouts at the pinned commits instead of fetching them.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
target="$1"
shift
android_source=""
core_source=""
write_verification=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --android) android_source="$2"; shift 2 ;;
    --core) core_source="$2"; shift 2 ;;
    --write-verification) write_verification="$2"; shift 2 ;;
    *) echo "build-runtime: unknown argument $1" >&2; exit 2 ;;
  esac
done
if [ -z "${ANDROID_HOME:-}" ] || [ ! -d "$ANDROID_HOME/licenses" ]; then
  echo "build-runtime: set ANDROID_HOME to an Android SDK directory holding the licenses a person accepted (python3 proof/android/toolchain.py prepare-sdk <dir> makes one from an SDK that holds them)" >&2
  exit 2
fi

pin() {
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]][sys.argv[3]])' \
    "$here/../pins.json" "$1" "$2"
}
tool() {
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]][sys.argv[3]])' \
    "$here/toolchain.json" "$1" "$2"
}
sha256_of() {
  (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1
}
# fetched <file> <url> <sha256>: the file, downloaded where absent, refused where its bytes are not the named ones.
fetched() {
  if [ ! -f "$1" ]; then
    mkdir -p "$(dirname "$1")"
    curl -fsSLo "$1.part" "$2"
    mv "$1.part" "$1"
  fi
  actual="$(sha256_of "$1")"
  if [ "$actual" != "$3" ]; then
    echo "build-runtime: $1 has sha256 $actual, and proof/android/toolchain.json names $3" >&2
    exit 1
  fi
}

mkdir -p "$target"
target="$(cd "$target" && pwd)"

checkout() {
  name="$1"; source="$2"
  commit="$(pin "$name" commit)"
  if [ -d "$target/$name/.git" ] && [ "$(git -C "$target/$name" rev-parse HEAD)" = "$commit" ]; then
    return
  fi
  if [ -e "$target/$name" ]; then
    echo "build-runtime: $target/$name is not $name at $commit; build the runtime in a new directory" >&2
    exit 1
  fi
  if [ -n "$source" ]; then
    git clone -q --no-hardlinks "$source" "$target/$name"
    git -C "$target/$name" -c advice.detachedHead=false checkout -q "$commit"
  else
    sh "$here/../image/fetch-commit.sh" "$(pin "$name" repository)" "$commit" "$target/$name"
  fi
  test "$(git -C "$target/$name" rev-parse HEAD)" = "$commit"
}
checkout commcare-android "$android_source"
checkout commcare-core "$core_source"

# Robolectric's Android runtime for the SDK level the project's tests name (unit-tests/resources/
# robolectric.properties, sdk=23) at the Robolectric version the project builds with (app/build.gradle, 4.16.1).
# Robolectric fetches it from Maven Central when a test first runs; it is fetched here, by its checksum, so the
# reader runs offline.
fetched "$target/robolectric/$(tool robolectricAndroid file)" "$(tool robolectricAndroid url)" \
  "$(tool robolectricAndroid sha256)"

# Gradle's distribution, by its checksum: the version the project's own wrapper names.
gradle_version="$(tool gradle version)"
if ! grep -q "gradle-$gradle_version-bin.zip" "$target/commcare-android/gradle/wrapper/gradle-wrapper.properties"; then
  echo "build-runtime: commcare-android's wrapper no longer names Gradle $gradle_version; move proof/android/toolchain.json's gradle with it" >&2
  exit 1
fi
fetched "$target/gradle-dist/gradle-$gradle_version-bin.zip" "$(tool gradle url)" "$(tool gradle sha256)"
if [ ! -x "$target/gradle-dist/gradle-$gradle_version/bin/gradle" ]; then
  (cd "$target/gradle-dist" && unzip -q -o "gradle-$gradle_version-bin.zip")
fi

# Every dependency held to the checksums a person reviewed, where the file exists. Gradle reads it from the
# build's own gradle/ directory, so the harness's file is put there for the build: the one file this adds to
# the checkout's directory, and none of the checkout's own is changed.
held="$target/commcare-android/gradle/verification-metadata.xml"
verification=""
if [ -n "$write_verification" ]; then
  verification="--write-verification-metadata sha256"
elif [ -f "$here/verification-metadata.xml" ] && [ "${PROOF_ANDROID_VERIFICATION:-strict}" != "off" ]; then
  cp "$here/verification-metadata.xml" "$held"
  verification="--dependency-verification ${PROOF_ANDROID_VERIFICATION:-strict}"
fi

# commcare-core's build runs its own tests before it makes the jar commcare-android builds against
# (build.gradle: jar.dependsOn test), and one of them reads the machine's zone (DateRangeUtilsTest), so the
# build runs in UTC, as the project's own CI does.
cd "$target/commcare-android"
# shellcheck disable=SC2086
TZ=UTC GRADLE_USER_HOME="$target/gradle-home" "$target/gradle-dist/gradle-$gradle_version/bin/gradle" \
  --no-daemon --no-configuration-cache $verification \
  -Dorg.gradle.parallel=false -Dorg.gradle.jvmargs="-Xmx3g -Dfile.encoding=UTF-8" \
  -I "$here/reader.init.gradle" -PnovaAndroidClasspathFile="$target/classpath.txt" \
  :app:writeNovaAndroidClasspath
test -s "$target/classpath.txt"
if [ -n "$write_verification" ]; then
  cp "$held" "$write_verification"
  echo "The dependencies' checksums are at $write_verification."
fi

# The SDK packages the build read, each at the revision and of the bytes the toolchain names.
python3 "$here/toolchain.py" sdk "$ANDROID_HOME"

printf '{"classpath": "classpath.txt", "robolectric": "robolectric", "workdir": "%s"}\n' \
  "$target/commcare-android/app" > "$target/runtime.json"
echo "The Android reader's runtime is at $target."
