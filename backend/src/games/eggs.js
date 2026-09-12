const EGGS = {
  "minecraft-java": {
    id: "minecraft-java",
    name: "Minecraft Java (Paper)",
    image: "itzg/minecraft-server:latest",
    startup: "java -Xmx${SERVER_MEMORY} -Xms${SERVER_MEMORY} -jar /paper.jar nogui",
    stopCommand: "stop",
    ports: [{ container: 25565, protocol: "tcp" }],
    env: {
      EULA: "TRUE",
      TYPE: "PAPER",
      VERSION: "LATEST",
      SERVER_MEMORY: "2G",
      ONLINE_MODE: "TRUE",
      DIFFICULTY: "normal",
    },
    installScript: "docker pull itzg/minecraft-server:latest",
  },
  "minecraft-bedrock": {
    id: "minecraft-bedrock",
    name: "Minecraft Bedrock",
    image: "itzg/minecraft-bedrock-server:latest",
    startup: "LD_LIBRARY_PATH=. ./bedrock_server",
    stopCommand: "stop",
    ports: [{ container: 19132, protocol: "udp" }],
    env: {
      EULA: "TRUE",
      GAMEMODE: "survival",
      DIFFICULTY: "normal",
      SERVER_NAME: "Bedrock Server",
      LEVEL_NAME: "Bedrock level",
    },
    installScript: "docker pull itzg/minecraft-bedrock-server:latest",
  },
  cs2: {
    id: "cs2",
    name: "Counter-Strike 2",
    image: "joedwards32/cs2:latest",
    startup: "./game/bin/linuxsteamrt64/cs2 -dedicated -port ${PORT} -maxplayers ${MAXPLAYERS} +map ${MAP} +sv_password \"${SERVER_PASSWORD}\"",
    stopCommand: "quit",
    ports: [
      { container: 27015, protocol: "tcp" },
      { container: 27015, protocol: "udp" },
    ],
    env: {
      PORT: "27015",
      MAXPLAYERS: "10",
      MAP: "de_dust2",
      SERVER_PASSWORD: "",
      SRCDS_TOKEN: "",
    },
    installScript: "docker pull joedwards32/cs2:latest",
  },
  rust: {
    id: "rust",
    name: "Rust",
    image: "cm2network/rust:latest",
    startup: "./RustDedicated -batchmode +server.port ${PORT} +server.queryport ${QUERYPORT} +server.identity \"${IDENTITY}\" +server.hostname \"${HOSTNAME}\" +server.maxplayers ${MAXPLAYERS} +server.seed ${SEED} +server.worldsize ${WORLDSIZE}",
    stopCommand: "quit",
    ports: [
      { container: 28015, protocol: "tcp" },
      { container: 28015, protocol: "udp" },
      { container: 28016, protocol: "tcp" },
    ],
    env: {
      PORT: "28015",
      QUERYPORT: "28016",
      IDENTITY: "docker",
      HOSTNAME: "Rust Server",
      MAXPLAYERS: "50",
      SEED: "12345",
      WORLDSIZE: "3000",
    },
    installScript: "docker pull cm2network/rust:latest",
  },
  ark: {
    id: "ark",
    name: "ARK: Survival Evolved",
    image: "hermsi/ark-server:latest",
    startup: "./ShooterGame/Binaries/Linux/ShooterGameServer ${MAP}?listen?SessionName=\"${SESSION_NAME}\"?ServerPassword=${SERVER_PASSWORD}?ServerAdminPassword=${ADMIN_PASSWORD} -server -log",
    stopCommand: "saveworld\ndoexit",
    ports: [
      { container: 7777, protocol: "udp" },
      { container: 7778, protocol: "udp" },
      { container: 27015, protocol: "tcp" },
      { container: 27015, protocol: "udp" },
    ],
    env: {
      MAP: "TheIsland",
      SESSION_NAME: "ARK Server",
      SERVER_PASSWORD: "",
      ADMIN_PASSWORD: "admin",
      MAXPLAYERS: "20",
    },
    installScript: "docker pull hermsi/ark-server:latest",
  },
  valheim: {
    id: "valheim",
    name: "Valheim",
    image: "lloesche/valheim-server:latest",
    startup: "./valheim_server.x86_64 -nographics -batchmode -name \"${SERVER_NAME}\" -port ${PORT} -world \"${WORLD}\" -password \"${SERVER_PASSWORD}\" -public ${PUBLIC}",
    stopCommand: "SIGINT",
    ports: [
      { container: 2456, protocol: "tcp" },
      { container: 2456, protocol: "udp" },
      { container: 2457, protocol: "udp" },
      { container: 2458, protocol: "udp" },
    ],
    env: {
      SERVER_NAME: "Valheim Server",
      WORLD: "Dedicated",
      SERVER_PASSWORD: "secret123",
      PORT: "2456",
      PUBLIC: "1",
    },
    installScript: "docker pull lloesche/valheim-server:latest",
  },
  terraria: {
    id: "terraria",
    name: "Terraria",
    image: "ryshe/terraria:latest",
    startup: "./TerrariaServer.bin.x86_64 -config /config/serverconfig.txt",
    stopCommand: "exit",
    ports: [{ container: 7777, protocol: "tcp" }],
    env: {
      WORLD_NAME: "world",
      MAXPLAYERS: "8",
      PORT: "7777",
      DIFFICULTY: "0",
    },
    installScript: "docker pull ryshe/terraria:latest",
  },
};

function getEgg(id) {
  return EGGS[id] || null;
}

function listEggs() {
  return Object.values(EGGS);
}

module.exports = { EGGS, getEgg, listEggs };
