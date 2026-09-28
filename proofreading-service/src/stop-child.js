// Only terminate the process group created for this child, never the backend or unrelated ports.
export async function stopChild(child, graceMs = 2000) {
  if (!child.pid) return;
  const signal = name => { try { process.kill(-child.pid, name); } catch { /* group already exited */ } };
  if (child.exitCode !== null || child.signalCode) { signal('SIGTERM'); return; }
  await new Promise(resolve => {
    let timer;
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
    child.once('exit', done);
    timer = setTimeout(() => { signal('SIGKILL'); done(); }, graceMs);
    signal('SIGTERM');
  });
}
