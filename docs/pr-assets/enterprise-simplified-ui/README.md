<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Simplified enterprise UI

These images render the actual macOS SwiftUI reminder offscreen with synthetic
idle state at the same size and scale. They are component previews, not running
app captures. Before uses the inspected base commit's reminder source; after
uses simplified mode. Native app lifecycle and Windows runtime validation are
separate from these images.

Enable through `SCREENPIPE_ENTERPRISE_UI_MODE=simplified`, a bundled
`enterprise.json` containing `"ui_mode": "simplified"`, or the existing policy
API's `hiddenSections: ["simplified_ui"]`. A companion control-plane PR exposes this as a deployment switch.
Enable it only after installing a desktop version with this mode.

Simplified mode retains the tray, reminder, recording health/recovery, starring,
and permission recovery. Full app windows, Settings, Chat, Search, Timeline and
Workflows entry points are suppressed. Local scheduled pipes use the existing
headless record-only gate. The star button and shortcut continue to use the
existing native persisted-session path without waking Home.

Explicit fully hidden policy takes precedence over simplified mode. Explicit
tray suppression remains independent. New server policy supersedes cached
user-file mode; environment and bundled deployment overrides remain authoritative.
Disabling simplified mode restores Home unless the user separately chose
Headless. Temporary overlay snoozes remain honored.
