//go:build linux

package desktopentry

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

const (
	appName    = "fredfleet"
	appComment = "Apache Iceberg catalog browser"
	fileName   = "fredfleet.desktop"
	iconName   = "icon.png"
)

// Skip self-install when the binary lives in a system-package location or
// is invoked through a packaged runtime that handles desktop integration
// itself (AppImage's appimaged, Flatpak, Snap, Nix profiles).
var systemPrefixes = []string{"/usr/", "/opt/", "/nix/store/"}
var packagedEnv = []string{"APPIMAGE", "FLATPAK_ID", "SNAP", "container"}

func ensure(_ context.Context, iconPNG []byte) {
	if err := install(iconPNG); err != nil {
		log.Printf("desktopentry: %v", err)
	}
}

func install(iconPNG []byte) error {
	for _, env := range packagedEnv {
		if os.Getenv(env) != "" {
			return nil
		}
	}

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("os.Executable: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return fmt.Errorf("eval symlinks: %w", err)
	}
	for _, prefix := range systemPrefixes {
		if strings.HasPrefix(exe, prefix) {
			return nil
		}
	}

	dataHome := xdgDataHome()
	iconPath := filepath.Join(dataHome, appName, iconName)
	desktopPath := filepath.Join(dataHome, "applications", fileName)

	if err := writeIfChanged(iconPath, iconPNG, 0o644); err != nil {
		return fmt.Errorf("write icon: %w", err)
	}
	desktop := buildDesktopEntry(exe, iconPath)
	if err := writeIfChanged(desktopPath, []byte(desktop), 0o644); err != nil {
		return fmt.Errorf("write .desktop: %w", err)
	}
	return nil
}

func buildDesktopEntry(exe, iconPath string) string {
	return strings.Join([]string{
		"[Desktop Entry]",
		"Type=Application",
		"Version=1.0",
		"Name=" + appName,
		"Comment=" + appComment,
		"Exec=" + quoteExec(exe),
		"Icon=" + iconPath,
		"Terminal=false",
		"Categories=Development;Database;",
		"Keywords=iceberg;catalog;data;lakehouse;",
		"StartupWMClass=" + appName,
		"StartupNotify=true",
		"",
	}, "\n")
}

// quoteExec follows the Desktop Entry spec quoting rules: only quote if
// the path contains whitespace; inside quotes, escape the double quote,
// backtick, dollar and backslash characters with a backslash.
func quoteExec(s string) string {
	if !strings.ContainsAny(s, " \t\n") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + 4)
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"', '`', '$', '\\':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	return b.String()
}

func writeIfChanged(path string, content []byte, mode os.FileMode) error {
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, content) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, content, mode)
}

func xdgDataHome() string {
	if dh := os.Getenv("XDG_DATA_HOME"); dh != "" {
		return dh
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".local", "share")
}
