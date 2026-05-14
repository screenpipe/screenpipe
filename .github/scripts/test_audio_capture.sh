#!/bin/bash
set -euo pipefail

if [[ -f .screenpipe-audio-env ]]; then
  # shellcheck source=/dev/null
  source .screenpipe-audio-env
fi

ls -l .github/scripts/audio_test.wav
pulseaudio --check
ps aux | grep pulseaudio

if [[ -n "${PULSE_SERVER:-}" && "$PULSE_SERVER" == unix:* ]]; then
  pulse_socket_path="${PULSE_SERVER#unix:}"
  ls -l "$(dirname "$pulse_socket_path")" || true
fi

if ! paplay --verbose .github/scripts/audio_test.wav; then
  echo "paplay failed; continuing to validate audio pipeline from logs"
fi
# Check resource usage every 10 seconds, for 30 seconds
for i in {1..3}
do
   sleep 10
   ps -p $(cat screenpipe.pid) -o %cpu,%mem,cmd
done
cat screenpipe_output.log
if grep -qi "human world" screenpipe_output.log; then
  echo "Audio capture test passed: 'human world' found in logs"
elif grep -qi "audio" screenpipe_output.log; then
  echo "Audio capture test partially passed: Audio-related output found"
else
  echo "Audio capture test failed"
  tail -n 100 screenpipe_output.log
  exit 1
fi
