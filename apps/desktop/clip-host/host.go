package main

import (
	"encoding/json"
	"errors"
	"io"
	"time"
)

// How long `open` waits for the app it started to listen (ADR 0017, decision 1).
const appWait = 60 * time.Second

// When `open` starts the app again, once, if it isn't listening yet: an app
// still quitting holds the single-instance lock for a few seconds, and the
// launch that met it handed over and quit.
const relaunchAfter = 10 * time.Second

// host is one run of the helper, from the browser's connection to its end.
type host struct {
	// The browser's side.
	in  io.Reader
	out io.Writer
	// The extension that started the helper (callerOf).
	caller string
	// Reach the running app, or fail when it isn't.
	connect func(caller string) (appConn, error)
	// Start the app outside the browser's reach; nil when this copy can't,
	// as a development build, which has no launcher, can't.
	launch func() error
	// How long to wait for a started app, how often to look, and when to
	// start it again.
	wait, poll, relaunch time.Duration
}

// run relays until either side goes. The browser closing its end is the
// usual way out, with nil.
func (h *host) run() error {
	frames := make(chan []byte)
	failed := make(chan error, 1)
	go func() {
		defer close(frames)
		for {
			frame, err := readFrame(h.in, maxFromBrowser)
			if err != nil {
				if !errors.Is(err, io.EOF) {
					failed <- err
				}
				return
			}
			frames <- frame
		}
	}()
	// The app may be running already, or open between messages.
	if conn, err := h.connect(h.caller); err == nil {
		return h.relay(conn, frames, failed, nil)
	}
	for {
		frame, ok := <-frames
		if !ok {
			return readError(failed)
		}
		if conn, err := h.connect(h.caller); err == nil {
			return h.relay(conn, frames, failed, [][]byte{frame})
		}
		message := envelopeOf(frame)
		if message.Type != "open" {
			// Whatever was asked, the answer is that the app is closed.
			if err := h.answer(message.ID, "status", map[string]any{"app": "closed"}); err != nil {
				return err
			}
			continue
		}
		conn, queued, err := h.start(message, frame, frames)
		if err != nil {
			return err
		}
		if conn != nil {
			return h.relay(conn, frames, failed, queued)
		}
		if queued == nil {
			return readError(failed)
		}
	}
}

// start opens the app for `open` and waits for it to listen, holding what
// the browser sends meanwhile. It answers `starting` first. With the app
// reached, it hands back the connection and the frames to send it, the
// `open` first, which the app answers with its state from then on. When the
// app can't be started or doesn't listen in time, it says so to each held
// message and hands back no connection. Queued is nil when the browser went.
func (h *host) start(open envelope, frame []byte, frames <-chan []byte) (appConn, [][]byte, error) {
	if h.launch == nil {
		return nil, [][]byte{}, h.failed(open.ID, "Open WikiStow, then try again.")
	}
	if err := h.answer(open.ID, "status", map[string]any{"app": "starting"}); err != nil {
		return nil, nil, err
	}
	if err := h.launch(); err != nil {
		return nil, [][]byte{}, h.failed(open.ID, "Couldn’t open WikiStow. Open it yourself, then try again.")
	}
	queued := [][]byte{frame}
	deadline := time.NewTimer(h.wait)
	defer deadline.Stop()
	tick := time.NewTicker(h.poll)
	defer tick.Stop()
	again := time.NewTimer(h.relaunch)
	defer again.Stop()
	for {
		select {
		case <-again.C:
			_ = h.launch()
		case next, ok := <-frames:
			if !ok {
				return nil, nil, nil
			}
			queued = append(queued, next)
		case <-tick.C:
			if conn, err := h.connect(h.caller); err == nil {
				return conn, queued, nil
			}
		case <-deadline.C:
			// The `open` failed; the rest get what a closed app's do.
			if err := h.failed(open.ID, "WikiStow didn’t open in time."); err != nil {
				return nil, nil, err
			}
			for _, held := range queued[1:] {
				err := h.answer(envelopeOf(held).ID, "status", map[string]any{"app": "closed"})
				if err != nil {
					return nil, nil, err
				}
			}
			return nil, [][]byte{}, nil
		}
	}
}

// relay sends the held frames, then copies frames both ways, unread, until
// either side goes. It reads the app before writing to it: a pipe may hold
// nothing, as go-winio's doesn't, so a write waits for the app to read,
// and the app may be writing an answer meanwhile.
func (h *host) relay(conn appConn, frames <-chan []byte, failed <-chan error, held [][]byte) error {
	defer conn.Close()
	gone := make(chan error, 1)
	go func() {
		_, err := io.Copy(h.out, conn)
		gone <- err
	}()
	for _, frame := range held {
		if _, err := conn.Write(frame); err != nil {
			return err
		}
	}
	for {
		select {
		case frame, ok := <-frames:
			// The browser went: closing the connection tells the app.
			if !ok {
				return readError(failed)
			}
			if _, err := conn.Write(frame); err != nil {
				return err
			}
		// The app went, so the helper goes too, which ends the browser's port.
		case err := <-gone:
			return err
		}
	}
}

func readError(failed <-chan error) error {
	select {
	case err := <-failed:
		return err
	default:
		return nil
	}
}

// What the helper reads of a message, only while the app is closed.
type envelope struct {
	ID   json.RawMessage `json:"id"`
	Type string          `json:"type"`
}

func envelopeOf(frame []byte) envelope {
	var found envelope
	_ = json.Unmarshal(frame[4:], &found)
	// The answer repeats a string ID, never anything else.
	var id string
	if json.Unmarshal(found.ID, &id) != nil || len(id) > 100 {
		found.ID = nil
	}
	return found
}

// answer writes a message of the helper's own, as the app would answer it.
func (h *host) answer(id json.RawMessage, kind string, fields map[string]any) error {
	message := map[string]any{"v": 1, "type": kind}
	if id != nil {
		message["id"] = id
	}
	for name, value := range fields {
		message[name] = value
	}
	return writeMessage(h.out, message)
}

func (h *host) failed(id json.RawMessage, message string) error {
	return h.answer(id, "error", map[string]any{"code": "failed", "message": message})
}
