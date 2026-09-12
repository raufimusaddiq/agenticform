package com.agenticform.config;

import com.agenticform.event.ControlPlaneMutationInterceptor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfig implements WebMvcConfigurer {
    private final AgenticformProperties properties;
    private final ControlPlaneMutationInterceptor mutationInterceptor;

    public WebConfig(AgenticformProperties properties, ControlPlaneMutationInterceptor mutationInterceptor) {
        this.properties = properties;
        this.mutationInterceptor = mutationInterceptor;
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOrigins(properties.getUi().getOrigin())
                .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                .allowedHeaders("*");
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(mutationInterceptor).addPathPatterns("/api/**");
    }
}
