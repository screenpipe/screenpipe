use crate::updates::is_macos_admin;

#[test]
fn test_is_macos_admin_does_not_panic() {
    let is_admin = is_macos_admin();
    // In CI this could be either true or false depending on runner setup
    // but the function shouldn't panic.
    println!("Is admin? {}", is_admin);
    
    // Call it twice to test OnceLock
    assert_eq!(is_admin, is_macos_admin());
}
