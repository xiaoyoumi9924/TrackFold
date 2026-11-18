function createShutdownTimer(onChange, onExpire) {
  let deadline = null;
  let timeout;

  function check() {
    clearTimeout(timeout);
    if (deadline === null) return;
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      timeout = setTimeout(check, remaining);
      return;
    }
    deadline = null;
    onChange(null);
    onExpire();
  }

  function update(minutes) {
    if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 720))
      throw new Error('请设置 1 至 720 分钟。');
    deadline = minutes === null ? null : Date.now() + minutes * 60000;
    onChange(deadline);
    check();
    return deadline;
  }

  return { current: () => deadline, update, check };
}

module.exports = { createShutdownTimer };
