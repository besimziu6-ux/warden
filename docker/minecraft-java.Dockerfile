# Example: self-built Minecraft Java image matching the minecraft-java egg.
# The default egg uses itzg/minecraft-server:latest; this Dockerfile shows how
# to pin and pre-bake a variant. Runtime isolation (memory, cpus, pids,
# no-privileged, user 1000:1000) is enforced by backend/src/lib/docker.js
# at container-create time, not by this file.
FROM itzg/minecraft-server:latest

LABEL org.opencontainers.image.title="game-panel minecraft-java example"
LABEL org.opencontainers.image.description="Example self-built image for the minecraft-java egg"

ENV EULA=TRUE \
    TYPE=PAPER \
    VERSION=LATEST \
    SERVER_MEMORY=2G \
    ONLINE_MODE=TRUE \
    DIFFICULTY=normal

EXPOSE 25565/tcp

VOLUME ["/data"]

USER 1000:1000
