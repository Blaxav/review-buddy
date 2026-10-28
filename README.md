# Review AI

A Safari and Chrome overlay on GitHub pull requests: ask Claude about the change, and post the review comments it drafts.

```
github.com PR page in Safari or Chrome
 └─ overlay (content script)  ──►  background script  ──►  helper on 127.0.0.1:47823
                                                             ├─ claude -p   (your Claude subscription)
                                                             └─ gh api      (posts the comments you approve)
```

- **Helper** (`helper/`): a Bun server. It clones each repository once under `~/.review-ai/repos` and checks each PR's branch out in a worktree under `~/.review-ai/worktrees` with `gh pr checkout`, so `git push` updates the PR. It then keeps one `claude` process running in that worktree per conversation (the PR chat and each range of lines discussed in a comment box), so follow-up questions answer in about a second. Claude runs with every tool and no permission prompts, like your own `claude` in that checkout. The smart review only gets read-only tools. After 30 minutes idle the process exits, and the next question resumes the conversation.
- **Extension** (`extension/`): the overlay and a background script. The background script makes every call to the helper, because GitHub's CSP blocks localhost from the page. The build puts the helper's token (`~/.review-ai/token`) into the extension, so there is nothing to paste.
- **Claude in GitHub's comment box**: open a review comment on some lines as usual (click `+`, or drag over line numbers), and the box gets a Claude strip. **Explain** and **Find problems** discuss those lines; **Draft comment** and **Improve my comment** write into GitHub's textarea, and you post with GitHub's own **Comment** or **Start a review**. Each range of lines keeps its own conversation, with its own Claude process.
- **Smart review**: the **Smart review** button next to the launcher. The helper first sets aside the changed lines a check proves need no review:
  - **Moved**: code moved to another file line for line, with one indentation shift for the whole block. Moves within a file stay to review, because reordering statements can change behaviour.
  - **Renamed**: lines that differ only by identifiers renamed consistently across the PR, where each old name is gone from the repository and each new one existed nowhere before.
  - **Whitespace**: blank lines, and code whose tokens are unchanged. Indentation still counts in Python and YAML.
  - **Generated**: lockfiles, and files `.gitattributes` marks `linguist-generated`.

  It also marks the changes that touch only import statements: they aren't proven safe, so they stay in the walk, but they are read with the code that uses the names and never get a stop of their own.

  Claude then writes a briefing and sorts the rest into steps, marking the mechanical ones to skim. The review lives in GitHub's diff: each step gets a note right under its lines, like a review thread. **Next** walks only the places worth checking: it scrolls the diff until the change sits just under GitHub's headers (holding it there while the files above finish laying out) and opens its card, with what the change does, what to verify, and a concern only when Claude confirmed one by reading the code. The other places show a one-line card that opens them; mechanical steps get a quiet "Skim" line and no stop. In a card, **Ask Claude** talks about the change's lines (Explain, Find problems, Draft a comment, or your own question), starting from what the smart review said about them; **Comment** posts a review comment on those lines, written by you or drafted and improved by Claude. **Mark checked** folds the card and moves on to the next place not checked yet; the folded card stays in the diff with a check, one click from opening again, and the minimize button folds a card without checking it. A one-row bar keeps the walk in reach (<kbd>]</kbd> and <kbd>[</kbd> work too) and opens the overview: the briefing, every place worth checking, the steps to skim, and what was set aside. Proven lines are dimmed and the current step's lines get a bar. The helper checks that every change left to review is in exactly one step, and saves the result per PR head under `~/.review-ai/guides`.

- **Comments**: Claude proposes them in a `review-comments` JSON block. Each one shows as an editable card, and nothing is posted until you click **Post**.

## Setup

Requires [Bun](https://bun.sh), the GitHub CLI logged in (`gh auth login`), Claude Code logged in (`claude`, then `/login`), and Xcode for the Safari wrapper (Chrome needs nothing more).

```sh
bun install
./scripts/install-launchd.sh   # helper runs now and at every login; logs in ~/.review-ai/helper.log
```

### Safari

```sh
./scripts/make-safari-app.sh   # builds the app, installs it in /Applications and opens it once
```

Then:

1. In Safari, open Settings → Advanced and turn on **Show features for web developers**. Then open Settings → Developer and turn on **Allow unsigned extensions**. Safari turns this setting off whenever it quits, unless the app is signed with your Apple developer team.
2. In Settings → Extensions, enable **Review AI** and allow it on `github.com`.
3. Open a PR and click **Ask Claude**.

### Chrome

```sh
bun run build:extension        # builds extension/dist
```

Then:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `extension/dist`.
3. Open a PR and click **Ask Claude**.

## Development

```sh
bun run check            # type check + tests
bun run helper           # run the helper in the foreground (stop the launchd one first)
./scripts/make-safari-app.sh  # after an extension change in Safari; then reload github.com
bun run build:extension       # after an extension change in Chrome; then click reload on chrome://extensions and reload github.com
bun run scripts/make-icons.ts # redraws extension/icons
```

Remove the login agent with `launchctl bootout gui/$(id -u)/ai.review-ai.helper`.
