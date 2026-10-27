package config

import (
	"os"
	"path/filepath"
)

type Config struct {
	Port            string
	DataDir         string
	DBPath          string
	InitialPassword string
	PublicBaseUrl   string
	Version         string
}

func Load() *Config {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			home = "/root"
		}
		// Default to shared xrouter data directory if present
		candidate := filepath.Join(home, "xrouter-remake", "data")
		if _, err := os.Stat(candidate); err == nil {
			dataDir = candidate
		} else {
			dataDir = filepath.Join(home, ".xrouter", "data")
		}
	}

	dbPath := filepath.Join(dataDir, "db", "data.sqlite")

	initialPassword := os.Getenv("INITIAL_PASSWORD")
	if initialPassword == "" {
		initialPassword = "xrouter123"
	}

	publicBaseUrl := os.Getenv("PUBLIC_BASE_URL")
	if publicBaseUrl == "" {
		publicBaseUrl = os.Getenv("BASE_URL")
	}

	return &Config{
		Port:            port,
		DataDir:         dataDir,
		DBPath:          dbPath,
		InitialPassword: initialPassword,
		PublicBaseUrl:   publicBaseUrl,
		Version:         "0.0.3",
	}
}
