#!/bin/bash
set -euo pipefail

if [[ -f .screenpipe-audio-env ]]; then
   # shellcheck source=/dev/null
   source .screenpipe-audio-env
fi

./target/release/screenpipe record --disable-telemetry --debug --language english > screenpipe_output.log 2>&1 &
SCREENPIPE_PID=$!
echo $SCREENPIPE_PID > screenpipe.pid
# Check resource usage every 10 seconds, for 1 minute
for i in {1..6}
do
   sleep 10
   if ps -p "$SCREENPIPE_PID" > /dev/null 2>&1; then
      ps -p "$SCREENPIPE_PID" -o %cpu,%mem,cmd
   else
      echo "[ERROR] screenpipe exited early"
      tail -n 200 screenpipe_output.log || true
      exit 1
   fi
done
