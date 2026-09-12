package com.agenticform.codex;

import com.agenticform.agent.AgentCapabilityProfile;

public interface CodexGateway {
    ThreadHandle startThread(String cwd, String responsibility);

    default ThreadHandle startThread(String cwd, String responsibility, AgentCapabilityProfile capabilityProfile) {
        return startThread(cwd, responsibility);
    }

    DispatchReceipt dispatchTask(String threadId, String clientMessageId, String prompt);
    void resumeThread(String threadId);
    void interruptTurn(String threadId, String turnId);

    record ThreadHandle(String threadId) {}
    record DispatchReceipt(String queuedSubmissionId, String turnId) {}
}
