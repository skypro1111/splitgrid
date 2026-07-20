#!/usr/bin/env bash
# Builds the Linux release inside a Linux container so node-pty / ssh2 /
# cpu-features compile against Linux (cross-building them from macOS would ship
# darwin .node binaries that crash on launch). Runs electron-forge's deb/rpm/zip
# makers — the container has dpkg/fakeroot/rpm that macOS lacks.
#
# Builds linux/amd64 (x64) even on an Apple-Silicon host via emulation. The
# host source is copied into the container (node_modules/out/.vite excluded) and
# only the finished distributables are copied back to ./out/make on the host.
set -euo pipefail

HOST_OUT="$(pwd)/out/make"
mkdir -p "$HOST_OUT"

docker run --rm \
  --platform=linux/amd64 \
  -v "$(pwd)":/src:ro \
  -v "$HOST_OUT":/out \
  node:20-bookworm \
  bash -euo pipefail -c '
    echo "==> installing native-build + packaging tooling"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      python3 build-essential fakeroot rpm dpkg-dev zip >/dev/null

    echo "==> staging source (excluding node_modules/out/.vite/.git)"
    mkdir -p /work
    tar -C /src --exclude=node_modules --exclude=out --exclude=.vite --exclude=.git -cf - . \
      | tar -C /work -xf -
    cd /work

    echo "==> npm ci (compiles linux-x64 native modules)"
    npm ci

    # npm optional-dependencies bug (#4828): the lockfile was generated on macOS,
    # so it omits the linux-x64 native binaries for rollup/esbuild that the Vite
    # build needs. Install the ones matching the locked versions explicitly.
    echo "==> patching in linux-x64 native binaries for rollup/esbuild"
    RV="$(node -p "require(\"/work/node_modules/rollup/package.json\").version")"
    EV="$(node -p "require(\"/work/node_modules/esbuild/package.json\").version")"
    npm install --no-save --no-package-lock \
      "@rollup/rollup-linux-x64-gnu@${RV}" "@esbuild/linux-x64@${EV}"

    # Portable zip only — consistent with the macOS/Windows zips. The deb/rpm
    # makers fail here because packagerConfig.executableName is "SplitGrid" (capital)
    # while electron-installer looks for the lowercase package name "splitgrid"; add
    # `options.bin: "SplitGrid"` to those makers in forge.config.ts to ship them too.
    echo "==> electron-forge make (linux/x64, zip)"
    npx electron-forge make --platform=linux --arch=x64 --targets=@electron-forge/maker-zip

    echo "==> copying distributables back to host out/make"
    cp -rv /work/out/make/. /out/
  '
