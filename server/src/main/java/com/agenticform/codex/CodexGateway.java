package com.agenticform.codex;

public interface CodexGateway {
    ThreadHandle startThread(String cwd, String responsibility);
    DispatchReceipt dispatchTask(String threadId, String clientMessageId, String prompt);
    void resumeThread(String threadId);
    void interruptTurn(String threadId, String turnId);

    record ThreadHandle(String threadId) {}
    record DispatchReceipt(String queuedSubmissionId, String turnId) {}
}
