// Keep accepted IDs distinct while allowing unrelated videos to resolve together.
function createHandoffQueue({ run, onError, canStart, concurrency = 2 }) {
  const waiting = [];
  const pending = new Set();
  let active = 0;
  function drain() {
    while (canStart() && active < concurrency && waiting.length) {
      const id = waiting.shift();
      active++;
      Promise.resolve().then(() => run(id)).catch(error => onError(error, id)).finally(() => {
        active--;
        pending.delete(id);
        drain();
      });
    }
  }
  return {
    add(id) {
      if (pending.has(id)) return false;
      pending.add(id);
      waiting.push(id);
      drain();
      return true;
    },
    drain,
  };
}
module.exports = { createHandoffQueue };
