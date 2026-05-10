package connections

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const (
	appDirName  = "fredfleet"
	storeFile   = "connections.json"
	fileVersion = 1
)

type fileFormat struct {
	Version     int          `json:"version"`
	Connections []Connection `json:"connections"`
}

type Store struct {
	path string
	mu   sync.Mutex
}

func NewStore() (*Store, error) {
	cfg, err := os.UserConfigDir()
	if err != nil {
		return nil, fmt.Errorf("locate user config dir: %w", err)
	}
	dir := filepath.Join(cfg, appDirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create config dir: %w", err)
	}
	return &Store{path: filepath.Join(dir, storeFile)}, nil
}

func (s *Store) List() ([]Connection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

func (s *Store) Save(c Connection) error {
	if c.Name == "" {
		return errors.New("connection name is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	conns, err := s.readLocked()
	if err != nil {
		return err
	}
	replaced := false
	for i, existing := range conns {
		if existing.Name == c.Name {
			conns[i] = c
			replaced = true
			break
		}
	}
	if !replaced {
		conns = append(conns, c)
	}
	return s.writeLocked(conns)
}

func (s *Store) Delete(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	conns, err := s.readLocked()
	if err != nil {
		return err
	}
	out := conns[:0]
	for _, c := range conns {
		if c.Name != name {
			out = append(out, c)
		}
	}
	return s.writeLocked(out)
}

func (s *Store) readLocked() ([]Connection, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return []Connection{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read connections: %w", err)
	}
	var f fileFormat
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("parse connections: %w", err)
	}
	if f.Connections == nil {
		return []Connection{}, nil
	}
	return f.Connections, nil
}

func (s *Store) writeLocked(conns []Connection) error {
	f := fileFormat{Version: fileVersion, Connections: conns}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return fmt.Errorf("encode connections: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write tmp file: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("replace connections file: %w", err)
	}
	return nil
}
