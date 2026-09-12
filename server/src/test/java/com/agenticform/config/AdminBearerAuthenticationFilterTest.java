package com.agenticform.config;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.context.SecurityContextHolder;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class AdminBearerAuthenticationFilterTest {
    private static final String ADMIN_TOKEN = "01234567890123456789012345678901";

    @AfterEach
    void clearContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void validBearerTokenCreatesAdminAuthentication() throws Exception {
        AgenticformProperties properties = new AgenticformProperties();
        properties.getSecurity().setAdminToken(ADMIN_TOKEN);
        AdminBearerAuthenticationFilter filter = new AdminBearerAuthenticationFilter(properties);
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/nodes");
        request.addHeader("Authorization", "Bearer " + ADMIN_TOKEN);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(request, response, chain);

        var authentication = SecurityContextHolder.getContext().getAuthentication();
        assertEquals("agenticform-admin", authentication.getPrincipal());
        assertTrue(authentication.isAuthenticated());
        assertTrue(authentication.getAuthorities().stream().anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority())));
        verify(chain).doFilter(request, response);
    }

    @Test
    void invalidBearerTokenDoesNotAuthenticate() throws Exception {
        AgenticformProperties properties = new AgenticformProperties();
        properties.getSecurity().setAdminToken(ADMIN_TOKEN);
        AdminBearerAuthenticationFilter filter = new AdminBearerAuthenticationFilter(properties);
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/nodes");
        request.addHeader("Authorization", "Bearer definitely-wrong-token-value");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(request, response, chain);

        assertNull(SecurityContextHolder.getContext().getAuthentication());
        verify(chain).doFilter(request, response);
    }

    @Test
    void missingConfiguredTokenNeverAuthenticates() throws Exception {
        AgenticformProperties properties = new AgenticformProperties();
        AdminBearerAuthenticationFilter filter = new AdminBearerAuthenticationFilter(properties);
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/nodes");
        request.addHeader("Authorization", "Bearer " + ADMIN_TOKEN);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(request, response, chain);

        assertNull(SecurityContextHolder.getContext().getAuthentication());
        assertFalse(response.isCommitted());
        verify(chain).doFilter(request, response);
    }
}
