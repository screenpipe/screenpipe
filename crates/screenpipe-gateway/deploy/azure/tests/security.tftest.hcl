# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
mock_provider "azurerm" {}
variables {
  name                  = "screenpipe-gateway-test"
  image                 = "ghcr.io/screenpipe/screenpipe-gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  license_id            = "lic-test"
  policy_public_key     = "test-public-key"
  secret_name           = "gateway-enrollment"
  client_cidr           = "10.0.0.0/24"
  subscription_id       = "00000000-0000-0000-0000-000000000000"
  resource_group        = "test"
  location              = "westus2"
  subnet_id             = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.Network/virtualNetworks/test/subnets/test"
  storage_account       = "testarchive"
  container             = "archive"
  container_resource_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.Storage/storageAccounts/testarchive/blobServices/default/containers/archive"
  key_vault_id          = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.KeyVault/vaults/testvault"
  key_vault_name        = "testvault"
  ssh_public_key        = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE0cTtS4ZETLhPta7WVYjGufJD2tss6kHpb1HXwE50qs test"
}
run "private_gateway_plan" {
  command = plan
  assert {
    condition     = azurerm_role_assignment.archive_reader.role_definition_name == "Storage Blob Data Reader"
    error_message = "Gateway must have read-only archive access."
  }
  assert {
    condition     = azurerm_role_assignment.enrollment.scope == "${var.key_vault_id}/secrets/${var.secret_name}"
    error_message = "Secret access must be scoped to enrollment."
  }
  assert {
    condition     = azurerm_linux_virtual_machine.gateway.disable_password_authentication
    error_message = "Password login must remain disabled."
  }
  assert {
    condition     = !strcontains(base64decode(azurerm_linux_virtual_machine.gateway.custom_data), "sge_")
    error_message = "Enrollment credentials must not enter cloud-init/state."
  }
}
