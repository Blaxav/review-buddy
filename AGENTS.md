# Agent notes

## Safari extension missing

When the extension doesn't show in Safari, **Allow unsigned extensions** is already on in Settings → Developer. The user always turns it back on after Safari restarts. Look for the cause elsewhere and don't suggest that setting as the fix.

Known cause: Safari starts before the setting is back on, fails to read the ad-hoc signature and drops the extension as removed. Its log shows `Computing the code signing dictionary failed for extension with identifier: ai.review-ai.Review-AI.Extension`, then `does not have a code signature`. Read it with `/usr/bin/log show --last 2h --predicate 'process == "Safari" AND category == "Extensions"'`. Turning the setting on later doesn't make Safari scan again, and neither does a running Review AI app. Re-registering the extension does, with no rebuild:

```sh
APPEX="/Applications/Review AI.app/Contents/PlugIns/Review AI Extension.appex"
pluginkit -r "$APPEX" && pluginkit -a "$APPEX"
```
