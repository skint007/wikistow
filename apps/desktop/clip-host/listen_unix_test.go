//go:build linux || darwin

package main

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

// listenFake listens where the app would: a socket in a folder only the
// person can open. Short, as a socket's path must be.
func listenFake(t *testing.T) (net.Listener, string) {
	t.Helper()
	folder, err := os.MkdirTemp("", "clip")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(folder) })
	if err := os.Chmod(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(folder, "s")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	return listener, socket
}
