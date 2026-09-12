package com.agenticform.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;

@Component
public class AdminBearerAuthenticationFilter extends OncePerRequestFilter {
    private final AgenticformProperties properties;

    public AdminBearerAuthenticationFilter(AgenticformProperties properties) {
        this.properties = properties;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String configured = properties.getSecurity().getAdminToken();
        String authorization = request.getHeader("Authorization");
        if (configured != null && !configured.isBlank()
                && authorization != null && authorization.startsWith("Bearer ")) {
            String supplied = authorization.substring("Bearer ".length());
            if (constantTimeEquals(configured, supplied)) {
                var authentication = new UsernamePasswordAuthenticationToken(
                        "agenticform-admin", null, List.of(new SimpleGrantedAuthority("ROLE_ADMIN")));
                SecurityContextHolder.getContext().setAuthentication(authentication);
            }
        }
        filterChain.doFilter(request, response);
    }

    private boolean constantTimeEquals(String expected, String supplied) {
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                supplied.getBytes(StandardCharsets.UTF_8));
    }
}
