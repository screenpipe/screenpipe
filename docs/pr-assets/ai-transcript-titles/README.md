# Meeting title screenshots

These are isolated browser previews of the production `ListView`, `MeetingWorkspaceTabs`, and `MeetingSummarySurface` components, with fictional fixture data. They are not captures of the native app or a live AI run. Temporary preview code was removed from the patch.

Base: `adeac7f5b` (the list component is unchanged). All captures use a 1280 × 720 viewport, light theme, and the same fictional meeting context.

| Image | State |
| --- | --- |
| before.png | Recreated completed-summary baseline: app-name and missing titles remain generic. |
| after.png | Proposed saved records: two topic titles, a preserved descriptive title, and an unchanged unsummarized row. |
| idle.png | No summary yet; original meeting title. |
| working.png | Summary streams normally; original meeting title remains until save. |
| ready.png | Saved summary and descriptive meeting title. |
| failed.png | Failed generation; original title remains and retry is available. |

The previews illustrate intended results of the prompt instructions; they do not call the Rust API or a model. The existing API saves the title supplied by the agent. There is no added title classifier, database guard, special summary heading or title-recovery code. Tests cover installing the revised prompt without changing user settings; live agent compliance has not been tested.
