package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeApp stands in for the desktop app's side of the socket: it writes
// clip-host.json, answers the token's challenge, then hands each connection
// to serve.
type fakeApp struct {
	t        *testing.T
	hostFile string
	token    []byte
	// Answer with this token's MACs instead, to act as an app without it.
	wrongToken []byte
	// Never answer the challenge.
	silent bool
	serve  func(conn net.Conn, caller string)
	done   sync.WaitGroup
	mu     sync.Mutex
	conns  []net.Conn
}

func newFakeApp(t *testing.T, serve func(conn net.Conn, caller string)) *fakeApp {
	t.Helper()
	token := make([]byte, 32)
	_, _ = rand.Read(token)
	return &fakeApp{t: t, hostFile: filepath.Join(t.TempDir(), "clip-host.json"), token: token, serve: serve}
}

// listen starts listening and writes clip-host.json, as the app does at launch.
func (a *fakeApp) listen() {
	a.t.Helper()
	listener, socket := listenFake(a.t)
	a.t.Cleanup(func() {
		listener.Close()
		a.mu.Lock()
		for _, conn := range a.conns {
			conn.Close()
		}
		a.mu.Unlock()
		a.done.Wait()
	})
	file, _ := json.Marshal(hostFile{V: 1, Socket: socket, Token: base64.StdEncoding.EncodeToString(a.token)})
	if err := os.WriteFile(a.hostFile, file, 0o600); err != nil {
		a.t.Fatal(err)
	}
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			a.mu.Lock()
			a.conns = append(a.conns, conn)
			a.mu.Unlock()
			a.done.Add(1)
			go func() {
				defer a.done.Done()
				defer conn.Close()
				if caller, ok := a.challenge(conn); ok {
					a.serve(conn, caller)
				}
			}()
		}
	}()
}

// challenge is the app's side of the handshake, written apart from the
// helper's so a mistake in one shows.
func (a *fakeApp) challenge(conn net.Conn) (string, bool) {
	var hello struct {
		V           int
		Type, Nonce string
	}
	if readMessage(conn, maxHandshake, &hello) != nil || hello.Type != "challenge" || hello.V != 1 {
		return "", false
	}
	if a.silent {
		_, _ = io.Copy(io.Discard, conn)
		return "", false
	}
	theirs, _ := base64.StdEncoding.DecodeString(hello.Nonce)
	ours := make([]byte, 32)
	_, _ = rand.Read(ours)
	token := a.token
	if a.wrongToken != nil {
		token = a.wrongToken
	}
	b64 := base64.StdEncoding.EncodeToString
	_ = writeMessage(conn, map[string]string{"type": "proof", "nonce": b64(ours), "mac": b64(proof(token, "app", theirs, ours))})
	var answer struct{ Type, Mac, Caller string }
	if readMessage(conn, maxHandshake, &answer) != nil || answer.Type != "proof" {
		return "", false
	}
	if answer.Mac != b64(proof(a.token, "helper", ours, theirs)) {
		a.t.Error("the helper's MAC is wrong")
		return "", false
	}
	return answer.Caller, true
}

// browser is the browser's side of one helper run.
type browser struct {
	t    *testing.T
	in   *io.PipeWriter
	out  *io.PipeReader
	done chan error
}

func runHost(t *testing.T, app *fakeApp, launch func() error, wait time.Duration) *browser {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	h := &host{
		in:       inR,
		out:      outW,
		caller:   "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
		connect:  func(caller string) (appConn, error) { return connectApp(app.hostFile, caller) },
		launch:   launch,
		wait:     wait,
		poll:     20 * time.Millisecond,
		relaunch: wait / 2,
	}
	b := &browser{t: t, in: inW, out: outR, done: make(chan error, 1)}
	go func() {
		err := h.run()
		outW.Close()
		b.done <- err
	}()
	t.Cleanup(func() { inW.Close() })
	return b
}

func (b *browser) send(message any) {
	b.t.Helper()
	if err := writeMessage(b.in, message); err != nil {
		b.t.Fatal(err)
	}
}

func (b *browser) receive() map[string]any {
	b.t.Helper()
	var got map[string]any
	if err := readMessage(b.out, maxToBrowser, &got); err != nil {
		b.t.Fatal(err)
	}
	return got
}

// ended waits for the helper to exit, and answers its error.
func (b *browser) ended() error {
	b.t.Helper()
	select {
	case err := <-b.done:
		return err
	case <-time.After(5 * time.Second):
		b.t.Fatal("the helper didn't exit")
		return nil
	}
}

// echo answers every frame with `{"type":"echo","got":…}`.
func echo(conn net.Conn, caller string) {
	for {
		var got map[string]any
		if readMessage(conn, maxFromBrowser, &got) != nil {
			return
		}
		got["caller"] = caller
		if writeMessage(conn, map[string]any{"type": "echo", "got": got}) != nil {
			return
		}
	}
}

func TestAnswersForAClosedApp(t *testing.T) {
	app := newFakeApp(t, echo)
	b := runHost(t, app, nil, time.Second)
	b.send(map[string]any{"v": 1, "id": "a", "type": "hello", "extension": "x"})
	got := b.receive()
	if got["type"] != "status" || got["app"] != "closed" || got["id"] != "a" || got["v"] != 1.0 {
		t.Fatalf("got %v", got)
	}
	// Anything else gets the same, and an ID that isn't a short string isn't repeated.
	b.send(map[string]any{"v": 1, "id": map[string]int{"x": 1}, "type": "folders"})
	if got := b.receive(); got["app"] != "closed" || got["id"] != nil {
		t.Fatalf("got %v", got)
	}
	b.in.Close()
	if err := b.ended(); err != nil {
		t.Fatal(err)
	}
}

func TestRelaysToTheRunningApp(t *testing.T) {
	app := newFakeApp(t, echo)
	app.listen()
	b := runHost(t, app, nil, time.Second)
	b.send(map[string]any{"v": 1, "id": "a", "type": "hello"})
	got := b.receive()
	inner, _ := got["got"].(map[string]any)
	if got["type"] != "echo" || inner["id"] != "a" || inner["caller"] != "chrome-extension://abcdefghijklmnopabcdefghijklmnop/" {
		t.Fatalf("got %v", got)
	}
	b.in.Close()
	if err := b.ended(); err != nil {
		t.Fatal(err)
	}
}

func TestReachesAnAppOpenedLater(t *testing.T) {
	app := newFakeApp(t, echo)
	b := runHost(t, app, nil, time.Second)
	b.send(map[string]any{"v": 1, "id": "a", "type": "hello"})
	if got := b.receive(); got["app"] != "closed" {
		t.Fatalf("got %v", got)
	}
	app.listen()
	b.send(map[string]any{"v": 1, "id": "b", "type": "hello"})
	if got := b.receive(); got["type"] != "echo" {
		t.Fatalf("got %v", got)
	}
}

// The browser's frames reach the app as they were sent, byte for byte,
// even near the largest the browser sends.
func TestCopiesFramesUnchanged(t *testing.T) {
	received := make(chan []byte, 1)
	app := newFakeApp(t, func(conn net.Conn, _ string) {
		frame, err := readFrame(conn, maxFromBrowser)
		if err != nil {
			t.Error(err)
			return
		}
		received <- frame
		_ = writeMessage(conn, map[string]any{"type": "status", "app": "ready", "pad": strings.Repeat("x", 1000)})
	})
	app.listen()
	b := runHost(t, app, nil, time.Second)
	body := []byte(`{"v":1,"id":"big","type":"clip","html":"` + strings.Repeat("é ", 13<<20) + `"}`)
	frame, _ := frameOf(json.RawMessage(body))
	go func() { _, _ = b.in.Write(frame) }()
	back, err := readFrame(b.out, maxToBrowser)
	if err != nil {
		t.Fatal(err)
	}
	if got := <-received; !bytes.Equal(got, frame) {
		t.Fatalf("the app got %d bytes, not the %d sent", len(got), len(frame))
	}
	if len(back) < 1000 {
		t.Fatalf("got %d bytes back", len(back))
	}
}

// The app can send while the helper waits on the browser, and the other
// way round: on Windows a pipe read and written at once needs overlapped I/O.
func TestBothWaysAtOnce(t *testing.T) {
	app := newFakeApp(t, func(conn net.Conn, _ string) {
		// Unasked, before reading anything.
		if writeMessage(conn, map[string]any{"type": "status", "app": "ready"}) != nil {
			return
		}
		var got map[string]any
		if readMessage(conn, maxFromBrowser, &got) != nil {
			return
		}
		_ = writeMessage(conn, map[string]any{"type": "status", "id": got["id"], "app": "ready"})
	})
	app.listen()
	b := runHost(t, app, nil, time.Second)
	if got := b.receive(); got["app"] != "ready" || got["id"] != nil {
		t.Fatalf("got %v", got)
	}
	b.send(map[string]any{"v": 1, "id": "a", "type": "hello"})
	if got := b.receive(); got["id"] != "a" {
		t.Fatalf("got %v", got)
	}
}

func TestOpenStartsTheApp(t *testing.T) {
	app := newFakeApp(t, echo)
	started := 0
	b := runHost(t, app, func() error {
		started++
		// As the app does a little after it starts.
		time.AfterFunc(100*time.Millisecond, app.listen)
		return nil
	}, 5*time.Second)
	b.send(map[string]any{"v": 1, "id": "a", "type": "open"})
	if got := b.receive(); got["type"] != "status" || got["app"] != "starting" || got["id"] != "a" {
		t.Fatalf("got %v", got)
	}
	// Sent while it starts, held until it listens.
	b.send(map[string]any{"v": 1, "id": "b", "type": "hello"})
	first, second := b.receive(), b.receive()
	firstGot, _ := first["got"].(map[string]any)
	secondGot, _ := second["got"].(map[string]any)
	if firstGot["type"] != "open" || firstGot["id"] != "a" || secondGot["id"] != "b" {
		t.Fatalf("got %v then %v", first, second)
	}
	if started != 1 {
		t.Fatalf("started %d times", started)
	}
}

// An app still quitting swallows the first launch, which hands over to it.
func TestOpenStartsTheAppAgainOnce(t *testing.T) {
	app := newFakeApp(t, echo)
	started := 0
	b := runHost(t, app, func() error {
		started++
		if started == 2 {
			app.listen()
		}
		return nil
	}, 400*time.Millisecond)
	b.send(map[string]any{"v": 1, "id": "a", "type": "open"})
	if got := b.receive(); got["app"] != "starting" {
		t.Fatalf("got %v", got)
	}
	if got := b.receive(); got["type"] != "echo" {
		t.Fatalf("got %v", got)
	}
	if started != 2 {
		t.Fatalf("started %d times", started)
	}
}

func TestOpenWithoutALauncher(t *testing.T) {
	b := runHost(t, newFakeApp(t, echo), nil, time.Second)
	b.send(map[string]any{"v": 1, "id": "a", "type": "open"})
	if got := b.receive(); got["type"] != "error" || got["code"] != "failed" || got["id"] != "a" {
		t.Fatalf("got %v", got)
	}
}

func TestOpenGivesUp(t *testing.T) {
	b := runHost(t, newFakeApp(t, echo), func() error { return nil }, 200*time.Millisecond)
	b.send(map[string]any{"v": 1, "id": "a", "type": "open"})
	if got := b.receive(); got["app"] != "starting" {
		t.Fatalf("got %v", got)
	}
	b.send(map[string]any{"v": 1, "id": "b", "type": "hello"})
	if got := b.receive(); got["type"] != "error" || got["id"] != "a" {
		t.Fatalf("got %v", got)
	}
	if got := b.receive(); got["app"] != "closed" || got["id"] != "b" {
		t.Fatalf("got %v", got)
	}
	// Still answering, as a closed app.
	b.send(map[string]any{"v": 1, "id": "c", "type": "hello"})
	if got := b.receive(); got["app"] != "closed" {
		t.Fatalf("got %v", got)
	}
}

func TestOpenThatFailsToStart(t *testing.T) {
	b := runHost(t, newFakeApp(t, echo), func() error { return errors.New("no") }, time.Second)
	b.send(map[string]any{"v": 1, "id": "a", "type": "open"})
	b.receive()
	if got := b.receive(); got["type"] != "error" || got["id"] != "a" {
		t.Fatalf("got %v", got)
	}
}

// An app that can't answer with the token's MAC is no app: nothing crosses.
func TestRefusesAnAppWithoutTheToken(t *testing.T) {
	app := newFakeApp(t, func(net.Conn, string) { t.Error("served without the token") })
	app.wrongToken = make([]byte, 32)
	app.listen()
	if _, err := connectApp(app.hostFile, ""); !errors.Is(err, errNotApp) {
		t.Fatalf("got %v", err)
	}
	b := runHost(t, app, nil, time.Second)
	b.send(map[string]any{"v": 1, "id": "a", "type": "hello"})
	if got := b.receive(); got["app"] != "closed" {
		t.Fatalf("got %v", got)
	}
}

func TestGivesUpOnASilentApp(t *testing.T) {
	app := newFakeApp(t, echo)
	app.silent = true
	app.listen()
	start := time.Now()
	if _, err := connectApp(app.hostFile, ""); err == nil {
		t.Fatal("connected")
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("took %v", took)
	}
}

func TestExitsWhenTheAppGoes(t *testing.T) {
	app := newFakeApp(t, func(conn net.Conn, _ string) {
		var got map[string]any
		_ = readMessage(conn, maxFromBrowser, &got)
	})
	app.listen()
	b := runHost(t, app, nil, time.Second)
	b.send(map[string]any{"v": 1, "id": "a", "type": "hello"})
	if err := b.ended(); err != nil {
		t.Fatal(err)
	}
	if _, err := readFrame(b.out, maxToBrowser); !errors.Is(err, io.EOF) {
		t.Fatalf("got %v", err)
	}
}

func TestRefusesAnOversizedFrame(t *testing.T) {
	b := runHost(t, newFakeApp(t, echo), nil, time.Second)
	header := []byte{0, 0, 0, 0}
	header[0], header[3] = 0xff, 0xff
	go func() { _, _ = b.in.Write(header) }()
	if err := b.ended(); !errors.Is(err, errTooLarge) {
		t.Fatalf("got %v", err)
	}
}

func TestRefusesAHostFileOthersCanChange(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("%LOCALAPPDATA% is the person's alone")
	}
	app := newFakeApp(t, echo)
	app.listen()
	if err := os.Chmod(app.hostFile, 0o666); err != nil {
		t.Fatal(err)
	}
	if _, err := connectApp(app.hostFile, ""); err == nil {
		t.Fatal("connected")
	}
}

func TestRefusesAnotherPipeOrPath(t *testing.T) {
	for _, socket := range []string{"relative/socket", `\\otherpc\pipe\wikistow-clip-x`, `C:\file`} {
		if _, err := dialApp(socket); err == nil {
			t.Errorf("dialled %q", socket)
		}
	}
}

func TestCaller(t *testing.T) {
	cases := map[string][]string{
		"chrome-extension://abc/":                 {"chrome-extension://abc/"},
		"chrome-extension://def/":                 {"chrome-extension://def/", "--parent-window=5"},
		"web-clipper@wikistow.skint007.github.io": {"/path/to/manifest.json", "web-clipper@wikistow.skint007.github.io"},
		"": {},
	}
	for want, args := range cases {
		if got := callerOf(args); got != want {
			t.Errorf("callerOf(%q) = %q", args, got)
		}
	}
}
