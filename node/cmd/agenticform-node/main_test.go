package main

import "testing"

func TestRequireSecureServerURL(t *testing.T) {
	for _, value := range []string{"https://agenticform.example.com", "http://localhost:8080", "http://127.0.0.1:8080"} {
		if err := requireSecureServerURL(value); err != nil {
			t.Fatalf("expected %q to be accepted: %v", value, err)
		}
	}
	for _, value := range []string{"http://agenticform.example.com", "ftp://agenticform.example.com", "not-a-url"} {
		if err := requireSecureServerURL(value); err == nil {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
}

func TestValidateRepositoryURL(t *testing.T) {
	if err := validateRepositoryURL("https://github.com/raufimusaddiq/agenticform.git"); err != nil {
		t.Fatalf("expected public HTTPS repository to pass: %v", err)
	}
	for _, value := range []string{
		"http://github.com/raufimusaddiq/agenticform.git",
		"https://token@github.com/raufimusaddiq/agenticform.git",
		"https://github.com/raufimusaddiq/agenticform.git?token=secret",
		"ssh://git@github.com/raufimusaddiq/agenticform.git",
	} {
		if err := validateRepositoryURL(value); err == nil {
			t.Fatalf("expected credential/insecure repository %q to be rejected", value)
		}
	}
}

func TestSafeSegmentStripsPathTraversalCharacters(t *testing.T) {
	got := safeSegment("../../agent / reviewer")
	if got == "" || got == "../.." || got == "../../agent/reviewer" {
		t.Fatalf("unexpected safe segment %q", got)
	}
	for _, forbidden := range []string{"/", "\\"} {
		for _, r := range got {
			if string(r) == forbidden {
				t.Fatalf("safe segment contains path separator: %q", got)
			}
		}
	}
}
