FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY server/pom.xml pom.xml
RUN mvn -B -q dependency:go-offline
COPY server/src src
RUN mvn -B -q -DskipTests package

FROM eclipse-temurin:21-jre
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --uid 10001 agenticform
USER agenticform
WORKDIR /app
COPY --from=build /build/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
