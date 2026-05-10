package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app, err := NewApp(appIcon)
	if err != nil {
		log.Fatalf("init app: %v", err)
	}

	err = wails.Run(&options.App{
		Title:  "fredfleet",
		Width:  1024,
		Height: 768,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup: app.startup,
		Bind: []any{
			app,
		},
		Linux: &linux.Options{
			ProgramName: "fredfleet",
		},
		Mac: &mac.Options{
			Appearance: mac.NSAppearanceNameAqua,
		},
		Windows: &windows.Options{
			Theme: windows.SystemDefault,
		},
	})

	if err != nil {
		log.Fatalf("wails run: %v", err)
	}
}
