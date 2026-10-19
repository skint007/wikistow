## 1. Install the WikiStow CLI

Open Terminal and run:

```sh
curl -fsSL https://github.com/skint007/wikistow/releases/latest/download/install.sh | sh
```

It downloads the right file for this Mac, checks it, and puts the `wikistow` command on your PATH. Nothing else to install. If it says to open a new terminal, do that. Run it again any time to update.

Check it works: `wikistow --version`

## 2. Enroll it

Run this in Terminal:

```sh
wikistow agent enroll --server {{server}} --secret-store
```

`--secret-store` keeps the unlock in your login Keychain, so your agent never has to ask for a passphrase. It works in a session on the Mac’s desktop, such as Terminal: over SSH the login keychain stays locked. Leave it off on a Mac nobody logs in to. To turn it on later, run `wikistow agent secret-store enable`.

1. Choose a passphrase of at least 12 characters, and type it again. It protects the agent’s key on this Mac.
2. It shows a lookup code like `K7QM-4TXR`. Here in WikiStow, click **Add an agent** on the Agents page and enter it.
3. Both screens now show a fingerprint. Type `yes` in Terminal only if they match. WikiStow asks you to type one group of it from Terminal too.
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
