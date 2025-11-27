import FileTemp from './class/FileTemp';

export type WithTempOptions = {
  // When true, do not remove temp dir after the callback finishes.
  keepTemp?: boolean;
};

export async function withTemp<T>(
  maybeTemp: FileTemp | undefined,
  fn: (temp: FileTemp) => Promise<T>,
  options?: WithTempOptions,
): Promise<T> {
  const temp = maybeTemp ?? new FileTemp();
  await temp.ready();

  try {
    return await fn(temp);
  } finally {
    // Only clean when caller did not request keepTemp. If the temp was passed
    // in (not created here), still respect the keepTemp flag: caller owns it.
    if (!options?.keepTemp) {
      try { await temp.cleanFileOnTmpFolder(); } catch (_) {}
    }
  }
}
