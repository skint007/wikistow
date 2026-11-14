package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// The browser's framing, which the app's socket uses too: a message's length
// as a 32-bit unsigned integer in the computer's own byte order, then that
// many bytes of UTF-8 JSON.
const (
	// The most Chrome sends a host; the extension refuses a larger clip
	// before sending it (ADR 0017, decision 4).
	maxFromBrowser = 64 << 20
	// The most the browser takes from a host.
	maxToBrowser = 1 << 20
	// The token's challenge is a few short fields.
	maxHandshake = 1 << 10
)

var errTooLarge = errors.New("message too large")

// readFrame reads one whole frame, header included, of at most max bytes
// of message.
func readFrame(r io.Reader, max uint32) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	size := binary.NativeEndian.Uint32(header[:])
	if size > max {
		return nil, fmt.Errorf("%w: %d bytes", errTooLarge, size)
	}
	frame := make([]byte, 4+int(size))
	copy(frame, header[:])
	if _, err := io.ReadFull(r, frame[4:]); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	return frame, nil
}

// frameOf frames a message for writing.
func frameOf(message any) ([]byte, error) {
	body, err := json.Marshal(message)
	if err != nil {
		return nil, err
	}
	frame := make([]byte, 4, 4+len(body))
	binary.NativeEndian.PutUint32(frame, uint32(len(body)))
	return append(frame, body...), nil
}

func writeMessage(w io.Writer, message any) error {
	frame, err := frameOf(message)
	if err != nil {
		return err
	}
	_, err = w.Write(frame)
	return err
}

// readMessage reads one frame of at most max bytes into v.
func readMessage(r io.Reader, max uint32, v any) error {
	frame, err := readFrame(r, max)
	if err != nil {
		return err
	}
	return json.Unmarshal(frame[4:], v)
}
