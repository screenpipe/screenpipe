# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
mock_provider "google" {}
variables {
  name              = "screenpipe-gateway-test"
  image             = "ghcr.io/screenpipe/screenpipe-gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  license_id        = "lic-test"
  policy_public_key = "test-public-key"
  secret_name       = "gateway-enrollment"
  client_cidr       = "10.0.0.0/24"
  project           = "test-project"
  region            = "us-central1"
  zone              = "us-central1-a"
  network           = "test-network"
  subnetwork        = "test-subnet"
  bucket            = "test-archive"
}
run "private_gateway_plan" {
  command = plan
  assert {
    condition     = google_storage_bucket_iam_member.reader.role == "roles/storage.objectViewer"
    error_message = "Gateway must have read-only archive access."
  }
  assert {
    condition     = length(google_compute_instance.gateway.network_interface[0].access_config) == 0
    error_message = "Gateway must not have a public IP."
  }
  assert {
    condition     = google_compute_instance.gateway.attached_disk[0].device_name == "screenpipe-data"
    error_message = "Persistent disk must match bootstrap mount."
  }
  assert {
    condition     = google_compute_firewall.query.source_ranges == toset([var.client_cidr])
    error_message = "Query ingress must be restricted to customer clients."
  }
}
