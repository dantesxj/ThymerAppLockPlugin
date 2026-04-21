# ThymerAppLockPlugin

PIN-based Thymer app lock plugin with inactivity auto-lock, manual lock controls, and a hardened sign-out flow.

## Current status

Working in current rollout.

‼️ In progress. Created by AI, vibes, and someone who knows nothing about coding! Suggestions and support very welcome! ‼️

## What it does

- Fresh login: no immediate PIN prompt; idle timer starts.
- Auto-lock after inactivity (default: 120 seconds).
- Manual lock command from Command Palette.
- Unlock via PIN.
- Sign out from lock screen to return to Thymer login.

## Command Palette commands

- `Lock App` - lock immediately (if a PIN exists).
- `Change Lock PIN` - set or change PIN while unlocked.
- `App Lock: Storage location…` - choose local-only vs synced settings storage.

## Config

`App Lock.json`:

```json
{
  "name": "App Lock",
  "icon": "ti-lock",
  "description": "PIN-based app lock. Locks automatically after inactivity. Fresh logins never prompt for a PIN — sign out to recover from a forgotten PIN.",
  "custom": {
    "lockTimeout": 120
  }
}
```

`lockTimeout` is in seconds, minimum 10.

## Notes

- Uses a resume gate so cold re-open/reload with PIN set requires unlock.
- Includes Path B storage support (`Plugin Settings` collection) with localStorage mirror fallback.
