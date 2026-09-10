import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";

interface KeepAliveConfig {
  enabled: boolean;
  url: string;
  intervalMinutes: number;
}

interface PingStats {
  sent: number;
  received: number;
  lastSentAt: string | null;
  lastStatus: string | null;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  const dataDir = path.resolve(process.cwd(), "data");
  const dataFile = path.join(dataDir, "app_state.json");
  const keepAliveConfigFile = path.join(dataDir, "keep_alive_config.json");

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Carga o configuración por defecto de Anti-Suspensión
  const keepAliveConfig: KeepAliveConfig = {
    enabled: true,
    url: process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || "",
    intervalMinutes: 8 // Ping cada 8 min (Render entra en suspensión a los 15 min)
  };

  if (fs.existsSync(keepAliveConfigFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(keepAliveConfigFile, "utf-8"));
      if (typeof saved.enabled === "boolean") keepAliveConfig.enabled = saved.enabled;
      if (saved.url) keepAliveConfig.url = saved.url;
      if (saved.intervalMinutes) keepAliveConfig.intervalMinutes = saved.intervalMinutes;
    } catch (e) {
      console.error("[Keep-Alive] Error leyendo configuración previa:", e);
    }
  }

  function saveKeepAliveConfig() {
    try {
      fs.writeFileSync(keepAliveConfigFile, JSON.stringify(keepAliveConfig, null, 2), "utf-8");
    } catch (e) {
      console.error("[Keep-Alive] Error guardando configuración:", e);
    }
  }

  const pingStats: PingStats = {
    sent: 0,
    received: 0,
    lastSentAt: null,
    lastStatus: null
  };

  // Middleware para auto-detectar la URL pública si la app corre en Render u otro cloud
  app.use((req, _res, next) => {
    if (!keepAliveConfig.url || keepAliveConfig.url.includes("localhost") || keepAliveConfig.url.includes("127.0.0.1")) {
      const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
      const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
      if (host && !host.includes("localhost") && !host.includes("127.0.0.1")) {
        keepAliveConfig.url = `${proto}://${host}`;
        saveKeepAliveConfig();
        console.log(`[Keep-Alive] URL pública detectada y fijada automáticamente: ${keepAliveConfig.url}`);
      }
    }
    next();
  });

  // Endpoints API
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  });

  // Endpoint de ping para mantener activo Render
  app.get("/api/ping", (_req, res) => {
    pingStats.received++;
    res.json({
      status: "awake",
      message: "Servidor activo permanentemente",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      pingsReceived: pingStats.received,
      pingsSent: pingStats.sent,
      lastPingSentAt: pingStats.lastSentAt
    });
  });

  // Estado y métricas del sistema Anti-Suspensión
  app.get("/api/keep-alive", (_req, res) => {
    res.json({
      enabled: keepAliveConfig.enabled,
      url: keepAliveConfig.url,
      intervalMinutes: keepAliveConfig.intervalMinutes,
      lastPingSentAt: pingStats.lastSentAt,
      lastPingStatus: pingStats.lastStatus,
      totalPingsSent: pingStats.sent,
      totalPingsReceived: pingStats.received,
      uptimeSeconds: Math.floor(process.uptime()),
      serverTime: new Date().toISOString()
    });
  });

  // Actualizar configuración de Anti-Suspensión
  app.post("/api/keep-alive/config", (req, res) => {
    try {
      const { url, enabled, intervalMinutes } = req.body;
      if (typeof url === "string") keepAliveConfig.url = url.trim();
      if (typeof enabled === "boolean") keepAliveConfig.enabled = enabled;
      if (typeof intervalMinutes === "number" && intervalMinutes >= 1 && intervalMinutes <= 14) {
        keepAliveConfig.intervalMinutes = intervalMinutes;
      }
      saveKeepAliveConfig();
      resetKeepAliveTimer();
      res.json({ ok: true, config: keepAliveConfig });
    } catch (err) {
      res.status(500).json({ error: "Error al actualizar la configuración" });
    }
  });

  // Disparar ping de prueba inmediato
  app.post("/api/keep-alive/ping-now", async (_req, res) => {
    try {
      const result = await triggerSelfPing();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || "Error al emitir ping" });
    }
  });

  // Persistencia de datos del portal
  app.get("/api/data", (_req, res) => {
    try {
      if (fs.existsSync(dataFile)) {
        const raw = fs.readFileSync(dataFile, "utf-8");
        const data = JSON.parse(raw);
        return res.json(data);
      }
      return res.status(404).json({ error: "No hay datos persistidos en el servidor" });
    } catch (err) {
      console.error("Error al leer datos:", err);
      return res.status(500).json({ error: "Fallo al leer datos del servidor" });
    }
  });

  app.post("/api/data", (req, res) => {
    try {
      const data = req.body;
      fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), "utf-8");
      return res.json({ ok: true, savedAt: new Date().toISOString() });
    } catch (err) {
      console.error("Error al guardar datos:", err);
      return res.status(500).json({ error: "Fallo al persistir datos" });
    }
  });

  // Función ejecutora de Auto-Ping
  async function triggerSelfPing() {
    let target = keepAliveConfig.url;
    if (!target) {
      target = `http://localhost:${PORT}`;
    }

    const pingUrl = target.replace(/\/+$/, "") + "/api/ping";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const start = Date.now();
      const response = await fetch(pingUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "PortalControl-KeepAlive/2.0" }
      });
      clearTimeout(timeout);
      const duration = Date.now() - start;

      pingStats.sent++;
      pingStats.lastSentAt = new Date().toISOString();
      pingStats.lastStatus = response.ok ? `OK (${duration}ms)` : `HTTP ${response.status}`;
      console.log(`[Keep-Alive 24/7] Auto-ping a ${pingUrl}: ${pingStats.lastStatus}`);
      return { ok: true, status: pingStats.lastStatus, duration, target: pingUrl };
    } catch (err: any) {
      clearTimeout(timeout);
      pingStats.lastStatus = `Error: ${err.message}`;
      console.warn(`[Keep-Alive 24/7] Auto-ping a ${pingUrl} falló:`, err.message);
      return { ok: false, error: err.message, target: pingUrl };
    }
  }

  // Temporizador para auto-ping en segundo plano
  let keepAliveTimer: NodeJS.Timeout | null = null;

  function resetKeepAliveTimer() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (!keepAliveConfig.enabled) {
      console.log("[Keep-Alive 24/7] Desactivado por configuración.");
      return;
    }

    const ms = (keepAliveConfig.intervalMinutes || 8) * 60 * 1000;
    console.log(`[Keep-Alive 24/7] Iniciando temporizador cada ${keepAliveConfig.intervalMinutes} minutos.`);
    keepAliveTimer = setInterval(() => {
      triggerSelfPing();
    }, ms);
  }

  // Iniciar timer tras 30 segundos
  setTimeout(() => {
    resetKeepAliveTimer();
    triggerSelfPing();
  }, 30000);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
