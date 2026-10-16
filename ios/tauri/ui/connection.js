const form = document.getElementById('connection-form');
const server = document.getElementById('server');
const button = document.getElementById('connect');
const status = document.getElementById('status');
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);

async function connect() {
  button.disabled = true;
  server.disabled = true;
  status.textContent = 'Connecting to your server…';
  try {
    await invoke('mobile_connect', {server: server.value});
  } catch (error) {
    status.textContent = typeof error === 'string' ? error : (error?.message || 'Could not connect. Check the server address and try again.');
    button.disabled = false;
    server.disabled = false;
  }
}

form.addEventListener('submit', event => { event.preventDefault(); void connect(); });
invoke('mobile_connection_info').then(info => {
  if (info.server) {
    server.value = info.server;
    if (!new URLSearchParams(location.search).has('changeServer')) void connect();
  }
}).catch(() => { status.textContent = 'Could not restore the saved server address. Enter it again to connect.'; });
