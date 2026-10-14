#!/usr/bin/env bash
# Fetch Luminous (and its engine) and build the engine Beyond's programs use.
set -euo pipefail
cd "$(dirname "$0")/.."
git submodule update --init vendor/luminous
vendor/luminous/scripts/build-quickjs.sh
