package com.agenticform.node;

public final class ExecutionNodeProtocol {
    public static final int CURRENT = 1;
    public static final int MIN_SUPPORTED = 1;
    public static final int MAX_SUPPORTED = 1;

    private ExecutionNodeProtocol() {}

    public static boolean compatible(int version) {
        return version >= MIN_SUPPORTED && version <= MAX_SUPPORTED;
    }
}
