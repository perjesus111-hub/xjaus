#!/bin/sh
set -eu
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$APP_DIR"
exec "$APP_DIR/node_modules/electron/dist/electron" "$APP_DIR" --class=io.github.xjaus.xjaus "$@"
