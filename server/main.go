// Command kandev-plugin-apprise-templates formats notification text over gRPC.
package main

import (
	"github.com/kdlbs/kandev/pluginsdk"
	"log"
	"os"
)

func main() {
	if (len(os.Args) == 3 || len(os.Args) == 4) && os.Args[1] == "--verify-offline-store" {
		if err := verifyOfflineStore(os.Args[2]); err != nil {
			log.Fatal("offline template configuration validation failed")
		}
		if len(os.Args) == 4 {
			if err := verifyBackupInstallation(os.Args[3]); err != nil {
				log.Fatal("offline installation reference validation failed")
			}
		}
		return
	}
	directory := os.Getenv("KANDEV_PLUGIN_DATA_DIR")
	if directory == "" {
		log.Fatal("plugin data directory is required")
	}
	store, err := OpenSnapshotStore(directory)
	if err != nil {
		log.Fatal("template storage unavailable")
	}
	defer func() { _ = store.Close() }()
	pluginsdk.Serve(&formatterPlugin{store: store})
}
