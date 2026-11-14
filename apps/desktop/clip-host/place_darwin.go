package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// place is where this copy's app keeps clip-host.json, and how to start it.
type place struct {
	hostFile string
	launch   func() error
}

// locate finds the app bundle the helper sits in,
// `WikiStow.app/Contents/MacOS/wikistow-clip-host`. Its data folder is
// Electron's, `~/Library/Application Support/WikiStow`. A copy outside a
// bundle, such as a development build, has no app to open.
func locate(exe string) (place, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return place{}, err
	}
	found := place{
		hostFile: filepath.Join(home, "Library", "Application Support", "WikiStow", "clip-host.json"),
	}
	macos := filepath.Dir(exe)
	contents := filepath.Dir(macos)
	bundle := filepath.Dir(contents)
	if filepath.Base(macos) == "MacOS" && filepath.Base(contents) == "Contents" &&
		strings.HasSuffix(bundle, ".app") {
		// Launch Services starts it, so it's no child of the helper's.
		found.launch = func() error {
			if _, err := os.Stat(bundle); err != nil {
				return errors.New("no app at " + bundle)
			}
			return exec.Command("/usr/bin/open", "-a", bundle).Run()
		}
	}
	return found, nil
}
