package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"time"
)

// How long the app has to answer the token's challenge (ADR 0017, decision 1).
const handshakeTime = time.Second

// What the running app writes beside its data once it listens, readable by
// the person alone, and deletes when it quits (apps/desktop/src/clip).
type hostFile struct {
	V      int    `json:"v"`
	Socket string `json:"socket"`
	Token  string `json:"token"`
}

// appConn is the connection to the app once it has proved itself.
type appConn = net.Conn

var errNotApp = errors.New("the app didn't prove it holds the token")

// connectApp reads clip-host.json at path, connects to the socket or pipe it
// names, checks who serves it, and runs the token's challenge. It fails
// when the app isn't running, and when anything doesn't check out.
func connectApp(path, caller string) (appConn, error) {
	found, err := readHostFile(path)
	if err != nil {
		return nil, err
	}
	conn, err := dialApp(found.Socket)
	if err != nil {
		return nil, err
	}
	if err := proven(conn, found.token(), caller); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

// proven runs the token's challenge on conn, within handshakeTime.
func proven(conn appConn, token []byte, caller string) error {
	if err := conn.SetDeadline(time.Now().Add(handshakeTime)); err != nil {
		return err
	}
	if err := handshake(conn, token, caller); err != nil {
		return err
	}
	return conn.SetDeadline(time.Time{})
}

func readHostFile(path string) (*hostFile, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if err := checkHostFile(file); err != nil {
		return nil, err
	}
	var found hostFile
	if err := json.NewDecoder(io.LimitReader(file, 4096)).Decode(&found); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if found.V != 1 || found.Socket == "" || len(found.token()) != 32 {
		return nil, fmt.Errorf("%s: not a clip host file this helper reads", path)
	}
	return &found, nil
}

func (f *hostFile) token() []byte {
	token, err := base64.StdEncoding.Strict().DecodeString(f.Token)
	if err != nil {
		return nil
	}
	return token
}

// The helper's side of the token's challenge. Each MAC names its role and
// both nonces, so an answer can't be replayed into another connection or
// bounced back as the other side's. Only then do frames cross.
//
//	helper → app  {"v":1,"type":"challenge","nonce":Nh}
//	app → helper  {"type":"proof","nonce":Na,"mac":HMAC(token, "app" ‖ Nh ‖ Na)}
//	helper → app  {"type":"proof","mac":HMAC(token, "helper" ‖ Na ‖ Nh),"caller":…}
func handshake(conn io.ReadWriter, token []byte, caller string) error {
	ours := make([]byte, 32)
	if _, err := rand.Read(ours); err != nil {
		return err
	}
	encode := base64.StdEncoding.EncodeToString
	err := writeMessage(conn, map[string]any{"v": 1, "type": "challenge", "nonce": encode(ours)})
	if err != nil {
		return err
	}
	var answer struct {
		Type  string `json:"type"`
		Nonce string `json:"nonce"`
		Mac   string `json:"mac"`
	}
	if err := readMessage(conn, maxHandshake, &answer); err != nil {
		return err
	}
	decode := base64.StdEncoding.Strict().DecodeString
	theirs, err := decode(answer.Nonce)
	if err != nil || len(theirs) != 32 || answer.Type != "proof" {
		return errNotApp
	}
	given, err := decode(answer.Mac)
	if err != nil || !hmac.Equal(given, proof(token, "app", ours, theirs)) {
		return errNotApp
	}
	return writeMessage(conn, map[string]any{
		"type":   "proof",
		"mac":    encode(proof(token, "helper", theirs, ours)),
		"caller": caller,
	})
}

// proof is HMAC-SHA256(token, role ‖ first ‖ second). The roles differ in
// length and the nonces are 32 bytes each, so no two inputs run together.
func proof(token []byte, role string, first, second []byte) []byte {
	mac := hmac.New(sha256.New, token)
	mac.Write([]byte(role))
	mac.Write(first)
	mac.Write(second)
	return mac.Sum(nil)
}
