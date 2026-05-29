# Screenpipe SDK Enterprise License

Copyright (c) 2026 Mediar, Inc. (dba Screenpipe). All rights reserved.

This SDK is part of Screenpipe Enterprise Edition and is licensed under the
Screenpipe Enterprise License, not the MIT license used by the open source
Screenpipe core.

You may read, copy, and modify this SDK for development, evaluation, and
testing. Production use, redistribution, sublicensing, or use inside a customer
product requires a valid Screenpipe Enterprise subscription or another written
commercial agreement with Screenpipe, subject to the Small Business Exception
below.

Contact [louis@screenpi.pe](mailto:louis@screenpi.pe) for licensing inquiries.

## Small Business Exception

You may use this SDK in production, including inside a commercial product,
free of charge, if and for so long as your organization's gross revenue —
together with all parents, subsidiaries, and affiliates under common
control — is less than US$20,000 in the trailing twelve (12) months.

"Production use" means use that processes data of, or delivers
functionality to, any party other than your own evaluation environment or
internal employees.

If your organization exceeds this threshold at any point, this exception
terminates automatically. You have thirty (30) days from that date to
enter into a Screenpipe Enterprise subscription or another written
commercial agreement with Screenpipe, or to cease production use and
destroy all copies of the SDK deployed in production.

If your organization was already over the threshold when you first began
using this SDK, this exception never applied to you.

You may not split, restructure, transfer, or otherwise arrange entities
for the principal purpose of staying under this threshold.

This exception does not grant the right to redistribute, sublicense, or
offer the SDK (or a substantially similar derivative) as a hosted service
to third parties, regardless of revenue.

## Third-party components

This SDK bundles or links against the following third-party components, each
under its own licence:

- `screenpipe-screen` and related crates from the main Screenpipe repository
  (MIT-licensed) — used under the terms of MIT.
- `sck-rs`, `cidre`, `windows`, `napi`, and other Cargo dependencies — see
  each crate's own licence, redistributed in compliance with their terms.

The MIT licenses of those dependencies do NOT apply to this SDK's own source
code, which remains licensed under the Screenpipe Enterprise License.
