## 1. Install the WikiStow CLI

Open PowerShell (not as administrator) and run:

```powershell
irm https://github.com/skint007/wikistow/releases/latest/download/install.ps1 | iex
```

It downloads the CLI, checks it, and adds the `wikistow` command to your PATH. Nothing else to install. Open a new PowerShell window afterwards. Run it again any time to update.

Check it works: `wikistow --version`

## 2. Enroll it

Run this in PowerShell:

```powershell
wikistow agent enroll --server {{server}} --secret-store
```

`--secret-store` keeps the unlock in Credential Manager, under Web Credentials, so your agent never has to ask for a passphrase. Leave it off on a computer nobody logs in to. To turn it on later, run `wikistow agent secret-store enable`.

1. Choose a passphrase of at least 12 characters, and type it again. It protects the agent’s key on this computer.
2. It shows a lookup code like `K7QM-4TXR`. Here in WikiStow, click **Add an agent** on the Agents page and enter it.
3. Both screens now show a fingerprint. Type `yes` in PowerShell only if they match. WikiStow asks you to type one group of it from PowerShell too.
4. Give the agent a name, pick its folders, and click **Fingerprints match, approve**.

## 3. Hand it to your agent

Check it: `wikistow whoami` shows the agent’s name and a line for each folder you picked.

Teach your AI tool to use it. For Claude Code:

```powershell
mkdir -Force $HOME\.claude\skills\wikistow
wikistow skill | Out-File -Encoding ascii $HOME\.claude\skills\wikistow\SKILL.md
```

Other tools: save the output of `wikistow skill` wherever they read skills. Run it again after you update the CLI.

That’s it. Your agent leaves its changes as drafts, and you publish them when you’re happy.
