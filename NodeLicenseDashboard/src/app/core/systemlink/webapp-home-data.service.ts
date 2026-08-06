import { Injectable } from '@angular/core';

import { SystemLinkContextService } from './systemlink-context.service';

export interface TrendPoint {
  month: string;
  managed: number;
  unmanaged: number;
}

export interface NodeDetailRow {
  [key: string]: string;
  rowId: string;
  id: string;
  systemUrl: string;
  hostName: string;
  nodeType: string;
  status: string;
  registered: string;
  lastActive: string;
}

export interface HomePageModel {
  managed: number;
  unmanaged: number;
  inactive: number;
  virtual: number;
  trend: TrendPoint[];
  detail: NodeDetailRow[];
}

interface RawSystem {
  id?: string;
  host?: string;
  createdTimestamp?: string;
  lastUpdated?: string;
}

interface NodeRecord {
  id: string | null;
  host: string;
  created: Date | null;
  lastUpdated: Date | null;
}

interface StatusRecord extends NodeRecord {
  nodeType: 'Managed' | 'Unmanaged';
  status: string;
}

const MONTHS_TO_BUILD = 12;
const LICENSE_DURATION = 12;
const PAGE_SIZE = 1000;

const MANAGED_FILTER =
  'grains.data.host != null and grains.data.host != "" and connected.data.state != "VIRTUAL" ' +
  'and (activation.data.activated == true or activation.data.activated == null)';
const MANAGED_PROJECTION =
  'new(id, grains.data.host as host, createdTimestamp, connected.lastUpdatedTimestamp as lastUpdated)';
const VIRTUAL_FILTER = 'connected.data.state == "VIRTUAL"';
const VIRTUAL_PROJECTION =
  'new(id, alias as host, createdTimestamp, createdTimestamp as lastUpdated)';

@Injectable({ providedIn: 'root' })
export class WebappHomeDataService {
  constructor(private readonly context: SystemLinkContextService) {}

  async load(): Promise<HomePageModel> {
    const [managedRaw, virtualRaw] = await Promise.all([
      this.queryAllSystems(MANAGED_FILTER, MANAGED_PROJECTION),
      this.queryAllSystems(VIRTUAL_FILTER, VIRTUAL_PROJECTION),
    ]);

    const managed: NodeRecord[] = managedRaw.map((r) => ({
      id: r.id ?? null,
      host: (r.host ?? '').toString().trim(),
      created: this.parseDate(r.createdTimestamp),
      lastUpdated: this.parseDate(r.lastUpdated),
    }));

    const virtual: NodeRecord[] = virtualRaw.map((r) => ({
      id: r.id ?? null,
      host: (r.host ?? '').toString().trim().toUpperCase(),
      created: this.parseDate(r.createdTimestamp),
      lastUpdated: this.parseDate(r.lastUpdated),
    }));
    const virtualHosts = new Set(virtual.map((v) => v.host));

    const now = this.firstOfMonthUtc(new Date());
    const trend: TrendPoint[] = [];
    let currentManaged: StatusRecord[] = [];
    let currentUnmanaged: StatusRecord[] = [];

    for (let m = 0; m < MONTHS_TO_BUILD; m++) {
      const snapshot = this.addMonthsUtc(now, -m);
      const windowStart = this.addMonthsUtc(snapshot, -LICENSE_DURATION);
      const staleCutoff = windowStart;

      // --- Managed snapshot ---
      const managedSnapshot = managed.filter((s) => s.created !== null && s.created <= snapshot);
      const staleIds = new Set(
        managed.filter((s) => s.lastUpdated !== null && s.lastUpdated <= staleCutoff).map((s) => s.id),
      );
      const managedRows: StatusRecord[] = managedSnapshot.map((s) => ({
        ...s,
        nodeType: 'Managed',
        status: staleIds.has(s.id) ? 'Inactive' : 'Active',
      }));
      const managedHosts = new Set(managedSnapshot.map((s) => s.host.toUpperCase()));

      // --- Unmanaged snapshot (Test Monitor result hosts + virtual, minus managed) ---
      const resultHosts = await this.queryResultHosts(windowStart, snapshot);
      const resultRows: NodeRecord[] = Array.from(
        new Set(resultHosts.map((h) => (h ?? '').toString().trim().toUpperCase())),
      ).map((host) => ({ id: null, host, created: null, lastUpdated: null }));

      const combined: NodeRecord[] = [...resultRows, ...virtual];
      const unmanagedRows: StatusRecord[] = combined
        .filter((r) => !managedHosts.has(r.host))
        .map((r) => ({
          ...r,
          nodeType: 'Unmanaged',
          status: virtualHosts.has(r.host) ? 'Virtual' : 'Active',
        }));

      trend.push({
        month: this.yearMonthUtc(snapshot),
        managed: managedRows.length,
        unmanaged: unmanagedRows.length,
      });

      if (m === 0) {
        currentManaged = managedRows;
        currentUnmanaged = unmanagedRows;
      }
    }

    trend.reverse(); // oldest month first for the trend chart

    const inactive = currentManaged.filter((r) => r.status === 'Inactive').length;
    const virtualCount = currentUnmanaged.filter((r) => r.status === 'Virtual').length;
    const detail = [...currentManaged, ...currentUnmanaged].map((r, index) => this.toDetailRow(r, index));

    return {
      managed: currentManaged.length,
      unmanaged: currentUnmanaged.length,
      inactive,
      virtual: virtualCount,
      trend,
      detail,
    };
  }

  private async queryAllSystems(filter: string, projection: string): Promise<RawSystem[]> {
    const url = this.context.buildApiUrl('nisysmgmt/v1/query-systems');
    const all: RawSystem[] = [];
    let skip = 0;

    for (;;) {
      const response = await fetch(
        url,
        this.context.buildRequestInit({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filter, skip, take: PAGE_SIZE, projection }),
        }),
      );
      if (!response.ok) {
        throw new Error(`query-systems failed (${response.status})`);
      }
      const payload = (await response.json()) as { data?: RawSystem[] };
      const data = payload.data ?? [];
      if (data.length === 0) {
        break;
      }
      all.push(...data);
      skip += PAGE_SIZE;
    }

    return all;
  }

  private async queryResultHosts(windowStart: Date, snapshot: Date): Promise<string[]> {
    const url = this.context.buildApiUrl('nitestmonitor/v2/query-result-values');
    const filter = `updatedAt >= "${windowStart.toISOString()}" and updatedAt <= "${snapshot.toISOString()}"`;
    const response = await fetch(
      url,
      this.context.buildRequestInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: 'HOST_NAME', filter }),
      }),
    );
    if (!response.ok) {
      throw new Error(`query-result-values failed (${response.status})`);
    }
    const payload = (await response.json()) as string[] | { values?: string[] };
    return Array.isArray(payload) ? payload : payload.values ?? [];
  }

  /** Returns a URL to the latest test result for the given host, or null if none exists. */
  async getLatestResultUrl(hostName: string): Promise<string | null> {
    const url = this.context.buildApiUrl('nitestmonitor/v2/query-results');
    const filter = `hostName == "${hostName.replace(/"/g, '\\"')}"`;
    const response = await fetch(
      url,
      this.context.buildRequestInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter, orderBy: 'STARTED_AT', descending: true, take: 1, projection: ['ID'] }),
      }),
    );
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { results?: { id?: string }[] };
    const id = payload.results?.[0]?.id;
    return id ? `${this.context.origin}/testinsights/results/result/${id}` : null;
  }

  private toDetailRow(record: StatusRecord, index: number): NodeDetailRow {
    const id = record.id ?? '';
    return {
      rowId: `${index}`,
      id,
      systemUrl: id ? `/systems/${id}` : '',
      hostName: record.host,
      nodeType: record.nodeType,
      status: record.status,
      registered: this.formatTimestamp(record.created),
      lastActive: this.formatTimestamp(record.lastUpdated),
    };
  }

  private parseDate(value: string | undefined): Date | null {
    if (!value) {
      return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private firstOfMonthUtc(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }

  private addMonthsUtc(date: Date, delta: number): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1));
  }

  private yearMonthUtc(date: Date): string {
    return `${date.getUTCFullYear()}-${this.pad(date.getUTCMonth() + 1)}`;
  }

  private formatTimestamp(date: Date | null): string {
    if (!date) {
      return '';
    }
    const d = `${date.getUTCFullYear()}-${this.pad(date.getUTCMonth() + 1)}-${this.pad(date.getUTCDate())}`;
    const t = `${this.pad(date.getUTCHours())}:${this.pad(date.getUTCMinutes())}:${this.pad(date.getUTCSeconds())}`;
    return `${d} ${t}`;
  }

  private pad(value: number): string {
    return value.toString().padStart(2, '0');
  }
}
