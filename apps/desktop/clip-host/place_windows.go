package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

// place is where this copy's app keeps clip-host.json, and how to start it.
type place struct {
	hostFile string
	launch   func() error
}

// locate finds WikiStow.exe beside the helper, as the installer puts them.
// The app keeps clip-host.json in %LOCALAPPDATA%\WikiStow Desktop, which
// only the person can read and which never roams, not in its data folder
// in %APPDATA%.
func locate(exe string) (place, error) {
	local := os.Getenv("LOCALAPPDATA")
	if !filepath.IsAbs(local) {
		return place{}, errors.New("LOCALAPPDATA isn't set")
	}
	found := place{hostFile: filepath.Join(local, "WikiStow Desktop", "clip-host.json")}
	app := filepath.Join(filepath.Dir(exe), "WikiStow.exe")
	if _, err := os.Stat(app); err == nil {
		found.launch = func() error { return startOutsideJob(app) }
	}
	return found, nil
}

// startOutsideJob starts the app out of the Job object the browser put the
// helper in, which Firefox ends with everything in it when the port
// closes. A job that refuses breakaway leaves Explorer to start it.
func startOutsideJob(app string) error {
	cmd := exec.Command(app)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_BREAKAWAY_FROM_JOB | windows.DETACHED_PROCESS,
	}
	if err := cmd.Start(); err == nil {
		return cmd.Process.Release()
	}
	explorer := filepath.Join(os.Getenv("SystemRoot"), "explorer.exe")
	if !filepath.IsAbs(explorer) {
		return errors.New("SystemRoot isn't set")
	}
	cmd = exec.Command(explorer, app)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
