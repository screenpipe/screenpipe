# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

variable "name" {
  type    = string
  default = "screenpipe-gateway"
}
variable "image" {
  type        = string
  description = "Public gateway image containing Azure/GCS support, pinned by digest."
  validation {
    condition     = can(regex("^[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Supply a container image pinned by sha256 digest."
  }
}
variable "license_id" { type = string }
variable "control_plane" {
  type    = string
  default = "https://screenpipe.com"
  validation {
    condition     = can(regex("^https://[a-zA-Z0-9.-]+(:[0-9]+)?$", var.control_plane))
    error_message = "Control plane must be an HTTPS origin."
  }
}
variable "policy_public_key" { type = string }
variable "prefix" {
  type    = string
  default = ""
}
variable "secret_name" {
  type        = string
  description = "Existing customer secret containing only the enrollment token; never pass its value to Terraform."
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]+$", var.secret_name))
    error_message = "Invalid secret name."
  }
}
variable "client_cidr" {
  type        = string
  description = "Private client or reverse-proxy CIDR allowed to query TCP 3040."
  validation {
    condition     = can(cidrnetmask(var.client_cidr)) && var.client_cidr != "0.0.0.0/0"
    error_message = "Use a restricted IPv4 CIDR."
  }
}
variable "disk_gb" {
  type    = number
  default = 100
}

variable "subscription_id" { type = string }
variable "resource_group" { type = string }
variable "location" { type = string }
variable "subnet_id" { type = string }
variable "storage_account" { type = string }
variable "container" { type = string }
variable "container_resource_id" {
  type        = string
  description = "ARM ID ending /blobServices/default/containers/<container>."
}
variable "key_vault_id" { type = string }
variable "key_vault_name" {
  type = string
  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$", var.key_vault_name))
    error_message = "Invalid Key Vault name."
  }
}
variable "ssh_public_key" { type = string }
