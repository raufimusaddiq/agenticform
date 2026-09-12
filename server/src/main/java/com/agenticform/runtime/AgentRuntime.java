package com.agenticform.runtime;

import com.agenticform.agent.AgentCapabilityProfile;

import java.util.Map;

public interface AgentRuntime {
    RuntimeType type();

    Map<String, Object> startParameters(String cwd, String responsibility,
                                         AgentCapabilityProfile capabilityProfile);

    RuntimeSession start(String cwd, String responsibility, AgentCapabilityProfile capabilityProfile);

    RuntimeDispatchReceipt dispatch(RuntimeSession session, String clientMessageId, String prompt);

    void resume(RuntimeSession session);

    void interrupt(RuntimeSession session, String turnId);

    void stop(RuntimeSession session);
}
