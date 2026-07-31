package connections

import (
	"errors"
	"testing"

	"github.com/zalando/go-keyring"
)

// go-keyring's mock backend swaps the OS provider for an in-memory map, so
// these run in CI with no DBus/Secret Service, Keychain or WinCred present.
func mockKeyring(t *testing.T) *Keyring {
	t.Helper()
	keyring.MockInit()
	return NewKeyring()
}

func TestKeyringRoundTrip(t *testing.T) {
	k := mockKeyring(t)
	if err := k.Set("prod", "s3cr3t"); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, err := k.Get("prod")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got != "s3cr3t" {
		t.Fatalf("want %q, got %q", "s3cr3t", got)
	}
}

// A connection saved before the keyring entry exists (or after the user wiped
// it) must read back as empty rather than as an error — App.resolveSecret
// treats "" as "no secret configured" and lets the probe fail with a catalog
// message instead of a keyring one.
func TestKeyringGetMissingIsEmptyNotError(t *testing.T) {
	k := mockKeyring(t)
	got, err := k.Get("never-saved")
	if err != nil {
		t.Fatalf("want nil error for a missing entry, got %v", err)
	}
	if got != "" {
		t.Fatalf("want empty string, got %q", got)
	}
}

func TestKeyringDeleteIsIdempotent(t *testing.T) {
	k := mockKeyring(t)
	if err := k.Set("prod", "s3cr3t"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if err := k.Delete("prod"); err != nil {
		t.Fatalf("first delete: %v", err)
	}
	// DeleteConnection calls Delete and DeleteS3 unconditionally, so a
	// connection that never had an S3 secret must not log a spurious failure.
	if err := k.Delete("prod"); err != nil {
		t.Fatalf("second delete must be a no-op, got %v", err)
	}
	if got, err := k.Get("prod"); err != nil || got != "" {
		t.Fatalf("want the entry gone, got %q (%v)", got, err)
	}
}

// The S3 secret hangs off the same account name with a ":s3" suffix. If the
// suffix ever collided, saving S3 credentials would silently overwrite the
// catalog bearer token.
func TestS3SecretIsStoredSeparately(t *testing.T) {
	k := mockKeyring(t)
	if err := k.Set("prod", "catalog-token"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if err := k.SetS3("prod", "s3-key"); err != nil {
		t.Fatalf("set s3: %v", err)
	}

	auth, err := k.Get("prod")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	s3, err := k.GetS3("prod")
	if err != nil {
		t.Fatalf("get s3: %v", err)
	}
	if auth != "catalog-token" {
		t.Fatalf("the S3 write clobbered the catalog secret: %q", auth)
	}
	if s3 != "s3-key" {
		t.Fatalf("want %q, got %q", "s3-key", s3)
	}

	// Dropping one must leave the other alone.
	if err := k.DeleteS3("prod"); err != nil {
		t.Fatalf("delete s3: %v", err)
	}
	if auth, err = k.Get("prod"); err != nil || auth != "catalog-token" {
		t.Fatalf("deleting the S3 secret took the catalog secret with it: %q (%v)", auth, err)
	}
}

// A backend that is present but broken (locked keychain, no Secret Service on
// a headless box) must surface as an error, not as an empty secret that would
// send an unauthenticated request to the catalog.
func TestKeyringBackendErrorIsNotSwallowed(t *testing.T) {
	boom := errors.New("keyring is locked")
	keyring.MockInitWithError(boom)
	t.Cleanup(keyring.MockInit)

	k := NewKeyring()
	if _, err := k.Get("prod"); err == nil {
		t.Fatal("want the backend error surfaced, got nil")
	} else if !errors.Is(err, boom) {
		t.Fatalf("want the backend error wrapped, got %v", err)
	}
}
