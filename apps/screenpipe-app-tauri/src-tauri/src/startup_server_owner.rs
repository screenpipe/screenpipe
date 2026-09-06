// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StartupServerOwnerAction {
    StartOwned,
    WaitForRelease,
    PreserveExternal,
}

pub(crate) fn startup_server_owner_action(
    healthy_endpoint: bool,
    release_grace_expired: bool,
) -> StartupServerOwnerAction {
    if !healthy_endpoint {
        StartupServerOwnerAction::StartOwned
    } else if release_grace_expired {
        StartupServerOwnerAction::PreserveExternal
    } else {
        StartupServerOwnerAction::WaitForRelease
    }
}

#[cfg(test)]
mod tests {
    use super::{startup_server_owner_action, StartupServerOwnerAction};

    #[test]
    fn transient_healthy_predecessor_waits_for_release() {
        assert_eq!(
            startup_server_owner_action(true, false),
            StartupServerOwnerAction::WaitForRelease
        );
    }

    #[test]
    fn persistent_healthy_external_owner_is_preserved() {
        assert_eq!(
            startup_server_owner_action(true, true),
            StartupServerOwnerAction::PreserveExternal
        );
    }

    #[test]
    fn startup_proceeds_when_no_healthy_endpoint_exists() {
        assert_eq!(
            startup_server_owner_action(false, false),
            StartupServerOwnerAction::StartOwned
        );
    }
}
