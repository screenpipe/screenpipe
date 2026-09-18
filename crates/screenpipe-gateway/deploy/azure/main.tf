# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}
provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}
locals {
  runtime = {
    cloud             = "azure", license_id = var.license_id, control_plane = var.control_plane,
    policy_public_key = var.policy_public_key, prefix = var.prefix,
    account           = var.storage_account, container = var.container,
    vault_name        = var.key_vault_name, secret_name = var.secret_name
  }
}
resource "azurerm_network_security_group" "gateway" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group
  security_rule {
    name                       = "private-query"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "3040"
    source_address_prefix      = var.client_cidr
    destination_address_prefix = "*"
  }
  security_rule {
    name                       = "deny-other-inbound"
    priority                   = 200
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}
resource "azurerm_network_interface" "gateway" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group
  ip_configuration {
    name                          = "private"
    subnet_id                     = var.subnet_id
    private_ip_address_allocation = "Dynamic"
  }
}
resource "azurerm_network_interface_security_group_association" "gateway" {
  network_interface_id      = azurerm_network_interface.gateway.id
  network_security_group_id = azurerm_network_security_group.gateway.id
}
resource "azurerm_linux_virtual_machine" "gateway" {
  name                            = var.name
  location                        = var.location
  resource_group_name             = var.resource_group
  size                            = "Standard_D2s_v5"
  admin_username                  = "screenpipeadmin"
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.gateway.id]
  identity { type = "SystemAssigned" }
  admin_ssh_key {
    username   = "screenpipeadmin"
    public_key = var.ssh_public_key
  }
  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
  }
  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }
  custom_data = base64encode(templatefile("${path.module}/../bootstrap.sh.tftpl", {
    runtime_config = base64encode(jsonencode(local.runtime)),
    secret_loader  = filebase64("${path.module}/../load-secret.py"), image = var.image
  }))
  depends_on = [azurerm_network_interface_security_group_association.gateway]
}
resource "azurerm_managed_disk" "index" {
  name                 = "${var.name}-index"
  location             = var.location
  resource_group_name  = var.resource_group
  storage_account_type = "Premium_LRS"
  create_option        = "Empty"
  disk_size_gb         = var.disk_gb
  lifecycle { prevent_destroy = true }
}
resource "azurerm_virtual_machine_data_disk_attachment" "index" {
  managed_disk_id    = azurerm_managed_disk.index.id
  virtual_machine_id = azurerm_linux_virtual_machine.gateway.id
  lun                = 0
  caching            = "None"
}
resource "azurerm_role_assignment" "archive_reader" {
  scope                = var.container_resource_id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_linux_virtual_machine.gateway.identity[0].principal_id
}
resource "azurerm_role_assignment" "enrollment" {
  scope                = "${var.key_vault_id}/secrets/${var.secret_name}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_linux_virtual_machine.gateway.identity[0].principal_id
}
output "private_ip" { value = azurerm_network_interface.gateway.private_ip_address }
