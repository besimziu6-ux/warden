const express = require("express");
const cors = require("cors");
const serversRouter = require("./routes/servers");
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

app.use("/api/servers", serversRouter);

if (require.main === module) {
  docker.check().finally(() => {
    app.listen(PORT, () => {
      console.log(`game-panel backend on :${PORT} (mock=${docker.isMock()})`);
    });
  });
}

module.exports = app;
