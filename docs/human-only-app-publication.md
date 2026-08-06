# Human-only app publication

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

GitHub ruleset `Human-only app publication tags` denies app publication-tag creation, update, and deletion by default. Environment `app-publication` requires Louis as reviewer, prevents self-review, and does not allow administrator bypass.

The human publication path is the authenticated releases control in the website admin UI. Before publishing, the human must verify the exact bump commit, required CI, all signed platform artifacts, and the intended channel. If a stable GitHub release is required, the human temporarily changes the tag ruleset in GitHub's web settings, publishes from the admin UI, verifies the release, and immediately restores the ruleset to active enforcement.

AI agents must not operate the admin UI, call its publication endpoint, approve the environment, or disable/bypass the tag ruleset.

## Emergency stop

To stop artifact uploads as well as publication, delete or rotate repository secret `RELEASE_UPLOAD_TOKEN`. This does not alter already published updater pointers.
