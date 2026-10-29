# Review AI

Review GitHub pull requests with Claude, right on the PR page in Safari or Chrome. Ask Claude about the change, let it walk you through the parts worth checking, and post the review comments it drafts once you've approved them.

Everything runs on your Mac, with your own Claude subscription and your own GitHub login.

## Install

### 1. What you need

- macOS
- [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`
- The GitHub CLI 2.98 or newer, logged in: `brew install gh`, then `gh auth login`
- Claude Code, logged in: run `claude`, then `/login`
- Safari only: the full Xcode from the App Store

### 2. Start the helper

The helper is a small local server that runs Claude and talks to GitHub for the extension.

```sh
git clone https://github.com/Blaxav/review-buddy.git
cd review-buddy
bun install
./scripts/install-launchd.sh
```

The helper starts now and again at every login, so you only do this once. Its log is `~/.review-ai/helper.log`.

### 3. Add the extension to your browser

**Chrome**

1. Build the extension: `bun run build:extension`
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension/dist` folder.

**Safari**

1. Build and install the app: `./scripts/make-safari-app.sh`
2. In Safari, open Settings → Advanced and turn on **Show features for web developers**.
3. Open Settings → Developer and turn on **Allow unsigned extensions**. Safari turns this off every time it quits, so turn it back on after each restart.
4. Open Settings → Extensions, enable **Review AI** and allow it on `github.com`.

### 4. Try it

Open any pull request on github.com. A round Claude button (a sparkle) appears in the bottom-right corner: click it and ask a question.

## Use

### Ask Claude about the PR

Click the Claude button in the bottom-right corner of a PR page. Pick a starter (**Explain this PR**, **Review and draft comments**) or type your own question. Claude has the PR's branch checked out, so it reads the whole repository, not only the diff. Follow-up questions answer in about a second.

Claude runs with every tool and no permission prompts, like your own `claude` in that checkout: ask it to change the code and it can commit and push to the PR.

### Post the comments Claude drafts

When Claude suggests review comments, each one shows as a card you can edit. Nothing reaches GitHub until you click **Post** on a card.

### Ask about specific lines

Open a review comment on some lines the usual way: click `+` next to a line, or drag over line numbers. The comment box gets a Claude strip:

- **Explain** and **Find problems** discuss those lines.
- **Draft comment** and **Improve my comment** write into GitHub's comment box. You post with GitHub's own **Comment** or **Start a review** button.

### Smart review

Click **Smart review**, next to the Claude button. It takes a few minutes on a large PR and you can keep browsing meanwhile.

1. It sets aside the lines that provably need no review: code moved to another file, consistent renames, whitespace-only changes and generated files. Those lines are dimmed in the diff.
2. Claude writes a short briefing and sorts the rest of the changes into steps, each with a note right under its lines in the diff.
3. Click **Next** (or press <kbd>]</kbd>, and <kbd>[</kbd> to go back) to jump to each place worth checking. Its card says what the change does, what to verify, and any concern Claude confirmed by reading the code.
4. From a card, **Ask Claude** about those lines or **Comment** on them, then **Mark checked** to fold the card and move on.

While you walk, a bar next to the Claude button opens an overview of the briefing, every place to check, the steps to skim and what was set aside. The result is saved, so reopening the PR shows it again straight away.

## Update

```sh
git pull
bun install
./scripts/install-launchd.sh     # restarts the helper with the new code
```

Then rebuild the extension:

- **Chrome:** `bun run build:extension`, then click the reload icon on Review AI in `chrome://extensions` and reload the GitHub tab.
- **Safari:** `./scripts/make-safari-app.sh`, then reload the GitHub tab.

## Troubleshooting

**"The helper isn't reachable"**: the helper isn't running. Check `~/.review-ai/helper.log`, and run `./scripts/install-launchd.sh` again.

**"The helper's token changed since this extension was built"**: rebuild the extension (see [Update](#update)).

**The extension is missing from Safari after a restart**: Safari started before **Allow unsigned extensions** was back on and dropped the extension. Turning the setting on afterwards isn't enough; register the extension again:

```sh
APPEX="/Applications/Review AI.app/Contents/PlugIns/Review AI Extension.appex"
pluginkit -r "$APPEX" && pluginkit -a "$APPEX"
```

## Uninstall

```sh
launchctl bootout gui/$(id -u)/ai.review-ai.helper
rm ~/Library/LaunchAgents/ai.review-ai.helper.plist
rm -rf ~/.review-ai                   # clones, checkouts, saved reviews and the helper
```

Then remove the extension from `chrome://extensions`, or delete `/Applications/Review AI.app`.

## How it works

```
github.com PR page in Safari or Chrome
 └─ overlay (content script)  ──►  background script  ──►  helper on 127.0.0.1:47823
                                                             ├─ claude -p   (your Claude subscription)
                                                             └─ gh api      (posts the comments you approve)
```

- **Helper** (`helper/`): a Bun server. It clones each repository once under `~/.review-ai/repos` and checks each PR's branch out in a worktree under `~/.review-ai/worktrees` with `gh pr checkout`, so `git push` updates the PR. It keeps one `claude` process running in that worktree per conversation (the PR chat and each range of lines discussed in a comment box), so follow-up questions answer quickly. The smart review only gets read-only tools. After 30 minutes idle a process exits, and the next question resumes the conversation.
- **Extension** (`extension/`): the overlay and a background script. The background script makes every call to the helper, because GitHub's CSP blocks localhost from the page. The build puts the helper's token (`~/.review-ai/token`) into the extension, so there is nothing to paste.
- **Smart review**: the helper sets aside the changed lines a check proves need no review:
  - **Moved**: code moved to another file line for line, with one indentation shift for the whole block. Moves within a file stay to review, because reordering statements can change behaviour.
  - **Renamed**: lines that differ only by identifiers renamed consistently across the PR, where each old name is gone from the repository and each new one existed nowhere before.
  - **Whitespace**: blank lines, and code whose tokens are unchanged. Indentation still counts in Python and YAML.
  - **Generated**: lockfiles, and files `.gitattributes` marks `linguist-generated`.

  Changes that touch only import statements aren't proven safe, so they stay in the walk, but they're read with the code that uses the names and never get a stop of their own. Claude then groups the rest into steps; the helper checks that every change left to review is in exactly one step, and saves the result per PR head under `~/.review-ai/guides`.
- **Comments**: Claude proposes them in a `review-comments` JSON block, which the overlay turns into editable cards.

## Development

```sh
bun run check                 # type check + tests
bun run helper                # run the helper in the foreground (stop the launchd one first)
bun run build:extension       # after an extension change in Chrome, then reload it in chrome://extensions
./scripts/make-safari-app.sh  # after an extension change in Safari
bun run scripts/make-icons.ts # redraws extension/icons
```
