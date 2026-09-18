# Disposable VM acceptance

These helpers are **test-only**. They use public, fixed signing and bearer-token
fixtures for license `lic-live`. Never install the fixture control plane on a
customer deployment or use these tokens for customer data.

The website companion has `e2e/private-cloud-live.ts`, which proves actual
upload success and GET/LIST authorization denial using restricted Azure SAS or
GCP HMAC credentials. Run that independently before the VM checks.

## VM procedure

1. Create a disposable private archive, subnet with outbound NAT, and an
   enrollment secret containing the synthetic value `sge_live_fixture_0918`.
   Seed the gateway's `e2e/conformance/fixtures/batch-dev-alice.jsonl` under
   `live-prefix/enterprise-telemetry/lic-live/dev-alice/direct/live.jsonl`.
   Seed a second copy with `roadmap` replaced by `foreign-tenant-sentinel`
   under `live-prefix/enterprise-telemetry/lic-other/dev-alice/direct/foreign.jsonl`.
2. Build the runtime Docker image from the PR commit and pin its digest. Apply
   the corresponding module with `license_id=lic-live`, `prefix=live-prefix`,
   and the fixture public key printed by `screenpipe-gateway-policy-fixture
   --pubkey`. Use a disposable 10 GiB index disk for this test. A private test
   registry requires a separate test image-pull login; the production modules
   expect a public release image.
3. On the private VM install Python 3 and `python3-cryptography`. Run
   `control-plane-fixture.py` as a systemd service bound to **127.0.0.1:9000**.
   Set the runtime JSON's `control_plane` to `http://127.0.0.1:9000` before the
   existing loader runs. This is a test-only override: Terraform requires
   HTTPS for the customer control plane. A systemd test drop-in can run this
   override before the unmodified `load-secret.py`; preserve the existing
   Docker removal/start commands. Arrange the fixture service to start first.
4. Start the gateway using the deployed systemd unit. Run `check-vm.py` as root
   on the VM and save its JSON receipt. This verifies five record kinds,
   anonymous/unknown-token denial, device filtering, foreign-tenant exclusion,
   the persistent disk mount, root-only runtime environment, and denied writes
   using the VM's actual archive-reader identity.
5. Delete the enrollment secret in the cloud. Reboot the VM, rerun the checker,
   and compare `registration_sha256`. It must be unchanged, and all assertions
   must still pass. Preserve the fixture override across reboot; GCP reruns
   its metadata startup script.
6. Verify there is no public IP on the gateway NIC and inspect the installed
   inbound rules. Use provider run-command or a temporary, separately scoped
   IAP administrative rule to run checks. Remove that rule afterward.
7. Delete **only** the disposable resources: VM, index/boot disks, network/NAT,
   archive, fixture identities, secret, registry, and build logs. Terraform's
   index `prevent_destroy` is intentional; dispose of the known test disk
   explicitly. Remove the temporary OS Login key and verify provider inventory
   is empty for the test resource names.

A pass exercises real cloud storage, VM identities, secret managers, startup,
container runtime, enrollment/policy handling and reboot persistence. The
control plane is synthetic. It does not prove a customer's VPN/proxy/TLS,
production website database binding, or public release-image publication.
