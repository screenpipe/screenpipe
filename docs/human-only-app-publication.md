# Human-only app publication

<!-- doc-covers: none -->

The app release pipeline deliberately separates artifact preparation from public publication.

## AI and automation may release artifacts

`Release App` and `Release Enterprise` may build, sign, notarize, and upload immutable versioned objects. Their only R2 capability is the `screenpipe-release-artifact-uploader` service. That service accepts these key shapes:

- `releases/<version>/<target>/<artifact>`
- `enterprise/releases/<version>/<target>/<artifact>`

It has no route for updater pointers, enterprise publication state, GitHub tags, or GitHub releases. The service validates the version, target, filename, and scope before writing to R2.

## Only a human may publish

Public publication includes any of the following:

- changing `latest.json` or `beta/latest.json`;
- changing `enterprise/published.json`;
- creating an `app-v*` or `app-beta-v*` tag or GitHub release;
- notifying subscribers or announcing availability.

The human gate is the click. The authenticated releases control in the website admin UI is the only publication path: it requires an internal `releases:write` permission plus Clerk reverification, and it is the single action that writes updater pointers, creates the GitHub release, and dispatches the changelog. Before clicking, the human verifies the exact bump commit, required CI, all signed platform artifacts, and the intended channel.

Automation cannot reach that path because the release workflows hold no publication credentials at all: `076735b17` removed them, leaving `Release App` and `Release Enterprise` with only the artifact-uploader service described above. Credential scoping, not tag protection, is what keeps publication human-only.

GitHub ruleset `Human-only app publication tags` protects `app-v*` and `app-beta-v*` against creation, update, and deletion, and bypasses the repository `admin` role so the dashboard's own publish can create its tag. It is a guard against stray write-scoped tokens, not the human gate. Do not remove the bypass: doing so blocks the dashboard itself, which is exactly what silently stopped every GitHub release between `app-v2.5.176` and `2.6.0` while `latest.json` kept shipping. Environment `app-publication` requires Louis as reviewer, prevents self-review, and does not allow administrator bypass.

AI agents must not operate the admin UI, call its publication endpoint, approve the environment, or weaken the tag ruleset.

## Emergency stop

To stop artifact uploads as well as publication, delete or rotate repository secret `RELEASE_UPLOAD_TOKEN`. This does not alter already published updater pointers.
