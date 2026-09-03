package main

//go:generate rsrc -ico web/static/favicon.ico -manifest rsrc.manifest -o rsrc.syso

import (
	"flag"
	"log"
	"path/filepath"

	"github.com/tinylab/tinylab/internal/app"
)

func main() {
	configPath := flag.String("config", "config.yaml", "path to config file")
	flag.Parse()

	configDir := filepath.Dir(*configPath)

	a, err := app.New(*configPath)
	if err != nil {
		app.FeedbackFatalError(configDir, err.Error())
		log.Fatalf("%v", err)
	}
	if err := a.Run(runHostLoop); err != nil {
		log.Fatalf("run error: %v", err)
	}
}
