/** Test observer for the Gateway counter callback contract. */
export class TestCounters {
  private readonly counts = new Map<string, number>();
  incCounter(name: string) {
    this.addCounter(name, 1);
  }
  addCounter(name: string, value: number) {
    this.counts.set(name, (this.counts.get(name) ?? 0) + value);
  }
  snapshot() {
    return [...this.counts].map(([name, value]) => ({ name, value }));
  }
}
