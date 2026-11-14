package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestLocate(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/home/x/.config")
	cases := []struct {
		exe, hostFile string
		launches      bool
	}{
		{"/usr/lib/wikistow-desktop/wikistow-clip-host", "/home/x/.config/WikiStow/clip-host.json", true},
		{"/usr/lib/wikistow-desktop-beta/wikistow-clip-host", "/home/x/.config/WikiStow Beta/clip-host.json", true},
		{"/src/wikistow/apps/desktop/out/clip-host/linux-amd64/wikistow-clip-host", "/home/x/.config/WikiStow/clip-host.json", false},
	}
	for _, c := range cases {
		got, err := locate(c.exe)
		if err != nil || got.hostFile != c.hostFile || (got.launch != nil) != c.launches {
			t.Errorf("locate(%q) = %q, launches %v, %v", c.exe, got.hostFile, got.launch != nil, err)
		}
	}
	// Electron's own fallback, for no or a relative XDG_CONFIG_HOME.
	t.Setenv("XDG_CONFIG_HOME", "relative")
	t.Setenv("HOME", "/home/y")
	if got, _ := locate("/usr/lib/wikistow-desktop/wikistow-clip-host"); got.hostFile != "/home/y/.config/WikiStow/clip-host.json" {
		t.Errorf("got %q", got.hostFile)
	}
}

// The app starts in a session of its own, out of the browser's process group.
func TestStartsOutsideTheSession(t *testing.T) {
	out := filepath.Join(t.TempDir(), "session")
	if err := startDetached("/bin/sh", "-c", `read -r _ _ _ _ _ sid _ < /proc/self/stat; echo "$sid" > "$0"`, out); err != nil {
		t.Fatal(err)
	}
	ours, _ := unix.Getsid(0)
	var written []byte
	for range 100 {
		if written, _ = os.ReadFile(out); strings.HasSuffix(string(written), "\n") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	theirs, err := strconv.Atoi(strings.TrimSpace(string(written)))
	if err != nil || theirs == ours {
		t.Fatalf("its session %q, ours %d", written, ours)
	}
	if err := startDetached("/nonexistent/wikistow-desktop"); err == nil {
		t.Fatal("started a missing launcher")
	}
}
