# Review AI

A Safari overlay on GitHub pull requests: ask Claude about the change, and post the review comments it drafts.

```
github.com PR page in Safari
 └─ overlay (content script)  ──►  background script  ──►  helper on 127.0.0.1:47823
                                                             ├─ claude -p   (your Claude subscription)
                                                             └─ gh api      (posts the comments you approve)
```

- **Helper** (`helper/`): a Bun server. It clones each repository once under `~/.review-ai/repos` and checks each PR's head out in a worktree under `~/.review-ai/worktrees`. It then keeps one `claude` process running in that worktree per conversation (the PR chat and each range of lines discussed in a comment box), so follow-up questions answer in about a second. Claude only gets read-only tools (`Read`, `Grep`, `Glob`, `git diff/log/show/blame`). After 30 minutes idle the process exits, and the next question resumes the conversation.
- **Extension** (`extension/`): the overlay and a background script. The background script makes every call to the helper, because GitHub's CSP blocks localhost from the page. The build puts the helper's token (`~/.review-ai/token`) into the extension, so there is nothing to paste.
- **Claude in GitHub's comment box**: open a review comment on some lines as usual (click `+`, or drag over line numbers), and the box gets a Claude strip. **Explain** and **Find problems** discuss those lines; **Draft comment** and **Improve my comment** write into GitHub's textarea, and you post with GitHub's own **Comment** or **Start a review**. Each range of lines keeps its own conversation, with its own Claude process.
- **Smart review**: the panel's second tab. The helper first sets aside the changed lines a check proves need no review:
  - **Moved**: code moved to another file line for line, with one indentation shift for the whole block. Moves within a file stay to review, because reordering statements can change behaviour.
  - **Renamed**: lines that differ only by identifiers renamed consistently across the PR, where each old name is gone from the repository and each new one existed nowhere before.
  - **Whitespace**: blank lines, and code whose tokens are unchanged. Indentation still counts in Python and YAML.
  - **Generated**: lockfiles, and files `.gitattributes` marks `linguist-generated`.

  Claude then sorts the rest into blocks, one logical change each, in reading order. Each block has its intent, what's worth checking, and the changes that go beyond its intent. The helper checks that every change left to review lands in exactly one block. In GitHub's own diff, the proven lines are dimmed and the open block's lines get a bar; clicking a change scrolls to it. The result is saved per PR head under `~/.review-ai/guides`.
- **Comments**: Claude proposes them in a `review-comments` JSON block. Each one shows as an editable card, and nothing is posted until you click **Post**.

## Setup

Requires [Bun](https://bun.sh), the GitHub CLI logged in (`gh auth login`), Claude Code logged in (`claude`, then `/login`), and Xcode for the Safari wrapper.

```sh
bun install
./scripts/install-launchd.sh   # helper runs now and at every login; logs in ~/.review-ai/helper.log
./scripts/make-safari-app.sh   # builds the app, installs it in /Applications and opens it once
```

Then:

1. In Safari, open Settings → Advanced and turn on **Show features for web developers**. Then open Settings → Developer and turn on **Allow unsigned extensions**. Safari turns this setting off whenever it quits, unless the app is signed with your Apple developer team.
2. In Settings → Extensions, enable **Review AI** and allow it on `github.com`.
3. Open a PR and click **Ask Claude**.

## Development

```sh
bun run check            # type check + tests
bun run helper           # run the helper in the foreground (stop the launchd one first)
./scripts/make-safari-app.sh  # after an extension change; then reload github.com
bun run scripts/make-icons.ts # redraws extension/icons
```

Remove the login agent with `launchctl bootout gui/$(id -u)/ai.review-ai.helper`.
