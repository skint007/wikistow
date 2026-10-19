## 1. Install the WikiStow CLI

Open a terminal and run:

```sh
curl -fsSL https://github.com/skint007/wikistow/releases/latest/download/install.sh | sh
```

It downloads the right file for this computer, checks it, and puts the `wikistow` command on your PATH. Nothing else to install. If it says to open a new terminal, do that. Run it again any time to update.

On Arch Linux you can install `wikistow-cli-bin` from the AUR instead. The CLI needs 64-bit Linux with glibc. Elsewhere, such as Alpine, run `node wikistow.mjs` from the release’s `wikistow-cli-<version>.tar.gz` on Node.js 26 or newer.

Check it works: `wikistow --version`

## 2. Enroll it

Run this in the terminal:

```sh
wikistow agent enroll --server {{server}} --secret-store
```

`--secret-store` keeps the unlock in your desktop keyring, so your agent never has to ask for a passphrase. It needs `secret-tool`: on Debian and Ubuntu, install `libsecret-tools` first. Leave it off on a computer nobody logs in to. To turn it on later, run `wikistow agent secret-store enable`.

1. Choose a passphrase of at least 12 characters, and type it again. It protects the agent’s key on this computer.
2. It shows a lookup code like `K7QM-4TXR`. Here in WikiStow, click **Add an agent** on the Agents page and enter it.
3. Both screens now show a fingerprint. Type `yes` in the terminal only if they match. WikiStow asks you to type one group of it from the terminal too.
4. Give the agent a name, pick its folders, and click **Fingerprints match, approve**.

## 3. Hand it to your agent

Check it: `wikistow whoami` shows the agent’s name and a line for each folder you picked.

Teach your AI tool to use it. For Claude Code:

```sh
mkdir -p ~/.claude/skills/wikistow
wikistow skill > ~/.claude/skills/wikistow/SKILL.md
```

Other tools: save the output of `wikistow skill` wherever they read skills. Run it again after you update the CLI.

That’s it. Your agent leaves its changes as drafts, and you publish them when you’re happy.
