package com.agenticform.project;

import com.agenticform.config.AgenticformProperties;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

@Service
public class GitHubRepositoryValidator {
    private final AgenticformProperties.GitHub properties;
    private final ObjectMapper mapper;
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    public GitHubRepositoryValidator(AgenticformProperties properties, ObjectMapper mapper) {
        this.properties = properties.getGithub();
        this.mapper = mapper;
    }

    public void requirePushAccess(String repositoryUrl, String token) {
        if (token == null || token.isBlank()) return;
        String repository = repositoryPath(repositoryUrl);
        URI base = properties.getApiUrl();
        String prefix = base.toString().endsWith("/") ? base.toString() : base + "/";
        HttpRequest request = HttpRequest.newBuilder(URI.create(prefix + "repos/" + repository))
                .timeout(Duration.ofSeconds(20))
                .header("Accept", "application/vnd.github+json")
                .header("Authorization", "Bearer " + token.trim())
                .header("X-GitHub-Api-Version", "2022-11-28")
                .GET().build();
        try {
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 401 || response.statusCode() == 403) {
                throw new IllegalArgumentException("GitHub token is invalid or cannot access this repository");
            }
            if (response.statusCode() != 200) {
                throw new IllegalArgumentException("GitHub repository validation failed (HTTP " + response.statusCode() + ")");
            }
            JsonNode permissions = mapper.readTree(response.body()).path("permissions");
            if (!permissions.path("push").asBoolean(false)) {
                throw new IllegalArgumentException("GitHub token can read this repository but lacks push permission");
            }
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("Unable to validate GitHub repository access", error);
        }
    }

    private String repositoryPath(String value) {
        try {
            URI uri = URI.create(value.trim());
            if (!"github.com".equalsIgnoreCase(uri.getHost())) {
                throw new IllegalArgumentException("GitHub token validation requires a github.com repository");
            }
            String path = uri.getPath();
            if (path == null) throw new IllegalArgumentException("Invalid GitHub repository URL");
            path = path.replaceAll("^/+|/+$", "").replaceFirst("\\.git$", "");
            String[] parts = path.split("/");
            if (parts.length != 2 || parts[0].isBlank() || parts[1].isBlank()) {
                throw new IllegalArgumentException("GitHub repository URL must identify owner/repository");
            }
            return parts[0] + "/" + parts[1];
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("Invalid GitHub repository URL", error);
        }
    }
}
