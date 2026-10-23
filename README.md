# Review AI

A Safari overlay on GitHub pull requests: ask Claude about the change, and post the review comments it drafts.

```
github.com PR page in Safari
 └─ overlay (content script)  ──►  background script  ──►  helper on 127.0.0.1:47823
                                                             ├─ claude -p   (your Claude subscription)
                                                             └─ gh api      (posts the comments you approve)
```

- **Helper** (`helper/`): a Bun server. For each PR it checks out the head in a worktree under `~/.review-ai/worktrees`, then keeps one `claude` process running in it, so follow-up questions answer in about a second. Claude only gets read-only tools (`Read`, `Grep`, `Glob`, `git diff/log/show/blame`). After 30 minutes idle the process exits, and the next question resumes the conversation.
- **Extension** (`extension/`): the overlay and a background script. The background script holds the helper token and makes every call to the helper, because GitHub's CSP blocks localhost from the page.
- **Comments**: Claude proposes them in a `review-comments` JSON block. Each one shows as an editable card, and nothing is posted until you click **Post**.

## Setup

Requires [Bun](https://bun.sh), the GitHub CLI logged in (`gh auth login`), Claude Code logged in (`claude`, then `/login`), and Xcode for the Safari wrapper.

```sh
bun install
./scripts/install-launchd.sh   # helper runs now and at every login; logs in ~/.review-ai/helper.log
bun run token                  # the token to paste into the overlay once
./scripts/make-safari-app.sh   # generates safari/Review AI/Review AI.xcodeproj
```

Then:

1. Open the Xcode project, pick the **Review AI (macOS)** scheme and run it once. This installs the app that carries the extension.
2. In Safari, open Settings → Advanced and turn on **Show features for web developers**. Then open Settings → Developer and turn on **Allow unsigned extensions**. Safari turns this setting off whenever it quits, unless the app is signed with your Apple developer team.
3. In Settings → Extensions, enable **Review AI** and allow it on `github.com`.
4. Open a PR, click **Ask Claude** and paste the token.

## Development

```sh
bun run check            # type check + tests
bun run helper           # run the helper in the foreground (stop the launchd one first)
bun run build:extension  # rebuild extension/dist, then rebuild in Xcode
```

Remove the login agent with `launchctl bootout gui/$(id -u)/ai.review-ai.helper`.
