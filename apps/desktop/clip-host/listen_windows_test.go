package main

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"testing"

	"github.com/Microsoft/go-winio"
)

// listenFake listens on a named pipe as the app does, named as its are.
func listenFake(t *testing.T) (net.Listener, string) {
	t.Helper()
	random := make([]byte, 8)
	_, _ = rand.Read(random)
	pipe := `\\.\pipe\wikistow-clip-test-` + hex.EncodeToString(random)
	listener, err := winio.ListenPipe(pipe, nil)
	if err != nil {
		t.Fatal(err)
	}
	return listener, pipe
}
