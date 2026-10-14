// Tests only: how long something takes, and how that grows with its input.

/**
 * What `run` gives back, and the milliseconds of CPU time this process spends
 * in it. CPU time leaves out the time the system gives to other work, which
 * the clock counts: on a crowded CI runner a run of a few milliseconds can
 * wait out several such turns. (Not `threadCpuUsage`, which Linux brings up
 * to date only on a scheduler tick, so a short run can read as nothing.)
 */
export function cpuTime<T>(run: () => T): { value: T; ms: number } {
  const start = process.cpuUsage();
  const value = run();
  const spent = process.cpuUsage(start);
  return { value, ms: (spent.user + spent.system) / 1000 };
}

/**
 * How many times longer `run` takes on `large` than on `small`, each at its
 * fastest. The two take turns, so a busy machine slows both alike; give
 * `small` enough to take some milliseconds, so one pause can't decide it.
 */
export function growth(run: (input: string) => void, small: string, large: string, rounds = 5) {
  run(small);
  const fastest = { small: Infinity, large: Infinity };
  for (let round = 0; round < rounds; round++) {
    fastest.small = Math.min(fastest.small, cpuTime(() => run(small)).ms);
    fastest.large = Math.min(fastest.large, cpuTime(() => run(large)).ms);
  }
  return fastest.large / fastest.small;
}
