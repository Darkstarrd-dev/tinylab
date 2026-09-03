package registry

import (
	"testing"

	"github.com/tinylab/tinylab/internal/config"
)

func TestUpdateModelProtocols_Success(t *testing.T) {
	r := New(crudTestConfig())
	protocols := []string{config.ProtocolOpenAICompat, config.ProtocolAnthropic}
	if err := r.UpdateModelProtocols("p1", "m1", protocols); err != nil {
		t.Fatalf("UpdateModelProtocols returned error: %v", err)
	}
	m, ok := r.GetModelByAliasOrID("p1", "m1")
	if !ok {
		t.Fatal("model m1 not found")
	}
	if len(m.Protocols) != 2 {
		t.Fatalf("Protocols len = %d, want 2", len(m.Protocols))
	}
	if m.Protocols[0] != config.ProtocolOpenAICompat || m.Protocols[1] != config.ProtocolAnthropic {
		t.Errorf("Protocols = %v, want %v", m.Protocols, protocols)
	}
}

func TestUpdateModelProtocols_ProviderNotFound(t *testing.T) {
	r := New(crudTestConfig())
	err := r.UpdateModelProtocols("ghost", "m1", []string{config.ProtocolOpenAICompat})
	if err == nil {
		t.Fatal("expected error for missing provider, got nil")
	}
}

func TestUpdateModelProtocols_ModelNotFound(t *testing.T) {
	r := New(crudTestConfig())
	err := r.UpdateModelProtocols("p1", "ghost", []string{config.ProtocolOpenAICompat})
	if err == nil {
		t.Fatal("expected error for missing model, got nil")
	}
}

func TestUpdateModelProtocols_EmptyProtocols(t *testing.T) {
	r := New(crudTestConfig())
	// Set then clear.
	if err := r.UpdateModelProtocols("p1", "m1", []string{config.ProtocolOpenAICompat}); err != nil {
		t.Fatalf("first update error: %v", err)
	}
	if err := r.UpdateModelProtocols("p1", "m1", []string{}); err != nil {
		t.Fatalf("clear update error: %v", err)
	}
	m, ok := r.GetModelByAliasOrID("p1", "m1")
	if !ok {
		t.Fatal("model m1 not found")
	}
	if len(m.Protocols) != 0 {
		t.Fatalf("Protocols len = %d, want 0 after clear", len(m.Protocols))
	}
}
