// Package desktopentry self-installs an XDG desktop entry on Linux so that
// app launchers, taskbars and (crucially) Wayland compositors can resolve
// the window icon via StartupWMClass. No-op on macOS and Windows.
package desktopentry

import "context"

// Ensure writes ~/.local/share/applications/fredfleet.desktop and the
// embedded icon to the user-scope XDG data dirs, if missing or stale.
// Safe to call from a goroutine — it logs and returns rather than erroring.
//
// On non-Linux it does nothing.
func Ensure(ctx context.Context, iconPNG []byte) {
	ensure(ctx, iconPNG)
}
