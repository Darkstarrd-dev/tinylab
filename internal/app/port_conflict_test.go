package app

import (
	"errors"
	"fmt"
	"syscall"
	"testing"
)

func TestIsAddrInUse(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "nil error",
			err:  nil,
			want: false,
		},
		{
			name: "syscall.EADDRINUSE",
			err:  syscall.EADDRINUSE,
			want: true,
		},
		{
			name: "wrapped EADDRINUSE",
			err:  errors.New("bind: address already in use"),
			want: true,
		},
		{
			name: "windows style",
			err:  errors.New("Only one usage of each socket address is normally permitted"),
			want: true,
		},
		{
			name: "unrelated error",
			err:  errors.New("permission denied"),
			want: false,
		},
		{
			name: "connection refused",
			err:  errors.New("connection refused"),
			want: false,
		},
		{
			name: "wrapped syscall.EADDRINUSE with %w",
			err:  fmt.Errorf("listen tcp :20128: %w", syscall.EADDRINUSE),
			want: true,
		},
		{
			name: "mixed case address in use",
			err:  errors.New("Address Already In Use"),
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isAddrInUse(tt.err)
			if got != tt.want {
				t.Errorf("isAddrInUse(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}
