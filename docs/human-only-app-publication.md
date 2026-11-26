# Human-only app publication

<!-- doc-covers: none -->

The app release pipeline deliberately separates artifact preparation from public publication.

## AI and automation may release artifacts

`Release App` may build, sign, notarize, and upload immutable versioned objects. Its only R2 capability is the `screenpipe-release-artifact-uploader` service. That service accepts these key shapes:

- `releases/<version>/<target>/<artifact>`
- `enterprise/releases/<version>/<target>/<artifact>`

It has no route for updater pointers, enterprise publication state, GitHub tags, or GitHub releases. The service validates the version, target, filename, and scope before writing to R2.

One `Release App` dispatch validates the commit and version, builds the frontend
snapshot, and signs one Screenpipe installer per platform target. Each new
target publishes to `releases/<version>/<target>/`. The versioned
`unified-installer.json` marker lets the dashboard distinguish the new layout
from historical builds. Deploy the release-artifact-uploader change before
the first non-dry run with that marker.

The public download page and workspace download page use the same signed
installer after stable publication. Workspace sign-in and deployment
configuration select managed policy at runtime. Employees who also have a
personal plan can choose **Use workspace on this device** in account settings.
Organization policy and authorization still govern recording, ingestion, and
automatic updates.

Existing managed installations keep their legacy bundle identifiers,
deployment packages, and update feed. Do not serve the new default app as an
in-place updater for an old managed bundle. macOS permissions are bound to
application identity, and managed deployments can have separate app data and
supervisors. Migrate a test device through its deployment tooling before
replacing a fleet package. Check sign-in, enrollment, local history, platform
permissions, updater policy, and a fresh successful upload in Workspace →
Devices before calling the migration ready. Enterprise-only recovery inputs are
accepted only for historical revisions with two installer sets.

Test a signed dry run before uploading the first unified version. Verify an
upgrade from the current standard app and a clean install with workspace
sign-in on the same installer. Use the internal dashboard to inspect staged
files. The unified artifacts are not offered by the legacy pre-release updater.

## Only a human may publish

Public publication includes any of the following:

- changing `latest.json` or `beta/latest.json`;
- changing `enterprise/published.json`;
- creating an `app-v*` or `app-beta-v*` tag or GitHub release;
- notifying subscribers or announcing availability.

The human gate is the click. The authenticated releases control in the website admin UI is the only publication path: it requires an internal `releases:write` permission plus Clerk reverification, and it is the single action that writes updater pointers, creates the GitHub release, and dispatches the changelog. Before clicking, the human verifies the exact bump commit, required CI, all signed platform artifacts, and the intended channel.

Automation cannot reach that path because `Release App` holds only the artifact-uploader capability described above. Credential scoping, not tag protection, is what keeps publication human-only.

GitHub ruleset `Human-only app publication tags` protects `app-v*` and `app-beta-v*` against creation, update, and deletion, and bypasses the repository `admin` role so the dashboard's own publish can create its tag. It is a guard against stray write-scoped tokens, not the human gate. Do not remove the bypass: doing so blocks the dashboard itself, which is exactly what silently stopped every GitHub release between `app-v2.5.176` and `2.6.0` while `latest.json` kept shipping. Environment `app-publication` requires Louis as reviewer, prevents self-review, and does not allow administrator bypass.

AI agents must not operate the admin UI, call its publication endpoint, approve the environment, or weaken the tag ruleset.

## Emergency stop

To stop artifact uploads as well as publication, delete or rotate repository secret `RELEASE_UPLOAD_TOKEN`. This does not alter already published updater pointers.
