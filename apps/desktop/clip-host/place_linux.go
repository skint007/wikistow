package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// place is where this copy's app keeps clip-host.json, and how to start it.
type place struct {
	hostFile string
	launch   func() error
}

// locate tells the stable app from the AUR's beta by the helper's folder,
// as apps/desktop/src/install.ts does: each package installs it beside its
// app. Its data folder is Electron's, `$XDG_CONFIG_HOME/<name>`. A copy
// anywhere else, such as a development build, has no launcher.
func locate(exe string) (place, error) {
	name, launcher := "WikiStow", ""
	switch filepath.Dir(exe) {
	case "/usr/lib/wikistow-desktop":
		launcher = "/usr/bin/wikistow-desktop"
	case "/usr/lib/wikistow-desktop-beta":
		name, launcher = "WikiStow Beta", "/usr/bin/wikistow-desktop-beta"
	}
	config := os.Getenv("XDG_CONFIG_HOME")
	if !filepath.IsAbs(config) {
		home, err := os.UserHomeDir()
		if err != nil {
			return place{}, err
		}
		config = filepath.Join(home, ".config")
	}
	found := place{hostFile: filepath.Join(config, name, "clip-host.json")}
	if launcher != "" {
		found.launch = func() error { return startDetached(launcher) }
	}
	return found, nil
}

// startDetached starts the app in a session of its own, so the signals
// Firefox sends the helper's process group miss it, with none of the
// helper's standard streams, so nothing it prints reaches the browser.
func startDetached(path string, args ...string) error {
	if _, err := os.Stat(path); err != nil {
		return errors.New("no launcher at " + path)
	}
	cmd := exec.Command(path, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	// Reaped while the helper runs; the system's init adopts it after.
	go func() { _ = cmd.Wait() }()
	return nil
}
