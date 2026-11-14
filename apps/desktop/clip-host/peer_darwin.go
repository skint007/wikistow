package main

import "golang.org/x/sys/unix"

// peerUID is the user of the process at the socket's other end, as
// getpeereid(3) reads it.
func peerUID(fd int) (int, error) {
	cred, err := unix.GetsockoptXucred(fd, unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
	if err != nil {
		return -1, err
	}
	return int(cred.Uid), nil
}
