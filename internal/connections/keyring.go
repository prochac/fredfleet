package connections

import (
	"errors"
	"fmt"

	"github.com/zalando/go-keyring"
)

const keyringService = "fredfleet"

type Keyring struct{}

func NewKeyring() *Keyring { return &Keyring{} }

func (Keyring) Set(name, token string) error {
	if err := keyring.Set(keyringService, name, token); err != nil {
		return fmt.Errorf("store token in keyring: %w", err)
	}
	return nil
}

func (Keyring) Get(name string) (string, error) {
	tok, err := keyring.Get(keyringService, name)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read token from keyring: %w", err)
	}
	return tok, nil
}

func (Keyring) Delete(name string) error {
	err := keyring.Delete(keyringService, name)
	if err == nil || errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return fmt.Errorf("delete token from keyring: %w", err)
}
