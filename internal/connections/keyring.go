package connections

import (
	"errors"
	"fmt"

	"github.com/zalando/go-keyring"
)

const (
	keyringService = "fredfleet"
	s3Suffix       = ":s3"
)

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

// SetS3, GetS3, DeleteS3 manage the optional explicit S3 secret access key,
// stored under "<name>:s3" so it never collides with the catalog auth secret.
func (k Keyring) SetS3(name, secret string) error    { return k.Set(name+s3Suffix, secret) }
func (k Keyring) GetS3(name string) (string, error)  { return k.Get(name + s3Suffix) }
func (k Keyring) DeleteS3(name string) error         { return k.Delete(name + s3Suffix) }
