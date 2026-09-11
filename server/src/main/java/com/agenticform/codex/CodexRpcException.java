package com.agenticform.codex;

public class CodexRpcException extends RuntimeException {
    public CodexRpcException(String message) { super(message); }
    public CodexRpcException(String message, Throwable cause) { super(message, cause); }
}
