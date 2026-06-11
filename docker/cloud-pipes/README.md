# cloud pipes

Run a team's shared pipes on screenpipe-managed infrastructure instead of a
member's laptop. One docker container per team on a GCP host; pipes query the
team's centralized (enterprise-synced) data through the read-only
`/api/enterprise/v1` API.

## how it fits together

```
desktop app                 screenpi.pe (Vercel)                GCP host
───────────                 ────────────────────                ─────────
pipes → "cloud" tab ──────▶ /api/team/cloud-runner              controller.sh
  provision / start /         (desired state in supabase          │ polls /api/cloud-runner/work
  stop / per-pipe toggle        team_cloud_runners)                │ docker run per team
                                                                   ▼
                            /api/cloud-runner/self  ◀────── sp-team-<id> container
                              (pipes + env, reports)          runner.ts
                                                                └─ screenpipe record
                                                                   --disable-vision
                                                                   --disable-audio
                                                                   (pipe scheduler)
```

Pull-based on purpose: the GCP org blocks service-account key export, so the
website cannot call GCP. The controller polls instead.

## requirements per team

- team plan + **centralized data sync enabled** (active enterprise license
  linked to the team) — provisioning 409s otherwise
- pipes shared to the team (admin → pipe → share to team)
- optional: an AI key set in the cloud tab for pipes that call models
  (injected as `SCREENPIPE_API_KEY`)

## what pipes see in the cloud

| env var | value |
|---|---|
| `SCREENPIPE_TEAM_API_URL` | `https://screenpi.pe/api/enterprise/v1` |
| `SCREENPIPE_TEAM_API_TOKEN` | read-only `sk_ent_*` token (devices/search/records) |
| `SCREENPIPE_API_KEY` | admin-provided AI key, if configured |

A cloud pipe reads team data like:

```bash
curl -fsS "$SCREENPIPE_TEAM_API_URL/search?q=invoice&since_hours_ago=24" \
  -H "Authorization: Bearer $SCREENPIPE_TEAM_API_TOKEN"
```

The local engine API (`localhost:3030`) exists inside the container but its
database is empty — there is no capture in the cloud. Pipes that only read
`localhost:3030` data will run but see nothing; point them at the team API.

## deploy (one-time)

1. generate a secret and set it as `CLOUD_RUNNER_CONTROLLER_SECRET` on Vercel
   (website project)
2. create the host:

```bash
CLOUD_RUNNER_CONTROLLER_SECRET=<same value> ./docker/cloud-pipes/setup-host.sh
```

3. watch it come up:

```bash
gcloud compute ssh cloud-pipes-host-1 --zone us-west1-a -- \
  sudo journalctl -u cloud-pipes-controller -f
```

Updating the image: SSH in, `git -C /opt/screenpipe-src pull`,
`docker build -t sp-cloud-pipes:latest /opt/screenpipe-src/docker/cloud-pipes`,
containers pick it up on next reconcile after a `docker rm -f`.

## security model

- one container per team (`--memory 1g --cpus 0.5`); the container is the
  isolation boundary — team admins already control what code their own
  runner executes (pipes are admin-shared)
- the runner token (`crt_*`) only reaches `/api/cloud-runner/self` for that
  one team; the data token is read-only scoped
- deprovisioning revokes the data token and tears the container down
