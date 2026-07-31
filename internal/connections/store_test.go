package connections

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// newTestStore builds a Store over a temp file, bypassing NewStore so the test
// never touches the real user config dir.
func newTestStore(t *testing.T) *Store {
	t.Helper()
	return &Store{path: filepath.Join(t.TempDir(), storeFile)}
}

func conn(name string) Connection {
	return Connection{
		Name: name,
		Type: TypeREST,
		URL:  "https://catalog.example/api/catalog",
		Auth: Auth{Kind: AuthBearer},
	}
}

func TestListOnMissingFileIsEmptyNotError(t *testing.T) {
	s := newTestStore(t)
	got, err := s.List()
	if err != nil {
		t.Fatalf("List on missing file: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("want 0 connections, got %d", len(got))
	}
	if got == nil {
		t.Fatal("want a non-nil empty slice, got nil — it crosses the Wails boundary as JSON null")
	}
}

func TestSaveUpsertsByName(t *testing.T) {
	s := newTestStore(t)
	if err := s.Save(conn("prod")); err != nil {
		t.Fatalf("save: %v", err)
	}

	edited := conn("prod")
	edited.URL = "https://other.example/catalog"
	edited.Warehouse = "wh2"
	if err := s.Save(edited); err != nil {
		t.Fatalf("re-save: %v", err)
	}

	got, err := s.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("re-saving the same name must replace, not append: got %d entries", len(got))
	}
	if got[0].URL != edited.URL || got[0].Warehouse != "wh2" {
		t.Fatalf("edit did not land: %+v", got[0])
	}
}

func TestSaveRejectsEmptyName(t *testing.T) {
	s := newTestStore(t)
	if err := s.Save(Connection{Type: TypeREST}); err == nil {
		t.Fatal("want an error for an unnamed connection, got nil")
	}
	if _, err := os.Stat(s.path); !os.IsNotExist(err) {
		t.Fatal("a rejected save must not create the store file")
	}
}

func TestSaveOrderIsStable(t *testing.T) {
	s := newTestStore(t)
	for _, n := range []string{"a", "b", "c"} {
		if err := s.Save(conn(n)); err != nil {
			t.Fatalf("save %s: %v", n, err)
		}
	}
	// Editing the middle entry must not reorder the list under the picker.
	edited := conn("b")
	edited.Warehouse = "wh"
	if err := s.Save(edited); err != nil {
		t.Fatalf("save b: %v", err)
	}

	got, err := s.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	want := []string{"a", "b", "c"}
	if len(got) != len(want) {
		t.Fatalf("want %d connections, got %d", len(want), len(got))
	}
	for i, name := range want {
		if got[i].Name != name {
			t.Fatalf("order changed at %d: want %q, got %q", i, name, got[i].Name)
		}
	}
}

func TestDelete(t *testing.T) {
	s := newTestStore(t)
	for _, n := range []string{"a", "b"} {
		if err := s.Save(conn(n)); err != nil {
			t.Fatalf("save %s: %v", n, err)
		}
	}
	if err := s.Delete("a"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got, err := s.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 || got[0].Name != "b" {
		t.Fatalf("want only b left, got %+v", got)
	}

	// Deleting something that is not there is a no-op, not an error: the UI
	// fires Delete after a confirm dialog that may race a concurrent edit.
	if err := s.Delete("ghost"); err != nil {
		t.Fatalf("delete of unknown name: %v", err)
	}
	if got, err = s.List(); err != nil || len(got) != 1 {
		t.Fatalf("no-op delete changed the store: %+v (%v)", got, err)
	}
}

func TestWriteIsAtomicAndPrivate(t *testing.T) {
	s := newTestStore(t)
	if err := s.Save(conn("prod")); err != nil {
		t.Fatalf("save: %v", err)
	}

	fi, err := os.Stat(s.path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	// The file names a catalog and its client id; on a shared machine that is
	// nobody else's business.
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("want mode 0600, got %04o", perm)
	}
	if _, err := os.Stat(s.path + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("the temp file survived the rename")
	}

	data, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var f fileFormat
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("stored file is not valid JSON: %v", err)
	}
	if f.Version != fileVersion {
		t.Fatalf("want version %d, got %d", fileVersion, f.Version)
	}
}

// The whole point of splitting Store from Keyring is that no code path can
// serialize a secret. This asserts it at the only place secrets could leak.
func TestStoredFileNeverContainsSecrets(t *testing.T) {
	s := newTestStore(t)
	c := conn("prod")
	c.Auth = Auth{
		Kind:     AuthOAuth2,
		AuthURL:  "https://keycloak.example/realms/x/protocol/openid-connect/token",
		ClientID: "fredfleet",
		Scope:    "lakekeeper",
	}
	c.S3 = &S3{AccessKeyID: "AKIAEXAMPLE", Region: "eu-central-1"}
	if err := s.Save(c); err != nil {
		t.Fatalf("save: %v", err)
	}

	data, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("parse: %v", err)
	}
	// Key names, not values: "authUrl" legitimately holds a URL ending in
	// /token. What must never appear is a *field* that could carry a secret.
	for _, key := range jsonKeys(decoded) {
		lower := strings.ToLower(key)
		for _, banned := range []string{"secret", "password", "passwd", "credential", "token"} {
			if strings.Contains(lower, banned) {
				t.Fatalf("stored file carries field %q — secrets belong in the keyring, not connections.json", key)
			}
		}
	}
}

// jsonKeys collects every object key in a decoded JSON document, at any depth.
func jsonKeys(v any) []string {
	switch t := v.(type) {
	case map[string]any:
		var out []string
		for k, child := range t {
			out = append(out, k)
			out = append(out, jsonKeys(child)...)
		}
		return out
	case []any:
		var out []string
		for _, child := range t {
			out = append(out, jsonKeys(child)...)
		}
		return out
	default:
		return nil
	}
}

func TestReadRejectsCorruptFile(t *testing.T) {
	s := newTestStore(t)
	if err := os.WriteFile(s.path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := s.List(); err == nil {
		t.Fatal("want a parse error for a corrupt store, got nil")
	}
	// A corrupt file must not be silently overwritten with an empty list —
	// Save reads before it writes, so it surfaces the same error.
	if err := s.Save(conn("prod")); err == nil {
		t.Fatal("want Save to refuse to clobber an unreadable store")
	}
}

// Runs under -race in CI; the mutex is the only thing keeping two Wails calls
// from interleaving a read-modify-write.
func TestConcurrentSavesDoNotLoseEntries(t *testing.T) {
	s := newTestStore(t)
	const n = 16

	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := s.Save(conn(string(rune('a' + i)))); err != nil {
				t.Errorf("save %d: %v", i, err)
			}
		}(i)
	}
	wg.Wait()

	got, err := s.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != n {
		t.Fatalf("want %d connections after %d concurrent saves, got %d", n, n, len(got))
	}
}
