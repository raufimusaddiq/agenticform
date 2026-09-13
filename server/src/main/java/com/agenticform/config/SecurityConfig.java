package com.agenticform.config;

import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
public class SecurityConfig {
    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http,
                                            AdminBearerAuthenticationFilter adminBearerAuthenticationFilter) throws Exception {
        http
                .cors(Customizer.withDefaults())
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .httpBasic(basic -> basic.disable())
                .formLogin(form -> form.disable())
                .logout(logout -> logout.disable())
                .headers(headers -> headers
                        .frameOptions(frame -> frame.deny())
                        .contentTypeOptions(Customizer.withDefaults())
                        .referrerPolicy(referrer -> referrer.policy(
                                org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy.NO_REFERRER))
                        .httpStrictTransportSecurity(hsts -> hsts
                                .includeSubDomains(true)
                                .preload(true)
                                .maxAgeInSeconds(31536000)))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                        .requestMatchers("/actuator/health").permitAll()
                        .requestMatchers(HttpMethod.POST, "/api/webhooks/github").permitAll()
                        .requestMatchers(HttpMethod.POST, "/api/nodes/enroll").permitAll()
                        .requestMatchers(HttpMethod.POST, "/api/nodes/*/heartbeat").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/nodes/*/commands/next").permitAll()
                        .requestMatchers(HttpMethod.POST, "/api/nodes/*/commands/*/complete").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/nodes/*/codex/**").permitAll()
                        .requestMatchers(HttpMethod.POST, "/api/nodes/*/codex/**").permitAll()
                        .requestMatchers(HttpMethod.POST, "/api/nodes/*/git-credential/**").permitAll()
                        .anyRequest().hasRole("ADMIN"))
                .exceptionHandling(errors -> errors.authenticationEntryPoint((request, response, error) ->
                        response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Admin authentication required")))
                .addFilterBefore(adminBearerAuthenticationFilter, UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }
}
