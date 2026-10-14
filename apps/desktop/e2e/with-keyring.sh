#!/bin/sh
# Run a command with GNOME Keyring serving the Secret Service on a private
# session bus, as on a desktop, so the desktop tests reach a real keyring.
# The login keyring is a plain-text one: it never locks, so nothing prompts.
# For CI containers only: it overwrites ~/.local/share/keyrings.
set -eu
keyrings="$HOME/.local/share/keyrings"
mkdir -p "$keyrings"
printf '[keyring]\ndisplay-name=login\nctime=0\nmtime=0\nlock-on-idle=false\nlock-after=false\n' \
  >"$keyrings/login.keyring"
printf login >"$keyrings/default"
chmod -R go-rwx "$keyrings"
exec dbus-run-session -- sh -c 'gnome-keyring-daemon --start --components=secrets >/dev/null && KEYRING=1 "$@"' sh "$@"
