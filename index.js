// IMPORTS
const axios = require('axios');
const crypto = require('crypto');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const net = require('net')
const rateLimit = require('express-rate-limit');
const RPC_SHARED_SECRET = process.env.RPC_SHARED_SECRET;
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const bodyParser = require('body-parser');
// CONFIG
const node = 'fi3.bot-hosting.net'   // CHANGE node to YOUR NODE Ex: prem-eu1  (IF Your Node is prem-eu1 THEN Put prem-eu1 here NOT eu1)
const monitor = 'fi3'   // CHANGE node to YOUR NODE Ex: eu1 (IF Your Node is prem-eu1 THEN Put eu1 here NOT prem-eu1)
const minutes = 1    // INTERVAL OF CHECKS IN MINUTES, DEFAULT 3 MINUTES. INCREASE IF NEEDED UPTO MAX 60 MINUTES
const RPC = false   // DISABLE IF ON Fi (free) NODE or IF YOUR SERVER KEEPS CRASHING RANDOMLY AFTER OR AT PORT CHECK.
const express = require('express');
const app = express();
const PORT = 25530;

// BOT-HOSTING UPTIME MONITOR RPC:
let reachablePorts = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkPort(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);

    const cleanup = () => {
      socket.destroy();
      socket.removeAllListeners();
    };

    socket.on('connect', () => {
      cleanup();
      resolve(true);
    });

    socket.on('timeout', () => {
      cleanup();
      resolve(false);
    });

    socket.on('error', (error) => {
      cleanup();
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        resolve(false);
      } else if (error.code === 'EACCES' || error.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });

    socket.connect(port, host);
  });
}


app.use(express.json());

app.all('/health', async (req, res) => {
  const targetUrl = req.query.url;
    res.status(200).send('OK');
});

app.listen(PORT, () => console.log(`HP running on port ${PORT}`));

async function checkPortsWithConcurrency(host, ports, maxConcurrency) {
  let reachableCount = 0;

  const batches = [];
  for (let i = 0; i < ports.length; i += maxConcurrency) {
    batches.push(ports.slice(i, i + maxConcurrency));
  }

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

    const signature = crypto
      .createHmac("sha256", RPC_SHARED_SECRET)
      .update(`${timestamp}.${body}`)
      .digest("hex");

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
    console.error(
      `[${new Date().toLocaleTimeString()}] POST request error:`,
      error.response?.status,
      error.response?.data || error.message
    );
  }
}

async function runMonitor() {
  try {
    const testPorts = Array.from({ length: 10001 }, (_, index) => 20000 + index);
    console.log(`[${new Date().toLocaleTimeString()}] Starting port scan...`);
	let reachableCount = -1;
    
    if (RPC) {
	reachableCount = await checkPortsWithConcurrency(node, testPorts, 75);
    }
    console.log(`[${new Date().toLocaleTimeString()}] Port scan complete. Reachable ports: ${reachableCount}`);

   reachablePorts = reachableCount;
    const stats = await getStats();
     
   await sendPostRequest({
  monitorName: monitor,
  reachablePorts: reachableCount,
  stats
});
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
  if (process.platform === 'linux' || process.platform === 'darwin') {
    try {
      const { stdout } = await execPromise('df -h /');
      const lines = stdout.split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        if (parts.length >= 5) {
          diskUsageInfo = `Used: ${parts[2]}B / Total: ${parts[1]}B (${parts[4]} used)`;
        }
      }
    } catch (error) {
      diskUsageInfo = 'N/A';
    }
  } else if (process.platform === 'win32') {
    try {
      const drive = path.parse(process.cwd()).root.replace('\\','').replace('/','');
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
        }
      }
    } catch (error) {
      diskUsageInfo = 'N/A';
    }
  }
  return diskUsageInfo;
}

function formatBytes(bytes) {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  return `${(bytes / 1e3).toFixed(2)} KB`;
}

async function getStats() {
  const memoryUsage = process.memoryUsage();
  const usedMemory = formatBytes(memoryUsage.rss);
  const totalMemory = formatBytes(os.totalmem());
  const memoryPercent = ((memoryUsage.rss / os.totalmem()) * 100).toFixed(2);
  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;
  const cpuLoadPercent = ((loadAvg[0] / cpuCount) * 100).toFixed(2);
  const diskUsageInfo = await getDiskUsage();
  return {
    memory: `${totalMemory}`,
    cpu: `${cpuLoadPercent}% of ${cpuCount} cores`,
    disk: diskUsageInfo,
  };
}

// ERROR HANDLING:
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toLocaleTimeString()}] Uncaught Exception:`, err);
});

process.on('unhandledRejection', (err) => {
  console.error(`[${new Date().toLocaleTimeString()}] Unhandled Rejection:`, err);
});
