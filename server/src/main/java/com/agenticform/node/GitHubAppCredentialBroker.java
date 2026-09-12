package com.agenticform.node;

import com.agenticform.config.AgenticformProperties;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;

@Service
public class GitHubAppCredentialBroker {
    public record Credential(String username, String password, Instant expiresAt) {}

    private final AgenticformProperties.GitHub properties;
    private final ObjectMapper mapper;
    private final HttpClient client = HttpClient.newHttpClient();

    public GitHubAppCredentialBroker(AgenticformProperties properties, ObjectMapper mapper) {
        this.properties = properties.getGithub();
        this.mapper = mapper;
    }

    public boolean configured() {
        return properties.getAppId() > 0 && properties.getInstallationId() > 0
                && properties.getAppPrivateKeyPath() != null && !properties.getAppPrivateKeyPath().isBlank();
    }

    public Credential issue(String repositoryUrl) {
        if (!configured()) {
            throw new IllegalStateException("GitHub App credential broker is not configured");
        }
        Repo repo = parseRepository(repositoryUrl);
        try {
            String jwt = appJwt();
            String body = mapper.writeValueAsString(Map.of(
                    "repositories", new String[]{repo.name()},
                    "permissions", Map.of("contents", "write")
            ));
            URI endpoint = properties.getApiUrl().resolve(
                    "/app/installations/" + properties.getInstallationId() + "/access_tokens");
            HttpRequest request = HttpRequest.newBuilder(endpoint)
                    .header("Authorization", "Bearer " + jwt)
                    .header("Accept", "application/vnd.github+json")
                    .header("X-GitHub-Api-Version", "2022-11-28")
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() / 100 != 2) {
                throw new IllegalStateException("GitHub App token request failed with status " + response.statusCode());
            }
            JsonNode json = mapper.readTree(response.body());
            String token = json.path("token").asText(null);
            String expiresAt = json.path("expires_at").asText(null);
            if (token == null || token.isBlank() || expiresAt == null || expiresAt.isBlank()) {
                throw new IllegalStateException("GitHub App token response is incomplete");
            }
            return new Credential("x-access-token", token, Instant.parse(expiresAt));
        } catch (IllegalStateException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalStateException("Unable to issue short-lived GitHub repository credential", error);
        }
    }

    private String appJwt() throws Exception {
        Instant now = Instant.now();
        String header = base64Url(mapper.writeValueAsBytes(Map.of("alg", "RS256", "typ", "JWT")));
        String payload = base64Url(mapper.writeValueAsBytes(Map.of(
                "iat", now.minusSeconds(60).getEpochSecond(),
                "exp", now.plusSeconds(9 * 60).getEpochSecond(),
                "iss", properties.getAppId()
        )));
        String unsigned = header + "." + payload;
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(privateKey());
        signer.update(unsigned.getBytes(StandardCharsets.US_ASCII));
        return unsigned + "." + base64Url(signer.sign());
    }

    private PrivateKey privateKey() throws Exception {
        String pem = Files.readString(Path.of(properties.getAppPrivateKeyPath()), StandardCharsets.US_ASCII);
        if (!pem.contains("BEGIN PRIVATE KEY")) {
            throw new IllegalStateException("GitHub App private key must be PKCS#8 PEM (BEGIN PRIVATE KEY)");
        }
        String normalized = pem.replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "")
                .replaceAll("\\s", "");
        byte[] der = Base64.getDecoder().decode(normalized);
        return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(der));
    }

    private Repo parseRepository(String value) {
        try {
            URI uri = URI.create(value);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || !"github.com".equalsIgnoreCase(uri.getHost())) {
                throw new IllegalArgumentException("GitHub App broker supports credential-free https://github.com repositories only");
            }
            String path = uri.getPath();
            if (path == null) throw new IllegalArgumentException("Invalid GitHub repository URL");
            String[] segments = path.replaceAll("^/+|/+$", "").split("/");
            if (segments.length != 2) throw new IllegalArgumentException("GitHub repository URL must identify owner/repository");
            String name = segments[1].endsWith(".git") ? segments[1].substring(0, segments[1].length() - 4) : segments[1];
            if (segments[0].isBlank() || name.isBlank()) throw new IllegalArgumentException("Invalid GitHub repository URL");
            return new Repo(segments[0], name);
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("Invalid GitHub repository URL", error);
        }
    }

    private String base64Url(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private record Repo(String owner, String name) {}
}
