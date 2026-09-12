const express = require("express");
const path = require("path");
const cors = require("cors");
const serversRouter = require("./routes/servers");
const authRouter = require("./routes/auth");
const filesRouter = require("./routes/files");
const playersRouter = require("./routes/players");
const schedulesRouter = require("./routes/schedules");
const backupsRouter = require("./routes/backups");
const { requireAuth, requireAdmin } = require("./lib/auth");
const { attachConsole } = require("./routes/console");
const { listEggs } = require("./games/eggs");
const docker = require("./lib/docker");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true, mock: docker.isMock(), time: new Date().toISOString() });
});

app.get("/api/games", (req, res) => {
  res.json(listEggs());
});

app.use("/api/auth", authRouter);
app.get("/api/users", requireAuth, requireAdmin, authRouter.listUsers);
app.use("/api/servers", serversRouter);
app.use("/api/servers", filesRouter);
app.use("/api/servers", playersRouter);
app.use("/api/servers", schedulesRouter);
app.use("/api/servers", backupsRouter);

const FRONTEND_DIR = path.resolve(__dirname, "../../frontend");
app.use(express.static(FRONTEND_DIR));
app.get("/manage", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "manage.html"));
});

let httpServer = null;

if (require.main === module) {
  docker.check().finally(() => {
    try {
      require("./routes/schedules").initSchedules();
    } catch {
      return;
    }
    httpServer = app.listen(PORT, () => {
      console.log(`game-panel backend on :${PORT} (mock=${docker.isMock()})`);
    });
    attachConsole(httpServer);
  });
} else {
  attachConsoleLazy();
}

function attachConsoleLazy() {
  const origListen = app.listen.bind(app);
  app.listen = (...args) => {
    httpServer = origListen(...args);
    attachConsole(httpServer);
    return httpServer;
  };
}

module.exports = app;
