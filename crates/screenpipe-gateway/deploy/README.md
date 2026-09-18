<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Azure and Google Cloud private gateways

These Terraform modules run one gateway on a private Linux VM with a persistent
index disk. They use an **existing customer-owned archive and network**. They
do not deploy the website, AI inference, or workflow workers. Enrollment,
signed-policy refresh and content-free heartbeats use the hosted control plane.
An expired policy fails closed. HA/multiple replicas are not supported.

```text
Before: device → S3 archive → AWS/MinIO gateway → private search
After:  device → Azure Blob or GCS → customer VM gateway → private search
                  upload-only       read-only identity
                       └─ Screenpipe enroll / policy / health ─┘
```

## Deployment order

1. Build the gateway image with Azure/GCS support and make it available in a
   registry the VM can pull. Supply its immutable `@sha256:…` digest as `image`.
   **Older images do not support these backends.** Image publication and
   production rollout are separate from merging source.
2. Create a dedicated private archive. Block anonymous access, enable encryption
   and retention per your policy, and scope upload permissions to this archive.
   Terraform grants the VM reader access only; it does not create or configure
   your archive or the website's upload identity.
3. Use an existing private subnet with outbound access/NAT for package/image
   downloads, storage, cloud metadata, secrets and the HTTPS control plane.
   No public VM IP is created. Restrict `client_cidr` to VPN clients or your TLS
   reverse proxy. Review effective organization firewall policies too.
4. Create the enrollment secret in Key Vault (RBAC mode) or Secret Manager.
   Use a placeholder initially if needed. Pass only its name/ID to Terraform,
   never its value. Allow the VM identity through storage/secrets firewalls.
5. Enable centralized data in `/account/workspace`, then open **Private gateway
   on Azure or Google Cloud** in storage settings. Submit the upload credential
   described below. Activation writes a harmless marker and proves GET/LIST
   denial before replacing the storage binding. Old archive data is not copied.
   Revoke old readable credentials in your cloud account after switching.
6. From `deploy/azure` or `deploy/gcp`, run `terraform init`, `terraform plan`,
   review the plan, then `terraform apply`. Inputs are in `variables.tf`.
   Use ignored `.tfvars` or an approved Terraform workspace. These modules
   accept no enrollment-token values or archive reader secrets.
7. Once the VM is ready, mint a **fresh** gateway enrollment token in the
   website and put its exact value, without a trailing newline, into the named
   secret. Tokens expire quickly, so mint after provisioning. Use a protected
   input file with `az keyvault secret set --file … --output none` or
   `gcloud secrets versions add … --data-file=…`; delete the file afterward.
   Do not place token values in command arguments or Terraform variables.
8. The service retries every 30 seconds while the disk, IAM or token is not
   ready. It mounts the disk and runs the unprivileged gateway image. Configure
   your private DNS/TLS proxy and save its URL in the gateway panel. Port 3040
   is plain HTTP inside the private network; terminate TLS at your proxy for
   clients outside that trusted segment.

## Azure credentials

Use a Blob container SAS restricted to **`cw`, HTTPS only**, expiring between
one hour and seven days from activation. Prefer Entra user delegation. Do not
send Screenpipe an account key, read SAS, reader service-principal credentials,
or an OAuth refresh token. This private setup is separate from the old readable
Azure OAuth flow. Replace the upload SAS in the same form before expiry; this
initial setup does not automatically renew it.

The VM uses a system-assigned managed identity. Terraform grants **Storage Blob
Data Reader** on `container_resource_id` (the ARM container ID, not its HTTPS
URL), and **Key Vault Secrets User** on the single enrollment secret.

```text
SCREENPIPE_GATEWAY_STORAGE_PROVIDER=azure
SCREENPIPE_GATEWAY_AZURE_ACCOUNT=<account>
SCREENPIPE_GATEWAY_AZURE_CONTAINER=<container>
```

Authentication follows `object_store`'s Azure credential chain, using managed
identity on this VM. Other customer-operated environments may use its standard
`AZURE_*` credential variables. Reader credentials stay customer-side.

## GCP credentials

Use a dedicated bucket with uniform bucket-level access and public access
prevention enforced. Give a **separate upload service account** only
`roles/storage.objectCreator` on that bucket. Check inherited project/folder
permissions too. Create an HMAC key for that account and submit its access ID
and secret through the form. Rotate it there using your normal key policy.

Uploads use GCS XML/S3 interoperability at `https://storage.googleapis.com`.
The database/wire provider stays `s3_bucket` for desktop compatibility, with
`storage_cloud=gcp` selecting native gateway instructions. The gateway reads
through the **native GCS backend** using a separate VM service account with
bucket-scoped `roles/storage.objectViewer` and access to the single enrollment
secret. Enable Compute Engine, IAM and Secret Manager APIs before provisioning.

```text
SCREENPIPE_GATEWAY_STORAGE_PROVIDER=gcs
SCREENPIPE_GATEWAY_GCS_BUCKET=<bucket>
```

The native backend uses VM metadata authentication. Other customer-operated
environments can use `object_store`'s Google application/service-account
configuration. The website never receives the gateway's reader credentials.

## Operation

- The ext4 index disk and registration are owned by image UID 999. Terraform
  prevents disk destruction by default. Configure customer disk snapshots.
  The archive can rebuild the index, but preserving registration avoids
  re-enrollment. An enrolled restart does not retrieve the enrollment secret.
- Upgrade by snapshotting, changing the image digest and reviewing/applying the
  plan. VM replacement retains the separately managed disk. Keep `license_id`,
  archive and `prefix` unchanged. Do not independently enroll competing replicas.
- Probe private `/health`, verify ingest cursor progress and website
  heartbeat/canary, query known content, revoke a test token and verify denial.
- Upload-only credentials cannot delete activation markers under
  `.screenpipe-preflight/`; set a customer lifecycle rule for these markers.
- SSH ingress is disabled. Use approved VM run-command/serial-console access,
  or add explicitly reviewed private administrative ingress.

## Validation

```sh
cargo test -p screenpipe-gateway --lib --tests
python3 -m unittest discover -s crates/screenpipe-gateway/deploy -p 'test_*.py' -v
terraform -chdir=crates/screenpipe-gateway/deploy/azure init -backend=false
terraform -chdir=crates/screenpipe-gateway/deploy/azure validate
terraform -chdir=crates/screenpipe-gateway/deploy/azure test
# Repeat Terraform commands for /gcp.
```

Native SDK tests use local provider HTTP fixtures to read real telemetry,
ingest/search it and prove idempotence. Existing tests cover enrollment, tenant
isolation, signatures, revocation and restart behavior. Terraform tests use mock
providers and create no resources. They do **not** prove live cloud IAM,
networking, image pulls or VM operation. Complete a real-cloud acceptance run
before claiming production readiness.
