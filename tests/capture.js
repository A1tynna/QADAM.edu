const fs = require('node:fs');

const [, , email = 'admin@qadam.edu', output = 'qa-dashboard.png', widthArg = '1440', heightArg = '1000', route = 'dashboard'] = process.argv;
const width = Number(widthArg);
const height = Number(heightArg);
let sequence = 0;
const pending = new Map();

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const targets = await fetch('http://localhost:9222/json').then((response) => response.json());
  const target = targets.find((item) => item.type === 'page');
  if (!target) throw new Error('Chrome DevTools target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  await send('Page.navigate', { url: 'http://localhost:3000' });
  await pause(700);
  if (email === 'register' || email === 'verify') {
    const expression = email === 'register'
      ? `document.querySelector('#showRegister').click()`
      : `showVerification('student@example.com')`;
    await send('Runtime.evaluate', { expression });
    await pause(500);
  } else {
    const expression = `(async () => {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(email)}, password: 'qadam123' }) });
      const data = await response.json();
      localStorage.setItem('qadam_token', data.token);
      location.replace('/?qa=' + Date.now() + '#${route}');
    })()`;
    await send('Runtime.evaluate', { expression, awaitPromise: true });
    await pause(1800);
  }
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(output, Buffer.from(shot.data, 'base64'));
  socket.close();
  console.log(`Captured ${output}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
