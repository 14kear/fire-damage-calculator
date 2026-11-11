// Вычисления выполняются мгновенно на клиенте в app.js без загрузки тяжёлых WASM-пакетов.
self.onmessage = ({ data }) => {
  self.postMessage({ id: data.id, ok: true });
};
