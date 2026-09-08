const express = require('express');
const app = express();
const PORT = process.env.PORT || 3020;

// Health endpoint — required by RelayHall plugin system
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', plugin: 'claw-hello', version: '1.0.0' });
});

// Main API endpoint
app.get('/', (_req, res) => {
  res.json({
    message: 'Hello from RelayHall plugin!',
    timestamp: new Date().toISOString(),
  });
});

// Simple UI page (served via iframe in RelayHall sidebar)
app.get('/ui', (_req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Hello Plugin</title>
      <style>
        body {
          font-family: system-ui, sans-serif;
          background: #0f172a;
          color: #e2e8f0;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
        }
        .card {
          background: #1e293b;
          border-radius: 12px;
          padding: 2rem;
          text-align: center;
          border: 1px solid #334155;
        }
        h1 { color: #6366f1; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>👋 Hello Plugin</h1>
        <p>This is a minimal RelayHall plugin.</p>
        <p>It demonstrates the plugin anatomy.</p>
      </div>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🔌 claw-hello plugin running on port ${PORT}`);
});
