# Screenpipe Enterprise Edition

This directory contains enterprise-only features for Screenpipe.

The code in this directory is licensed under the [Screenpipe Enterprise License](./LICENSE), not the MIT license used by the rest of the project. You may use this code for development and testing without a license, but production use requires a valid Screenpipe Enterprise subscription.

## What's in here

- **License key authentication** - replaces user login for IT-managed deployments
- **Admin policy enforcement** - centralized lockable settings pushed by admins
- **Enterprise update management** - Intune/MDM detection and Screenpipe-managed update policy
- **Enterprise UI controls** - hides consumer UI (billing, login, updates) in managed environments
- **Screenpipe SDK** - embeddable capture SDK for Electron, Swift, Tauri, and Node apps in [`sdk`](./sdk)

## What's NOT in here (stays open source)

- Team management, encrypted pipe sync, cloud sync - these are consumer features available to everyone
- Screen recording, OCR, transcription, pipes, search - core functionality under MIT

## Getting a license

Contact [louis@screenpi.pe](mailto:louis@screenpi.pe) or visit [screenpi.pe/team](https://screenpi.pe/team).
