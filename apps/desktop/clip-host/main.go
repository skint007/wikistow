// wikistow-clip-host is the native messaging host the browser starts for
// the WikiStow web clipper (docs/adr/0017-web-clipper.md, decision 1). It
// only relays: it copies framed messages between the browser, on its
// standard input and output, and the running desktop app, on the app's
// socket or named pipe, once each side has proved it holds the token in
// clip-host.json. While the app is closed it answers for it, and on `open`
// starts it outside the browser's reach. It holds no keys and keeps nothing.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err != nil {
		fail(err)
	}
	place, err := locate(exe)
	if err != nil {
		fail(err)
	}
	h := &host{
		in:     os.Stdin,
		out:    os.Stdout,
		caller: callerOf(os.Args[1:]),
		connect: func(caller string) (appConn, error) {
			return connectApp(place.hostFile, caller)
		},
		launch: place.launch,
		wait:   appWait,
		poll:   250 * time.Millisecond,
	}
	if err := h.run(); err != nil {
		fail(err)
	}
}

// The browser reads the host's standard error into its own log.
func fail(err error) {
	fmt.Fprintln(os.Stderr, "wikistow-clip-host:", err)
	os.Exit(1)
}

// callerOf names the extension that started the helper, from what the
// browser passes: Chrome the extension's origin first (and on Windows
// `--parent-window=…` after it), Firefox the manifest's path, then the
// extension's ID. The app checks it against the published IDs, which
// catches mistakes but proves nothing: anything running as the person can
// start the helper with any arguments.
func callerOf(args []string) string {
	if len(args) > 0 && strings.HasPrefix(args[0], "chrome-extension://") {
		return args[0]
	}
	if len(args) > 1 {
		return args[1]
	}
	return ""
}
