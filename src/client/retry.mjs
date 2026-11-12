// 取消时提前结束等待，并清理定时器与监听，供下一轮连接检查退出状态。
export function waitForRetry(signal, delayMs) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, delayMs);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
