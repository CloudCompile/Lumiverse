---
title: Illarin
---

# Illarin

Illarin is an asset platform that links to your Lumiverse instance and delivers characters, world books, presets, themes, and packs directly into your library — no manual downloads.

---

## Linking Your Instance

1. Open **Settings > Illarin**
2. Confirm the **Illarin URL** (default: `https://illarin.com`) and give your instance a name (e.g. "Home PC")
3. Click **Link**

How the link completes depends on where you're browsing from:

- **Same machine** (you opened Lumiverse on `localhost`): Lumiverse opens the Illarin approval screen in a new browser tab. Approve it there, and linking finishes on its own.
- **Another device** (phone, tablet, or another computer on your network): Lumiverse opens Illarin's verification page and shows a **device code**. Sign in and type the code. If the page is blocked, use the verification link shown beside the code.

!!! warning "Only trust codes you requested"
    Never enter a linking code you did not start yourself. The approval page must show the exact same code as your settings panel. If it doesn't, decline.

### Scopes

Linking currently requests one permission, chosen at link time:

- **asset:receive** — lets the assets you send from Illarin arrive in this instance.

Library mirroring is not requested until the local sync feature is implemented.
Adding scopes later requires unlinking and linking again.

---

## Connection Status

The Illarin settings panel shows:

- The instance name and server-assigned instance ID
- Your granted scopes
- The declared application version

Access credentials rotate automatically; nothing to maintain. Temporary network
or Illarin service failures leave the saved link in place and retry later. Only
an explicit credential rejection requires linking again.

---

## Unlinking

Click **Unlink from Illarin** to remove this instance's credentials locally.

Unlinking is local-only: also open your Illarin account settings and revoke the matching instance (matched by name and instance ID) so the platform stops holding a place for it.

---

## Privacy

Credentials are encrypted at rest and never leave this machine except to talk to Illarin itself. They are excluded from exports and backups. No chat data, messages, or personal content is shared through this integration.
