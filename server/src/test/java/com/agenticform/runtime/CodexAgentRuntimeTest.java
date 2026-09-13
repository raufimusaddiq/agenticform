package com.agenticform.runtime;

import com.agenticform.agent.AgentCapabilityProfile;
import com.agenticform.codex.CodexGateway;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CodexAgentRuntimeTest {
    @Test
    void adaptsCodexSessionAndDispatchToNeutralContract() {
        CodexGateway gateway = mock(CodexGateway.class);
        when(gateway.startThread("/work", "review", AgentCapabilityProfile.REVIEWER))
                .thenReturn(new CodexGateway.ThreadHandle("thread-1"));
        when(gateway.dispatchTask("thread-1", "message-1", "inspect"))
                .thenReturn(new CodexGateway.DispatchReceipt("queue-1", "turn-1"));

        AgentRuntime runtime = new CodexAgentRuntime(gateway);
        RuntimeSession session = runtime.start("/work", "review", AgentCapabilityProfile.REVIEWER);
        RuntimeDispatchReceipt receipt = runtime.dispatch(session, "message-1", "inspect");

        assertEquals(RuntimeType.CODEX, runtime.type());
        assertEquals("thread-1", session.id());
        assertEquals("queue-1", receipt.queuedSubmissionId());
        assertEquals("turn-1", receipt.turnId());
        verify(gateway).dispatchTask("thread-1", "message-1", "inspect");
    }
}
