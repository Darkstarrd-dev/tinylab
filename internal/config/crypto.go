package config

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
)

func GenerateKey() (string, error) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(key), nil
}

func Encrypt(keyBase64, plaintext string) (string, error) {
	key, err := base64.StdEncoding.DecodeString(keyBase64)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

func Decrypt(keyBase64, ciphertextBase64 string) (string, error) {
	key, err := base64.StdEncoding.DecodeString(keyBase64)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	data, err := base64.StdEncoding.DecodeString(ciphertextBase64)
	if err != nil {
		return "", err
	}
	if len(data) < gcm.NonceSize() {
		return "", errors.New("ciphertext too short")
	}
	nonce := data[:gcm.NonceSize()]
	ciphertext := data[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

// encryptKeysCopy returns a deep copy of cfg with all API key values encrypted.
// The original cfg is not modified — in-memory keys stay plaintext.
// Encrypted keys are prefixed with "enc:" so Load can distinguish them.
// If any key cannot be encrypted (e.g. a corrupt EncryptionKey), an error is
// returned so Save fails instead of silently writing plaintext keys to disk.
func encryptKeysCopy(cfg *Config) (*Config, error) {
	cp := *cfg
	cp.Providers = make([]Provider, len(cfg.Providers))
	for i := range cfg.Providers {
		cp.Providers[i] = cfg.Providers[i]
		cp.Providers[i].Keys = make([]Key, len(cfg.Providers[i].Keys))
		for j := range cfg.Providers[i].Keys {
			cp.Providers[i].Keys[j] = cfg.Providers[i].Keys[j]
			k := &cp.Providers[i].Keys[j]
			if k.Key != "" && !strings.HasPrefix(k.Key, "enc:") {
				encrypted, err := Encrypt(cfg.Security.EncryptionKey, k.Key)
				if err != nil {
					return nil, fmt.Errorf("encrypt key %s/%s: %w", cfg.Providers[i].ID, k.ID, err)
				}
				k.Key = "enc:" + encrypted
			}
		}
	}
	return &cp, nil
}
