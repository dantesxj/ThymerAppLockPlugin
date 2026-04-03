# ThymerAppLockPlugin
PIN-based app lock plugin. Locks automatically after inactivity.

**⚠️‼️ This is in progress and needs support before being actually functional... right now the 'sign out' option DOES NOT WORK... it will bypass the pin and just return you to the main workspace. ‼️⚠️**

Behaviour:
 - Fresh login: NO lock screen. Idle timer starts silently.
 - After 2 min idle: lock screen appears, requiring PIN.
 - Lock screen: enter PIN to unlock, OR sign out (back to Thymer login).
 - Forgot PIN: sign out → log back in → use "Change Lock PIN" in Command Palette.
 - Command Palette → "Lock App": manual lock at any time.
 - Command Palette → "Change Lock PIN": set/change PIN freely — no current PIN required.
