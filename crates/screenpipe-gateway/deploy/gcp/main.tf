# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}
provider "google" {
  project = var.project
  region  = var.region
  zone    = var.zone
}
locals {
  runtime = {
    cloud             = "gcp", license_id = var.license_id, control_plane = var.control_plane,
    policy_public_key = var.policy_public_key, prefix = var.prefix,
    bucket            = var.bucket, project = var.project, secret_name = var.secret_name
  }
}
resource "google_service_account" "gateway" {
  account_id   = var.name
  display_name = "Screenpipe archive reader"
}
resource "google_storage_bucket_iam_member" "reader" {
  bucket = var.bucket
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.gateway.email}"
}
resource "google_secret_manager_secret_iam_member" "enrollment" {
  project   = var.project
  secret_id = var.secret_name
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.gateway.email}"
}
resource "google_compute_disk" "index" {
  name = "${var.name}-index"
  zone = var.zone
  type = "pd-ssd"
  size = var.disk_gb
  lifecycle { prevent_destroy = true }
}
resource "google_compute_firewall" "query" {
  name                    = "${var.name}-query"
  network                 = var.network
  priority                = 900
  source_ranges           = [var.client_cidr]
  target_service_accounts = [google_service_account.gateway.email]
  allow {
    protocol = "tcp"
    ports    = ["3040"]
  }
}
resource "google_compute_firewall" "deny" {
  name                    = "${var.name}-deny"
  network                 = var.network
  priority                = 1000
  source_ranges           = ["0.0.0.0/0"]
  target_service_accounts = [google_service_account.gateway.email]
  deny { protocol = "all" }
}
resource "google_compute_instance" "gateway" {
  name                      = var.name
  machine_type              = "e2-standard-2"
  zone                      = var.zone
  allow_stopping_for_update = true
  boot_disk {
    initialize_params { image = "ubuntu-os-cloud/ubuntu-2204-lts" }
  }
  attached_disk {
    source      = google_compute_disk.index.id
    device_name = "screenpipe-data"
  }
  network_interface { subnetwork = var.subnetwork }
  service_account {
    email  = google_service_account.gateway.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }
  metadata = { enable-oslogin = "TRUE", block-project-ssh-keys = "TRUE" }
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
  metadata_startup_script = templatefile("${path.module}/../bootstrap.sh.tftpl", {
    runtime_config = base64encode(jsonencode(local.runtime)),
    secret_loader  = filebase64("${path.module}/../load-secret.py"), image = var.image
  })
  depends_on = [google_storage_bucket_iam_member.reader, google_secret_manager_secret_iam_member.enrollment,
  google_compute_firewall.query, google_compute_firewall.deny]
}
output "private_ip" { value = google_compute_instance.gateway.network_interface[0].network_ip }
