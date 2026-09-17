package main

import "testing"

func TestShouldForwardNotificationIncludesAssistantDeltas(t *testing.T) {
	for _, method := range []string{"item/started", "item/agentMessage/delta", "item/completed", "rawResponseItem/completed", "turn/completed"} {
		if !shouldForwardNotification(method) {
			t.Fatalf("expected %s to be forwarded", method)
		}
	}
	if shouldForwardNotification("turn/failed") {
		t.Fatal("unexpected method forwarded")
	}
}
