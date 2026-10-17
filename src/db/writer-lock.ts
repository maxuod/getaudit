import {
  readFileSync,
  openSync,
  writeFileSync,
  closeSync,
  unlinkSync,
} from "node:fs";

/** Cooperative ownership for the updated CLI, browser Console and Mac shell. */
export function acquireWriterLock(database: string) {
  const path = database + ".console-lock";
  try {
    const old = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(old) || old <= 0)
      throw new Error("台账锁文件无效，请先核对是否有 Lab 进程运行");
    try {
      process.kill(old, 0);
      throw new Error("此台账已有 Lab / Console 进程使用，请先退出该进程");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      unlinkSync(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}
