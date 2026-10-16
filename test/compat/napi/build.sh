#!/bin/sh
# Builds hello.node against the local Node headers (same ABI kestrel exports).
set -e
cd "$(dirname "$0")"
INC=$(dirname "$(dirname "$(command -v node)")")/include/node
case "$(uname -s)" in
  Darwin) cc -shared -fPIC -I"$INC" -undefined dynamic_lookup -o hello.node hello.c ;;
  *) cc -shared -fPIC -I"$INC" -o hello.node hello.c ;;
esac
