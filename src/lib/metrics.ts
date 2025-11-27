// Lightweight in-memory Prometheus exposition helper
// - No disk or external store; metrics live in process memory and are scraped by Prometheus

type Labels = Record<string, string> | undefined;

function labelsKey(labels?: Labels) {
  if (!labels || Object.keys(labels).length === 0) return '{}';
  // stable order
  return JSON.stringify(Object.keys(labels).sort().reduce((acc, k) => { acc[k] = labels[k]; return acc; }, {} as Record<string,string>));
}

function labelsToString(labels?: Labels) {
  if (!labels || Object.keys(labels).length === 0) return '';
  const parts = Object.keys(labels).sort().map(k => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`);
  return `{${parts.join(',')}}`;
}

// Pushgateway configuration via env vars. If missing, metrics become no-op.
const PUSH_URL = process.env.METRICS_PUSHGATEWAY_URL;
const JOB_NAME = process.env.METRICS_JOB_NAME;
const INSTANCE = process.env.METRICS_INSTANCE || (() => { try { return require('os').hostname(); } catch { return 'instance'; } })();
const PUSH_INTERVAL_MS = parseInt(process.env.METRICS_PUSH_INTERVAL_MS || '15000', 10);
const PUSH_METHOD = (process.env.METRICS_PUSH_METHOD || 'PUT').toUpperCase();

const ENABLED = Boolean(PUSH_URL && JOB_NAME);


class Counter {
  sum = 0;
  perLabel = new Map<string, number>();
  inc(v = 1, labels?: Labels) {
    this.sum += v;
    const k = labelsKey(labels);
    this.perLabel.set(k, (this.perLabel.get(k) || 0) + v);
  }
}

class Gauge {
  value = 0;
  perLabel = new Map<string, number>();
  set(v: number, labels?: Labels) { this.value = v; this.perLabel.set(labelsKey(labels), v); }
  inc(delta = 1, labels?: Labels) { const k = labelsKey(labels); const v = (this.perLabel.get(k) || 0) + delta; this.perLabel.set(k, v); }
  dec(delta = 1, labels?: Labels) { const k = labelsKey(labels); const v = (this.perLabel.get(k) || 0) - delta; this.perLabel.set(k, v); }
}

class Histogram {
  // simple histogram with fixed buckets; store counts per bucket and sum
  buckets: number[];
  // map labelKey -> counts array
  counts = new Map<string, number[]>();
  sums = new Map<string, number>();
  constructor(buckets: number[]) { this.buckets = buckets.slice().sort((a,b)=>a-b); }
  observe(value: number, labels?: Labels) {
    const k = labelsKey(labels);
    const arr = this.counts.get(k) || this.buckets.map(()=>0);
    let placed = false;
    for (let i=0;i<this.buckets.length;i++) {
      if (value <= this.buckets[i]) { arr[i] = arr[i] + 1; placed = true; break; }
    }
    if (!placed) { arr[arr.length-1] = arr[arr.length-1] + 1; }
    this.counts.set(k, arr);
    this.sums.set(k, (this.sums.get(k) || 0) + value);
  }
}

const counters = new Map<string, Counter>();
const gauges = new Map<string, Gauge>();
const histograms = new Map<string, Histogram>();

export function counterInc(name: string, v = 1, labels?: Labels) {
  if (!ENABLED) return;
  let c = counters.get(name);
  if (!c) { c = new Counter(); counters.set(name, c); }
  c.inc(v, labels);
}

export function gaugeSet(name: string, v: number, labels?: Labels) {
  if (!ENABLED) return;
  let g = gauges.get(name);
  if (!g) { g = new Gauge(); gauges.set(name, g); }
  g.set(v, labels);
}

export function gaugeInc(name: string, delta = 1, labels?: Labels) {
  if (!ENABLED) return;
  let g = gauges.get(name);
  if (!g) { g = new Gauge(); gauges.set(name, g); }
  g.inc(delta, labels);
}

export function gaugeDec(name: string, delta = 1, labels?: Labels) {
  if (!ENABLED) return;
  let g = gauges.get(name);
  if (!g) { g = new Gauge(); gauges.set(name, g); }
  g.dec(delta, labels);
}

export function histogramObserve(name: string, value: number, labels?: Labels) {
  if (!ENABLED) return;
  let h = histograms.get(name);
  if (!h) {
    // default buckets: [.005, .01, .05, .1, .5, 1, 2.5, 5, 10] seconds
    h = new Histogram([0.005,0.01,0.05,0.1,0.5,1,2.5,5,10,30,60]);
    histograms.set(name, h);
  }
  h.observe(value, labels);
}

function renderMetricsInternal(): string {
  const lines: string[] = [];

  // counters
  counters.forEach((c, name) => {
    lines.push(`# HELP ${name} Counter metric`);
    lines.push(`# TYPE ${name} counter`);
    // global sum
    lines.push(`${name}_total ${c.sum}`);
    // per-label
    c.perLabel.forEach((val, k) => {
      if (k === '{}') return;
      const labels = JSON.parse(k);
      lines.push(`${name}_total${labelsToString(labels)} ${val}`);
    });
  });

  // gauges
  gauges.forEach((g, name) => {
    lines.push(`# HELP ${name} Gauge metric`);
    lines.push(`# TYPE ${name} gauge`);
    // global value
    lines.push(`${name} ${g.value}`);
    g.perLabel.forEach((val, k) => {
      if (k === '{}') return;
      const labels = JSON.parse(k);
      lines.push(`${name}${labelsToString(labels)} ${val}`);
    });
  });

  // histograms
  histograms.forEach((h, name) => {
    lines.push(`# HELP ${name} Histogram metric`);
    lines.push(`# TYPE ${name} histogram`);
    h.counts.forEach((arr, k) => {
      const labels = k === '{}' ? undefined : JSON.parse(k);
      let cum = 0;
      for (let i=0;i<arr.length;i++) {
        cum += arr[i];
        const le = h.buckets[i];
        lines.push(`${name}_bucket${labelsToString(labels ? {...labels, le: String(le)} : {le: String(le)})} ${cum}`);
      }
      const sum = h.sums.get(k) || 0;
      const total = arr.reduce((a,b)=>a+b,0);
      lines.push(`${name}_sum${labelsToString(labels)} ${sum}`);
      lines.push(`${name}_count${labelsToString(labels)} ${total}`);
    });
  });

  // add a scrape timestamp
  lines.push(`# HELP metrics_last_scrape_timestamp_seconds Last scrape timestamp`);
  lines.push(`# TYPE metrics_last_scrape_timestamp_seconds gauge`);
  lines.push(`metrics_last_scrape_timestamp_seconds ${Math.floor(Date.now()/1000)}`);

  return lines.join('\n') + '\n';
}

export function renderMetrics(): string {
  if (!ENABLED) return '';
  return renderMetricsInternal();
}

export function isEnabled(): boolean {
  return ENABLED;
}

// Push helpers and loop
async function pushOnceInternal(): Promise<void> {
  if (!ENABLED) return;
  const pushUrlBase = String(PUSH_URL).replace(/\/+$/,'');
  const endpoint = `${pushUrlBase}/metrics/job/${encodeURIComponent(String(JOB_NAME))}/instance/${encodeURIComponent(String(INSTANCE))}`;
  try {
    const method = PUSH_METHOD === 'POST' ? 'POST' : 'PUT';
    const body = renderMetricsInternal();
    await fetch(endpoint, { method, headers: { 'Content-Type': 'text/plain; version=0.0.4' }, body });
  } catch (err) {
    try { console.error('metrics push failed:', err); } catch (_) {}
  }
}

export async function pushNow(timeoutMs = 8000): Promise<void> {
  if (!ENABLED) return;
  const p = pushOnceInternal();
  const t = new Promise<void>((_, rej) => setTimeout(() => rej(new Error('metrics push timeout')), timeoutMs));
  try {
    await Promise.race([p, t]);
  } catch (err) {
    try { console.error('pushNow failed or timed out:', err); } catch (_) {}
  }
}

if (ENABLED) {
  try { void pushOnceInternal(); } catch (_) {}
  try { setInterval(() => { void pushOnceInternal(); }, Number.isNaN(PUSH_INTERVAL_MS) ? 15000 : PUSH_INTERVAL_MS); } catch (_) {}

  // attempt to push on shutdown signals (best-effort, Cloud Run sends SIGTERM)
  try {
    const shutdownHandler = () => {
      try {
        void pushNow(8000).then(() => { try { process.exit(0); } catch (_) {} }).catch(() => { try { process.exit(0); } catch (_) {} });
      } catch (_) {
        try { process.exit(0); } catch (_) {}
      }
    };
    try { process.on('SIGTERM', shutdownHandler); } catch (_) {}
    try { process.on('SIGINT', shutdownHandler); } catch (_) {}
  } catch (_) {}
}

export function resetAllMetrics() {
  counters.clear(); gauges.clear(); histograms.clear();
}
