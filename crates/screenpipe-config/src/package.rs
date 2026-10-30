// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Installer identity is established before settings are read. It is independent
//! of compiled capabilities and never authorizes recording or Enterprise access.

use std::sync::OnceLock;

static ENTERPRISE_PACKAGE: OnceLock<bool> = OnceLock::new();

pub fn initialize_package_identity(identifier: &str) -> Result<(), &'static str> {
    let enterprise = identifier == "screenpi.pe.enterprise";
    match ENTERPRISE_PACKAGE.set(enterprise) {
        Ok(()) => Ok(()),
        Err(value) if ENTERPRISE_PACKAGE.get() == Some(&value) => Ok(()),
        Err(_) => Err("package identity cannot change after initialization"),
    }
}

pub fn is_enterprise_package() -> bool {
    ENTERPRISE_PACKAGE.get().copied().unwrap_or(false)
}
