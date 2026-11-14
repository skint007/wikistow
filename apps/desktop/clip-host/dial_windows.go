package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

var allowSetForegroundWindow = windows.NewLazySystemDLL("user32.dll").NewProc("AllowSetForegroundWindow")

// dialApp connects to the app's named pipe on this computer, at an
// anonymous security level, so a pipe someone else made can't act as the
// person, and, before anything crosses, checks that the process serving it
// runs as the person running the helper. go-winio opens the pipe for
// overlapped I/O, so a read waiting on it doesn't hold up a write.
func dialApp(pipe string) (appConn, error) {
	if !strings.HasPrefix(pipe, `\\.\pipe\wikistow-clip-`) {
		return nil, fmt.Errorf("not the app's pipe: %q", pipe)
	}
	timeout := handshakeTime
	conn, err := winio.DialPipe(pipe, &timeout)
	if err != nil {
		return nil, err
	}
	pid, err := serverProcess(conn)
	if err == nil {
		err = ownedByPerson(pid)
	}
	if err != nil {
		conn.Close()
		return nil, err
	}
	// The app may bring its window forward when the extension asks it to.
	_, _, _ = allowSetForegroundWindow.Call(uintptr(pid))
	return conn, nil
}

func serverProcess(conn interface{}) (uint32, error) {
	handle, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return 0, fmt.Errorf("no handle for the pipe")
	}
	var pid uint32
	err := windows.GetNamedPipeServerProcessId(windows.Handle(handle.Fd()), &pid)
	return pid, err
}

// ownedByPerson checks that process pid runs as the same account as the helper.
func ownedByPerson(pid uint32) error {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return err
	}
	defer token.Close()
	theirs, err := token.GetTokenUser()
	if err != nil {
		return err
	}
	mine, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	if !windows.EqualSid(theirs.User.Sid, mine.User.Sid) {
		return fmt.Errorf("the pipe is served by %s, not this account", theirs.User.Sid)
	}
	return nil
}

// checkHostFile has nothing to check here: %LOCALAPPDATA% is the person's alone.
func checkHostFile(*os.File) error { return nil }
