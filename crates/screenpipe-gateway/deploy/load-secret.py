#!/usr/bin/env python3
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
"""Load enrollment from customer secrets; mount the dedicated index disk.

Never put enrollment tokens in Terraform state, cloud-init, process arguments,
or logs. Only /run (root-only) and the gateway's persistent registration hold
credentials. Metadata requests are made on the VM using its attached identity.
"""
import base64
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request


def request_json(url, headers):
    # Ignore proxy env: cloud metadata and customer secrets must not be routed
    # through a proxy. Provider URLs are constructed below, never secret input.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(urllib.request.Request(url, headers=headers), timeout=20) as response:
        return json.load(response)


def load_enrollment(config, request=request_json):
    if config["cloud"] == "azure":
        token = request("http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net", {"Metadata": "true"})["access_token"]
        url = "https://" + config["vault_name"] + ".vault.azure.net/secrets/" + urllib.parse.quote(config["secret_name"], safe="") + "?api-version=7.4"
        return request(url, {"Authorization": "Bearer " + token})["value"]
    token = request("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {"Metadata-Flavor": "Google"})["access_token"]
    name = "projects/" + config["project"] + "/secrets/" + config["secret_name"] + "/versions/latest:access"
    encoded = request("https://secretmanager.googleapis.com/v1/" + name, {"Authorization": "Bearer " + token})["payload"]["data"]
    return base64.b64decode(encoded, validate=True).decode("utf-8")


def environment(config, enrollment):
    if not enrollment.startswith("sge_") or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in enrollment):
        raise ValueError("invalid enrollment token")
    values = {
        "SCREENPIPE_GATEWAY_LICENSE_ID": config["license_id"],
        "SCREENPIPE_GATEWAY_CONTROL_PLANE": config["control_plane"],
        "SCREENPIPE_GATEWAY_POLICY_PUBKEY_B64": config["policy_public_key"],
        "SCREENPIPE_GATEWAY_ENROLLMENT_TOKEN": enrollment,
        "SCREENPIPE_GATEWAY_STORAGE_PROVIDER": "azure" if config["cloud"] == "azure" else "gcs",
        "SCREENPIPE_GATEWAY_DATA_DIR": "/data",
        "SCREENPIPE_GATEWAY_KEY_PREFIX": config.get("prefix", ""),
    }
    if config["cloud"] == "azure":
        values.update(SCREENPIPE_GATEWAY_AZURE_ACCOUNT=config["account"], SCREENPIPE_GATEWAY_AZURE_CONTAINER=config["container"])
    else:
        values["SCREENPIPE_GATEWAY_GCS_BUCKET"] = config["bucket"]
    if any("\n" in str(v) or "\r" in str(v) or "\0" in str(v) for v in values.values()):
        raise ValueError("environment values must be single-line")
    return "\n".join(k + "=" + str(v) for k, v in values.items()) + "\n"


def main():
    with open("/etc/screenpipe/runtime.json") as file:
        config = json.load(file)
    disk = "/dev/disk/azure/scsi1/lun0" if config["cloud"] == "azure" else "/dev/disk/by-id/google-screenpipe-data"
    if not os.path.exists(disk):
        raise RuntimeError("index disk not attached yet")
    mount = "/var/lib/screenpipe"
    os.makedirs(mount, exist_ok=True)
    if not os.path.ismount(mount):
        # The templates create a dedicated empty disk. Refuse unknown existing
        # filesystems rather than ever formatting an existing archive/index.
        probe = subprocess.run(["blkid", "-o", "value", "-s", "TYPE", disk], capture_output=True, text=True)
        if probe.returncode == 2:
            subprocess.run(["mkfs.ext4", disk], check=True, stdout=subprocess.DEVNULL)
        elif probe.returncode != 0 or probe.stdout.strip() != "ext4":
            raise RuntimeError("index disk has an unexpected filesystem")
        subprocess.run(["mount", disk, mount], check=True)
    os.chown(mount, 999, 999)
    os.chmod(mount, 0o700)
    # Enrollment is only needed on first boot. An expired/deleted enrollment
    # secret must never prevent restarting an already registered gateway.
    registered = os.path.isfile(mount + "/gateway-registration.json")
    enrollment = "sge_alreadyregistered" if registered else load_enrollment(config)
    content = environment(config, enrollment)
    os.umask(0o077)
    with open("/run/screenpipe-gateway.env", "w") as file:
        file.write(content)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never print a provider exception: it can contain secret response data.
        print("Gateway startup prerequisites unavailable; check disk, identity, and enrollment secret", file=sys.stderr)
        sys.exit(1)
