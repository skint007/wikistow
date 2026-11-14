//go:build linux || darwin

package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

// dialApp connects to the app's Unix socket and, before anything crosses,
// checks that the process serving it runs as the person running the helper.
func dialApp(socket string) (appConn, error) {
	if !filepath.IsAbs(socket) {
		return nil, fmt.Errorf("not a socket path: %q", socket)
	}
	conn, err := net.DialTimeout("unix", socket, handshakeTime)
	if err != nil {
		return nil, err
	}
	uid, err := serverUID(conn.(*net.UnixConn))
	if err == nil && uid != os.Getuid() {
		err = fmt.Errorf("%s is served by user %d, not this one", socket, uid)
	}
	if err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

func serverUID(conn *net.UnixConn) (int, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return -1, err
	}
	uid, failed := -1, error(nil)
	if err := raw.Control(func(fd uintptr) { uid, failed = peerUID(int(fd)) }); err != nil {
		return -1, err
	}
	return uid, failed
}

// checkHostFile refuses a clip-host.json someone else owns or can change.
func checkHostFile(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || int(owner.Uid) != os.Getuid() || info.Mode().Perm()&0o022 != 0 {
		return errors.New(file.Name() + " isn't the person's own")
	}
	return nil
}
