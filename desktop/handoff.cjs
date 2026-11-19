// Ask about one request at a time. Accepted downloads can still resolve concurrently.
function createHandoffQueue({ confirm, run, onError, canStart, concurrency = 2, maxPending = 10 }) {
  const waiting = [];
  const pending = new Set();
  let active = 0;
  let confirming = false;

  async function confirmAndRun(id) {
    let accepted;
    try {
      accepted = await confirm(id);
    } finally {
      confirming = false;
    }
    if (!accepted || !canStart()) return;

    active++;
    drain();
    try {
      await run(id);
    } finally {
      active--;
    }
  }

  function drain() {
    if (confirming || !canStart() || active >= concurrency || !waiting.length) return;
    const id = waiting.shift();
    confirming = true;
    void confirmAndRun(id).catch(error => onError(error, id)).finally(() => {
      pending.delete(id);
      drain();
    });
  }
  return {
    add(id) {
      if (pending.has(id) || pending.size >= maxPending) return false;
      pending.add(id);
      waiting.push(id);
      drain();
      return true;
    },
    drain,
  };
}
module.exports = { createHandoffQueue };
