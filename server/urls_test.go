package main

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestDestinationValidationAndEncoding(t *testing.T) {
	for _, origin := range []string{"https://example.invalid:0", "https://example.invalid:65536", "https://example.invalid:", "https://example.invalid/%2f", "https://example.invalid?", "https://user:password@example.invalid", "http://example.invalid"} {
		require.Error(t, ValidateOrigin(origin), origin)
	}
	require.NoError(t, ValidateOrigin("http://LOCALHOST:1234/"))
	require.Equal(t, "https://example.invalid/t/a%2Fb?sessionId=s+%2B%26%2F%3F%23%25", sessionURL("https://example.invalid/", "a/b", "s +&/?#%"))
	require.Empty(t, releaseURL("https://example.invalid/a b"))
}
