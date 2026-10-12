#!/bin/bash
# Makes a fresh Ubuntu 24.04 amd64 machine a proof machine: one that runs the
# whole lane with every reader (proof/README.md, "Running the lane on another
# machine"). Run it on that machine, from the root of a copy of this
# checkout, as a user who may sudo (proof/remote/run.sh <host> --provision
# copies the checkout there and runs it):
#
#   bash proof/remote/provision.sh [--android-licenses <directory>]
#
# It installs Docker, the Node and npm versions .nvmrc and package.json name
# (devEngines), and the JDK proof/android/toolchain.json names; raises the
# limits a box of many workers reaches; installs Nova's dependencies once
# for this checkout's lock (~/proof-remote/_deps, which run.sh links each
# slot's node_modules from); pulls the harness image proof/image.lock
# records and the Postgres proof/compose.yaml pins; and builds the Android
# reader's runtime at ~/proof-android-reader (proof/android/README.md, "The
# runtime"). The runtime's build installs Android SDK packages, which only an
# SDK whose license a person accepted may receive: --android-licenses names
# a directory holding that SDK's licenses/ (copy it from a machine where you
# accepted them). Without it every reader but Android runs.
#
# It is safe to run again: what is in place is kept.
set -euo pipefail

licenses=""
while [ $# -gt 0 ]; do
  case "$1" in
    --android-licenses) licenses="$2"; shift 2 ;;
    *) echo "provision.sh takes --android-licenses <directory>; got $1" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "A proof machine is linux/amd64: Robolectric's native runtime, which the Android reader runs on, ships for no other Linux. This one is $(uname -s) on $(uname -m)." >&2
  exit 1
fi
if [ ! -f proof/image.lock ] || [ ! -f .nvmrc ]; then
  echo "Run provision.sh from the root of a copy of the checkout (it reads .nvmrc, package.json, proof/image.lock and proof/android/toolchain.json)." >&2
  exit 1
fi
user="$(id -un)"
home="$HOME"
remote="$home/proof-remote"

# The system: packages, Docker, Node, npm, the JDK, and the limits.
sudo env DEBIAN_FRONTEND=noninteractive apt-get update -q
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -yq \
  ca-certificates curl gnupg git rsync zstd unzip python3 python3-venv jq sysstat build-essential
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo env DEBIAN_FRONTEND=noninteractive apt-get update -q
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -yq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  # Many lanes' networks at once on one machine.
  echo '{"default-address-pools":[{"base":"172.80.0.0/12","size":24}],"max-concurrent-downloads":16}' |
    sudo tee /etc/docker/daemon.json >/dev/null
  sudo systemctl restart docker
fi
sudo usermod -aG docker "$user"

node_version="$(cat .nvmrc)"
if [ "$(node --version 2>/dev/null)" != "v$node_version" ]; then
  curl -fsSL "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz" | sudo tar -xJ -C /opt
  sudo ln -sf "/opt/node-v$node_version-linux-x64/bin/"* /usr/local/bin/
fi
npm_version="$(node -p "require('./package.json').devEngines.packageManager.version")"
if [ "$(npm --version)" != "$npm_version" ]; then
  sudo /usr/local/bin/npm install --global "npm@$npm_version" --ignore-scripts >/dev/null
  sudo ln -sf "/opt/node-v$node_version-linux-x64/bin/npm" /usr/local/bin/npm
fi

jdk_version="$(python3 proof/android/toolchain.py get jdk version)"
jdk_distribution="$(python3 proof/android/toolchain.py get jdk distribution)"
if [ "$jdk_distribution" != temurin ]; then
  echo "proof/android/toolchain.json names a $jdk_distribution JDK; provision.sh installs Temurin's. Install that JDK at /opt/proof-jdk by hand." >&2
  exit 1
fi
# At one path, never behind a link: the runtime names the JDK by the absolute path it was built with, and the lane
# mounts it there (proof/run.mjs::androidRuntime). The version it holds is written beside it.
jdk=/opt/proof-jdk
if [ "$(cat "$jdk/.proof-version" 2>/dev/null)" != "$jdk_version" ]; then
  encoded="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "jdk-$jdk_version")"
  sudo rm -rf "$jdk"
  sudo mkdir -p "$jdk"
  curl -fsSL "https://api.adoptium.net/v3/binary/version/$encoded/linux/x64/jdk/hotspot/normal/eclipse" |
    sudo tar -xz -C "$jdk" --strip-components 1
  echo "$jdk_version" | sudo tee "$jdk/.proof-version" >/dev/null
fi

sudo tee /etc/sysctl.d/90-proof.conf >/dev/null <<'LIMITS'
fs.inotify.max_user_instances=8192
fs.inotify.max_user_watches=1048576
vm.max_map_count=1048576
kernel.pid_max=4194304
fs.file-max=4194304
LIMITS
sudo sysctl --system >/dev/null

# The user's: Nova's dependencies for this lock, the images, and the Android reader's runtime.
mkdir -p "$remote/_deps"
if ! cmp -s package-lock.json "$remote/_deps/package-lock.json"; then
  cp package.json package-lock.json "$remote/_deps/"
  if [ -f .npmrc ]; then cp .npmrc "$remote/_deps/"; fi
  (cd "$remote/_deps" && rm -rf node_modules && npm ci --no-audit --no-fund --ignore-scripts >/dev/null)
fi
image="$(jq -r .image proof/image.lock)"
postgres="$(python3 - <<'PY'
import re
text = open("proof/compose.yaml", encoding="utf-8").read()
print(re.search(r"^\s*image:\s*(\S*postgres\S*)\s*$", text, re.MULTILINE).group(1))
PY
)"
sudo docker pull --quiet "$image"
sudo docker pull --quiet "$postgres"

if [ -n "$licenses" ]; then
  if [ ! -f "$licenses/licenses/android-sdk-license" ]; then
    echo "--android-licenses names $licenses, which holds no licenses/android-sdk-license." >&2
    exit 1
  fi
  if [ ! -d "$home/proof-android-reader" ]; then
    export JAVA_HOME="$jdk" PATH="$jdk/bin:$PATH"
    ANDROID_HOME="$licenses" python3 proof/android/toolchain.py prepare-sdk "$home/proof-android-sdk"
    ANDROID_HOME="$home/proof-android-sdk" sh proof/android/build-runtime.sh "$home/proof-android-reader"
  fi
  PROOF_ANDROID_RUNTIME="$home/proof-android-reader" JAVA_HOME="$jdk" PATH="$jdk/bin:$PATH" TZ=UTC \
    python3 -m unittest proof.android.selfcheck proof.android.predicates
else
  echo "No --android-licenses: the Android reader's runtime was not built, so every reader but Android runs here."
fi

echo "This machine is a proof machine: $(nproc) vCPUs, $(free -g | awk '/^Mem:/ {print $2}') GB."
echo "Run the lane on it with proof/remote/run.sh <host> -- --workers <k> <pytest arguments>, about 3 GB of memory and one vCPU a worker."
