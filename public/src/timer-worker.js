let intervalId = null;

self.addEventListener('message', (event) => {
  const cmd = event.data && event.data.type;
  if (cmd === 'start') {
    if (intervalId !== null) clearInterval(intervalId);
    intervalId = setInterval(() => {
      self.postMessage({ type: 'tick', at: Date.now() });
    }, 1000);
  } else if (cmd === 'stop') {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }
});
