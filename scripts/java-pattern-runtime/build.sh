#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
gradle_image="gradle:9.3.1-jdk21@sha256:ff4c34562fe6a5fe487d73bf6eb2d0dd9c71df8abfe1ed196996cf9f8b0c8f17"
jdk17_image="eclipse-temurin:17.0.20_8-jdk@sha256:5024c83bdfb071bf1e853b9c060e0c3a0c9795f5360532eb3651b01219665e7f"

docker run --rm \
  --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  --env GRADLE_USER_HOME=/tmp/gradle-home \
  --volume "$repo_root:/workspace" \
  --workdir /workspace/scripts/java-pattern-runtime \
  "$gradle_image" \
  gradle generateJavaScript --no-daemon --no-build-cache

generated_dir="$script_dir/build/generated"
mkdir -p "$generated_dir" "$repo_root/lib/preview/xpath/vendor"
docker run --rm \
  --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  --volume "$repo_root:/workspace" \
  --workdir /workspace/scripts/java-pattern-runtime \
  "$jdk17_image" \
  sh -c 'mkdir -p /tmp/openjdk-name-generator && javac -d /tmp/openjdk-name-generator generators/GenerateOpenJdkCharacterNames.java && java -cp /tmp/openjdk-name-generator GenerateOpenJdkCharacterNames' \
  > "$generated_dir/javaPatternNames.generated.ts"

runtime_artifact="$repo_root/lib/preview/xpath/vendor/javaPatternRuntime.generated.js"
runtime_banner='/*! OpenJDK 17 Pattern and fdlibm derivative (GPLv2 + Classpath Exception) compiled with TeaVM (Apache-2.0). Complete corresponding source: /third-party/java-pattern-runtime-source.tar.gz */'
{
	printf '%s\n' "$runtime_banner"
	awk 'NR == 1 && ($0 == "/*! OpenJDK 17 Pattern derivative (GPLv2 + Classpath Exception) compiled with TeaVM (Apache-2.0). Complete corresponding source: /third-party/java-pattern-runtime-source.tar.gz */" || $0 == "/*! OpenJDK 17 Pattern and fdlibm derivative (GPLv2 + Classpath Exception) compiled with TeaVM (Apache-2.0). Complete corresponding source: /third-party/java-pattern-runtime-source.tar.gz */") { next } { print }' \
		"$generated_dir/teavm/js/javaPatternRuntime.generated.js"
} > "$runtime_artifact"
cp \
  "$generated_dir/javaPatternNames.generated.ts" \
  "$repo_root/lib/preview/xpath/vendor/javaPatternNames.generated.ts"

node "$script_dir/verify.mjs"
