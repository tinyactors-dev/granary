#!/usr/bin/env bash
# Run ONE named docker container in the foreground so pitchfork can manage it
# (ADR 0027). Stopping the daemon stops *this* container synchronously (so
# ports are free again before a restart), and a leftover container with the
# same exact name from a crashed run is removed first. Only the container
# named $1 is ever touched — never pattern-based.
#
# Usage: tools/dev/container.sh <name> <docker run args…>
set -uo pipefail
name=$1; shift

docker rm -f "$name" >/dev/null 2>&1 || true

stop() {
	trap - TERM INT
	docker stop -t 10 "$name" >/dev/null 2>&1 || true
	wait "$child" 2>/dev/null
	exit 0
}
trap stop TERM INT

docker run --rm --name "$name" "$@" &
child=$!
wait "$child"
