// IMPORTS
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();
const net = require('net');
const RPC_SHARED_SECRET = process.env.RPC_SHARED_SECRET;
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const bodyParser = require('body-parser');

// CONFIG
const node = 'node.bot-hosting.net'   // CHANGE to YOUR NODE hostname (e.g. prem-eu1.bot-hosting.net)
const monitor = 'node'                // CHANGE to YOUR NODE monitor ID (e.g. eu1)
const minutes = 1                    // Check interval in minutes (1-60)
const express = require('express');
const app = express();
const PORT = process.env.SERVER_PORT;

// BOT-HOSTING UPTIME MONITOR RPC
let reachablePorts = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkPort(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);
    const cleanup = () => { socket.destroy(); socket.removeAllListeners(); };
    socket.on('connect', () => { cleanup(); resolve(true); });
    socket.on('timeout', () => { cleanup(); resolve(false); });
    socket.on('error', (error) => {
      cleanup();
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') resolve(false);
      else if (error.code === 'EACCES' || error.code === 'EADDRINUSE') resolve(true);
      else resolve(false);
    });
    socket.connect(port, host);
  });
}

app.use(express.json());

app.all('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing "url" query param' });
  try {
    const headers = {};
    if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
    const response = await axios({ method: req.method, url: targetUrl, headers, data: req.body, timeout: 5000 });
    res.status(response.status).send(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).send(err.message || 'Proxy error');
  }
});

async function checkPortsWithConcurrency(host, ports, maxConcurrency) {
  let reachableCount = 0;
  const batches = [];
  for (let i = 0; i < ports.length; i += maxConcurrency) batches.push(ports.slice(i, i + maxConcurrency));
  for (const batch of batches) {
    const results = await Promise.all(batch.map((port) => checkPort(host, port)));
    reachableCount += results.filter((isReachable) => isReachable).length;
  }
  return reachableCount;
}

async function sendPostRequest(data) {
  try {
    const body = JSON.stringify(data);
    const timestamp = Date.now().toString();
    const signature = crypto.createHmac("sha256", RPC_SHARED_SECRET).update(`${timestamp}.${body}`).digest("hex");
    const response = await axios.post(
      "https://status.bot-hosting.net/pub-api/rpc-update",
      Buffer.from(body, "utf8"),
      {
        headers: {
          "X-RPC-Source": `${node}:${PORT}`,
          "Content-Type": "application/json",
          "X-RPC-Timestamp": timestamp,
          "X-RPC-Signature": signature,
        },
        transformRequest: [(data) => data]
      }
    );
    console.log(`[${new Date().toLocaleTimeString()}] POST response:`, response.data);
  } catch (error) {
    console.error(`[${new Date().toLocaleTimeString()}] POST request error:`, error.response?.status, error.response?.data || error.message);
  }
}

async function runMonitor() {
  try {
    const testPorts = Array.from({ length: 10001 }, (_, index) => 20000 + index);
    console.log(`[${new Date().toLocaleTimeString()}] Starting port scan...`);
    let reachableCount = -1;
    console.log(`[${new Date().toLocaleTimeString()}] Port scan complete. Reachable ports: ${reachableCount}`);
    reachablePorts = reachableCount;
    const stats = await getStats();
    await sendPostRequest({ monitorName: monitor, reachablePorts: reachableCount, stats });
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] Error during monitor run:`, err);
  }
}

async function scheduleMonitor() {
  await runMonitor();
  setTimeout(scheduleMonitor, minutes * 60 * 1000);
}

scheduleMonitor();

async function getDiskUsage() {
  let diskUsageInfo = 'N/A';
  let diskAvail = 'N/A';

  if (process.platform === 'linux' || process.platform === 'darwin') {
    try {
      const { stdout } = await execPromise('df -h /');
      const lines = stdout.split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        if (parts.length >= 5) {
          diskUsageInfo = `Used: ${parts[2]}B / Total: ${parts[1]}B (${parts[4]} used)`;
          diskAvail = parts[3]; 
        }
      }
    } catch (error) {
      diskUsageInfo = 'N/A';
      diskAvail = 'N/A';
    }
  } else if (process.platform === 'win32') {
    try {
      const drive = path.parse(process.cwd()).root.replace('\\', '').replace('/', '');
      const { stdout } = await execPromise(`wmic logicaldisk where "DeviceID='${drive}:'" get Size,FreeSpace /format:csv`);
      const lines = stdout.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(',');
        if (parts.length >= 3) {
          const free = parseInt(parts[1]);
          const size = parseInt(parts[2]);
          const used = size - free;
          const usedFormatted = formatBytes(used);
          const sizeFormatted = formatBytes(size);
          const percent = ((used / size) * 100).toFixed(2);
          diskUsageInfo = `Used: ${usedFormatted} / Total: ${sizeFormatted} (${percent}% used)`;
          const freeGB = free / 1e9;
          diskAvail = `${freeGB.toFixed(2)}G`;
        }
      }
    } catch (error) {
      diskUsageInfo = 'N/A';
      diskAvail = 'N/A';
    }
  }

  return { diskUsageInfo, diskAvail };
}

function formatBytes(bytes) {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9)  return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6)  return `${(bytes / 1e6).toFixed(2)} MB`;
  return `${(bytes / 1e3).toFixed(2)} KB`;
}

async function getStats() {
  const memoryUsage = process.memoryUsage();
  const totalMemory = formatBytes(os.totalmem());
  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;
  const cpuLoadPercent = ((loadAvg[0] / cpuCount) * 100).toFixed(2);
  const { diskUsageInfo, diskAvail } = await getDiskUsage();
  return {
    memory: `${totalMemory}`,
    cpu: `${cpuLoadPercent}% of ${cpuCount} cores`,
    disk: diskUsageInfo,
    diskAvail,             
  };
}

// ERROR HANDLING
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toLocaleTimeString()}] Uncaught Exception:`, err);
});

process.on('unhandledRejection', (err) => {
  console.error(`[${new Date().toLocaleTimeString()}] Unhandled Rejection:`, err);
});

