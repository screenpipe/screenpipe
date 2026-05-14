#!/bin/bash
set -euo pipefail

# A preset PULSE_SERVER can prevent pulseaudio --start from spawning.
unset PULSE_SERVER || true

pulseaudio --kill || true
sleep 2
pulseaudio --start --log-target=syslog --system=false --disallow-exit --exit-idle-time=-1 --daemon

# pulseaudio --start may return before the daemon is fully ready.
for _ in {1..10}; do
	if pulseaudio --check >/dev/null 2>&1; then
		break
	fi
	sleep 1
done

if ! pulseaudio --check >/dev/null 2>&1; then
	echo "Failed to start PulseAudio daemon"
	exit 1
fi

PULSE_SERVER="$(pactl info | awk -F': ' '/Server String:/ {print $2; exit}')"
if [[ -z "$PULSE_SERVER" ]]; then
	echo "Failed to detect PulseAudio server string"
	exit 1
fi
export PULSE_SERVER
pactl load-module module-null-sink sink_name=virtual_speaker
pactl set-default-sink virtual_speaker
pactl load-module module-virtual-source source_name=virtual_mic master=virtual_speaker.monitor
pactl set-default-source virtual_mic
echo "defaults.pcm.card 0" > ~/.asoundrc
echo "defaults.ctl.card 0" >> ~/.asoundrc
pactl list short sinks
pactl list short sources
pactl info

cat > .screenpipe-audio-env <<EOF
export PULSE_SERVER="$PULSE_SERVER"
EOF
