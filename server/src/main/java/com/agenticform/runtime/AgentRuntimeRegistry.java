package com.agenticform.runtime;

import org.springframework.stereotype.Component;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;

@Component
public class AgentRuntimeRegistry {
    private final Map<RuntimeType, AgentRuntime> runtimes;

    public AgentRuntimeRegistry(List<AgentRuntime> implementations) {
        EnumMap<RuntimeType, AgentRuntime> indexed = new EnumMap<>(RuntimeType.class);
        for (AgentRuntime runtime : implementations) {
            if (indexed.put(runtime.type(), runtime) != null) {
                throw new IllegalStateException("Duplicate runtime implementation: " + runtime.type());
            }
        }
        this.runtimes = Map.copyOf(indexed);
    }

    public AgentRuntime get(RuntimeType type) {
        RuntimeType requested = type == null ? RuntimeType.CODEX : type;
        AgentRuntime runtime = runtimes.get(requested);
        if (runtime == null) throw new IllegalStateException("No runtime implementation registered for " + requested);
        return runtime;
    }
}
