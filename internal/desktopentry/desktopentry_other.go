//go:build !linux

package desktopentry

import "context"

func ensure(ctx context.Context, iconPNG []byte) {}
