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
  hostRaw: string;
  nodeType: string;
  status: string;
  registered: string;
  lastActive: string;
  lastActiveIso: string;
  // Ready-to-send query-results hostName predicate for View Result ('' when not lookupable).
  resultFilter: string;
  // 'true' when a result was already observed for this row (button can show without a query).
  hasResult: string;
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
  connectionState?: string;
}

interface NodeRecord {
  id: string | null;
  host: string;
  hostRaw: string;
  created: Date | null;
  lastUpdated: Date | null;
  connectionState: string | null;
  fromResult: boolean;
  // Explicit query-results predicate for rows not identified by host name (NULL/empty host, SYSTEM_ID).
  resultFilterOverride?: string;
}

interface StatusRecord extends NodeRecord {
  nodeType: 'Managed' | 'Unmanaged';
  status: string;
}

const MONTHS_TO_BUILD = 12;
const LICENSE_DURATION = 12;
const PAGE_SIZE = 1000;

// SystemLink Server has no concept of virtual nodes, so "connected.data.state" isn't a
// queryable field there and any filter referencing it fails with a 400 Bad Request.
const MANAGED_FILTER_WITH_VIRTUAL =
  'grains.data.host != null and grains.data.host != "" and connected.data.state != "VIRTUAL" ' +
  'and (activation.data.activated == true or activation.data.activated == null)';
const MANAGED_FILTER_NO_VIRTUAL =
  'grains.data.host != null and grains.data.host != "" ' +
  'and (activation.data.activated == true or activation.data.activated == null)';
// SLE/Valinor expose connected.data.state, letting us honor the "still CONNECTED is not stale" rule.
const MANAGED_PROJECTION_WITH_STATE =
  'new(id, grains.data.host as host, createdTimestamp, connected.lastUpdatedTimestamp as lastUpdated, ' +
  'connected.data.state as connectionState)';
const MANAGED_PROJECTION_NO_STATE =
  'new(id, grains.data.host as host, createdTimestamp, connected.lastUpdatedTimestamp as lastUpdated)';
const VIRTUAL_FILTER = 'connected.data.state == "VIRTUAL"';
const VIRTUAL_PROJECTION =
  'new(id, alias as host, createdTimestamp, createdTimestamp as lastUpdated)';

// Sentinels used as hostRaw for the collapsed NULL / empty-host unmanaged rows so result lookups
// can build the correct query-results filter for them.
const NULL_HOST_TOKEN = '\u0000NULL_HOST';
const EMPTY_HOST_TOKEN = '\u0000EMPTY_HOST';

@Injectable({ providedIn: 'root' })
export class WebappHomeDataService {
  /** Cached across calls: whether the target instance supports the virtual node concept (SLE only). */
  private virtualNodesSupported: boolean | null = null;

  constructor(private readonly context: SystemLinkContextService) {}

  async load(): Promise<HomePageModel> {
    const virtualSupported = await this.detectVirtualNodeSupport();
    const managedFilter = virtualSupported ? MANAGED_FILTER_WITH_VIRTUAL : MANAGED_FILTER_NO_VIRTUAL;
    const managedProjection = virtualSupported ? MANAGED_PROJECTION_WITH_STATE : MANAGED_PROJECTION_NO_STATE;

    const [managedRaw, virtualRaw, fleetRaw] = await Promise.all([
      this.queryAllSystems(managedFilter, managedProjection),
      virtualSupported ? this.queryAllSystems(VIRTUAL_FILTER, VIRTUAL_PROJECTION) : Promise.resolve([]),
      this.queryAllSystems('id != null', 'new(id)'),
    ]);
    // Every real system id; a SYSTEM_ID on a result that isn't here is an orphaned/misclassified host.
    const fleetIds = new Set(fleetRaw.map((r) => r.id).filter((id): id is string => !!id));

    const managed: NodeRecord[] = managedRaw.map((r) => ({
      id: r.id ?? null,
      host: (r.host ?? '').toString().trim(),
      hostRaw: (r.host ?? '').toString().trim(),
      created: this.parseDate(r.createdTimestamp),
      lastUpdated: this.parseDate(r.lastUpdated),
      connectionState: r.connectionState ?? null,
      fromResult: false,
    }));

    const virtual: NodeRecord[] = virtualRaw.map((r) => ({
      id: r.id ?? null,
      host: (r.host ?? '').toString().trim().toUpperCase(),
      hostRaw: (r.host ?? '').toString().trim(),
      created: this.parseDate(r.createdTimestamp),
      lastUpdated: this.parseDate(r.lastUpdated),
      connectionState: r.connectionState ?? null,
      fromResult: false,
    }));
    const virtualHosts = new Set(virtual.map((v) => v.host));

    const now = this.firstOfMonthUtc(new Date());
    const trend: TrendPoint[] = [];
    let currentManaged: StatusRecord[] = [];
    let currentUnmanaged: StatusRecord[] = [];

    // Prefetch every month's result-host window in parallel instead of sequentially.
    const windows = Array.from({ length: MONTHS_TO_BUILD }, (_, m) => {
      const snapshot = this.addMonthsUtc(now, -m);
      return { snapshot, windowStart: this.addMonthsUtc(snapshot, -LICENSE_DURATION) };
    });
    const [resultHostsByMonth, nullHostSysIdsByMonth, hostedSysIdsByMonth] = await Promise.all([
      Promise.all(windows.map((w) => this.queryResultHosts(w.windowStart, w.snapshot))),
      Promise.all(
        windows.map((w) =>
          this.querySystemIds('(hostName == null or hostName == "")', w.windowStart, w.snapshot),
        ),
      ),
      Promise.all(
        windows.map((w) =>
          this.querySystemIds('hostName != null and hostName != ""', w.windowStart, w.snapshot),
        ),
      ),
    ]);

    for (let m = 0; m < MONTHS_TO_BUILD; m++) {
      const { snapshot, windowStart } = windows[m];
      const staleCutoff = windowStart;

      // --- Managed snapshot ---
      const managedSnapshot = managed.filter((s) => s.created !== null && s.created <= snapshot);
      const staleIds = new Set(
        managed
          .filter((s) => {
            if (s.lastUpdated === null || s.lastUpdated > staleCutoff) {
              return false;
            }
            // On SLE the connection state is known; a still-CONNECTED node is not stale.
            return s.connectionState !== 'CONNECTED';
          })
          .map((s) => s.id),
      );
      const managedRows: StatusRecord[] = managedSnapshot.map((s) => ({
        ...s,
        nodeType: 'Managed',
        status: staleIds.has(s.id) ? 'Inactive' : 'Active',
      }));
      const managedHosts = new Set(managedSnapshot.map((s) => s.host.toUpperCase()));

      // --- Unmanaged snapshot (Test Monitor result hosts + virtual, minus managed) ---
      const resultHosts = resultHostsByMonth[m];
      const seenResultHosts = new Set<string>();
      const resultRows: NodeRecord[] = [];
      let hasNullHost = false;
      let hasEmptyHost = false;
      for (const raw of resultHosts) {
        if (raw === null || raw === undefined) {
          hasNullHost = true;
          continue;
        }
        const trimmed = raw.toString().trim();
        if (trimmed === '') {
          hasEmptyHost = true;
          continue;
        }
        const key = trimmed.toUpperCase();
        if (seenResultHosts.has(key)) {
          continue;
        }
        seenResultHosts.add(key);
        resultRows.push({
          id: null,
          host: key,
          hostRaw: trimmed,
          created: null,
          lastUpdated: null,
          connectionState: null,
          fromResult: true,
        });
      }
      // Results whose host is misclassified under SYSTEM_ID: each distinct SYSTEM_ID that is not a
      // real system (orphaned) and never appears with a host name is a distinct unmanaged node.
      const hostedSysIds = new Set(
        hostedSysIdsByMonth[m]
          .map((s) => (s ?? '').toString().trim().toUpperCase())
          .filter((s) => s),
      );
      let emptySystemIdExists = false;
      for (const raw of nullHostSysIdsByMonth[m]) {
        const value = (raw ?? '').toString().trim();
        if (!value) {
          emptySystemIdExists = true;
          continue;
        }
        const key = value.toUpperCase();
        if (
          fleetIds.has(value) ||
          managedHosts.has(key) ||
          virtualHosts.has(key) ||
          seenResultHosts.has(key) ||
          hostedSysIds.has(key)
        ) {
          continue;
        }
        seenResultHosts.add(key);
        resultRows.push({
          id: null,
          host: value,
          hostRaw: value,
          created: null,
          lastUpdated: null,
          connectionState: null,
          fromResult: true,
          resultFilterOverride: `systemId == "${value.replace(/"/g, '\\"')}"`,
        });
      }

      // NULL / empty host results that also lack a SYSTEM_ID collapse to one node each.
      if (hasNullHost && emptySystemIdExists) {
        resultRows.push({
          id: null,
          host: '(no host name)',
          hostRaw: NULL_HOST_TOKEN,
          created: null,
          lastUpdated: null,
          connectionState: null,
          fromResult: true,
          resultFilterOverride: 'hostName == null and (systemId == null or systemId == "")',
        });
      }
      if (hasEmptyHost && emptySystemIdExists) {
        resultRows.push({
          id: null,
          host: '(empty host name)',
          hostRaw: EMPTY_HOST_TOKEN,
          created: null,
          lastUpdated: null,
          connectionState: null,
          fromResult: true,
          resultFilterOverride: 'hostName != null and hostName == "" and (systemId == null or systemId == "")',
        });
      }

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

    // Use the actual current time (not the month-start snapshot) so Last Active reflects the same
    // latest result that the View Result link opens.
    const currentWindowStart = this.addMonthsUtc(now, -LICENSE_DURATION);
    await this.enrichUnmanagedLastActive(currentUnmanaged, currentWindowStart, new Date());

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
      const response = await this.fetchWithRetry(
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

  /** Probes whether the connected instance supports querying virtual node state (SLE only). */
  private async detectVirtualNodeSupport(): Promise<boolean> {
    if (this.virtualNodesSupported !== null) {
      return this.virtualNodesSupported;
    }

    const url = this.context.buildApiUrl('nisysmgmt/v1/query-systems');
    const response = await this.fetchWithRetry(
      url,
      this.context.buildRequestInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter: VIRTUAL_FILTER, skip: 0, take: 1, projection: VIRTUAL_PROJECTION }),
      }),
    );
    this.virtualNodesSupported = response.ok;
    return this.virtualNodesSupported;
  }

  private async queryResultHosts(windowStart: Date, snapshot: Date): Promise<(string | null)[]> {
    const url = this.context.buildApiUrl('nitestmonitor/v2/query-result-values');
    const filter = `updatedAt >= "${windowStart.toISOString()}" and updatedAt <= "${snapshot.toISOString()}"`;
    const response = await this.fetchWithRetry(
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
    const payload = (await response.json()) as (string | null)[] | { values?: (string | null)[] };
    return Array.isArray(payload) ? payload : payload.values ?? [];
  }

  /** Distinct SYSTEM_ID values among results matching the given hostName clause, within the window. */
  private async querySystemIds(
    hostClause: string,
    windowStart: Date,
    snapshot: Date,
  ): Promise<(string | null)[]> {
    const url = this.context.buildApiUrl('nitestmonitor/v2/query-result-values');
    const filter =
      `${hostClause} ` +
      `and updatedAt >= "${windowStart.toISOString()}" and updatedAt <= "${snapshot.toISOString()}"`;
    const response = await this.fetchWithRetry(
      url,
      this.context.buildRequestInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: 'SYSTEM_ID', filter }),
      }),
    );
    if (!response.ok) {
      // Best-effort grouping; skip if the service rejects the query.
      return [];
    }
    const payload = (await response.json()) as (string | null)[] | { values?: (string | null)[] };
    return Array.isArray(payload) ? payload : payload.values ?? [];
  }

  /** Fills lastUpdated for unmanaged Active rows by scanning recent results once (not per-host). */
  private async enrichUnmanagedLastActive(
    rows: StatusRecord[],
    windowStart: Date,
    windowEnd: Date,
  ): Promise<void> {
    // Rows identified by an explicit predicate (NULL/empty host or misclassified SYSTEM_ID) can't
    // be matched by host key, so query each directly.
    for (const row of rows) {
      if (row.nodeType === 'Unmanaged' && !row.lastUpdated && row.resultFilterOverride) {
        row.lastUpdated = await this.getLatestResultTimestampByFilter(
          row.resultFilterOverride,
          windowStart,
          windowEnd,
        );
      }
    }

    const targetKeys = new Set(
      rows
        .filter(
          (r) =>
            r.nodeType === 'Unmanaged' &&
            r.status === 'Active' &&
            !r.lastUpdated &&
            r.hostRaw &&
            !r.resultFilterOverride,
        )
        .map((r) => r.hostRaw.toUpperCase()),
    );
    if (targetKeys.size === 0) {
      return;
    }

    const url = this.context.buildApiUrl('nitestmonitor/v2/query-results');
    const filter = `updatedAt >= "${windowStart.toISOString()}" and updatedAt <= "${windowEnd.toISOString()}"`;
    const latestByHost = new Map<string, Date>();
    let continuationToken: string | undefined;
    const maxPages = 60;

    for (let page = 0; page < maxPages && latestByHost.size < targetKeys.size; page++) {
      const response = await this.fetchWithRetry(
        url,
        this.context.buildRequestInit({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filter,
            orderBy: 'UPDATED_AT',
            descending: true,
            take: 1000,
            projection: ['HOST_NAME', 'STARTED_AT', 'UPDATED_AT'],
            continuationToken,
          }),
        }),
      );
      if (!response.ok) {
        break;
      }
      const payload = (await response.json()) as {
        results?: { hostName?: string; startedAt?: string; updatedAt?: string }[];
        continuationToken?: string;
      };
      const results = payload.results ?? [];
      for (const result of results) {
        // Results are newest-first, so the first hit per host is its latest.
        const key = (result.hostName ?? '').trim().toUpperCase();
        if (key && targetKeys.has(key) && !latestByHost.has(key)) {
          const timestamp = this.parseDate(result.updatedAt ?? result.startedAt);
          if (timestamp) {
            latestByHost.set(key, timestamp);
          }
        }
      }
      continuationToken = payload.continuationToken;
      if (!continuationToken || results.length === 0) {
        break;
      }
    }

    for (const row of rows) {
      if (row.nodeType === 'Unmanaged' && row.status === 'Active' && !row.lastUpdated) {
        const timestamp = latestByHost.get(row.hostRaw.toUpperCase());
        if (timestamp) {
          row.lastUpdated = timestamp;
        }
      }
    }
  }

  /** Returns a URL to the latest test result for the given hostName predicate, or null if none. */
  async getLatestResultUrl(filter: string): Promise<string | null> {
    if (!filter) {
      return null;
    }
    const url = this.context.buildApiUrl('nitestmonitor/v2/query-results');
    const response = await this.fetchWithRetry(
      url,
      this.context.buildRequestInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter, orderBy: 'UPDATED_AT', descending: true, take: 1, projection: ['ID'] }),
      }),
    );
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { results?: { id?: string }[] };
    const id = payload.results?.[0]?.id;
    return id ? `${this.context.origin}/testinsights/results/result/${id}` : null;
  }

  /** Builds the query-results hostName predicate for a normal host. */
  private buildHostFilter(hostRaw: string): string {
    const key = hostRaw.trim().toUpperCase().replace(/"/g, '\\"');
    return `hostName != null and hostName.ToUpper() == "${key}"`;
  }

  /** Latest result timestamp for a hostName/systemId predicate, bounded to the window. */
  private async getLatestResultTimestampByFilter(
    hostFilter: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<Date | null> {
    const url = this.context.buildApiUrl('nitestmonitor/v2/query-results');
    const filter =
      `${hostFilter} ` +
      `and updatedAt >= "${windowStart.toISOString()}" and updatedAt <= "${windowEnd.toISOString()}"`;
    const response = await this.fetchWithRetry(
      url,
      this.context.buildRequestInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filter,
          orderBy: 'UPDATED_AT',
          descending: true,
          take: 1,
          projection: ['UPDATED_AT', 'STARTED_AT'],
        }),
      }),
    );
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as {
      results?: { updatedAt?: string; startedAt?: string }[];
    };
    const result = payload.results?.[0];
    return result ? this.parseDate(result.updatedAt ?? result.startedAt) : null;
  }

  private toDetailRow(record: StatusRecord, index: number): NodeDetailRow {
    const id = record.id ?? '';
    // Keep the NULL/empty sentinel out of the DOM; the clean predicate lives in resultFilter.
    const isToken = record.hostRaw === NULL_HOST_TOKEN || record.hostRaw === EMPTY_HOST_TOKEN;
    return {
      rowId: `${index}`,
      id,
      systemUrl: id ? `/systems/${id}` : '',
      hostName: record.host,
      hostRaw: isToken ? '' : record.hostRaw,
      nodeType: record.nodeType,
      status: record.status,
      registered: this.formatTimestamp(record.created),
      lastActive: this.formatTimestamp(record.lastUpdated),
      lastActiveIso: record.lastUpdated ? record.lastUpdated.toISOString() : '',
      resultFilter: record.resultFilterOverride ?? (record.hostRaw ? this.buildHostFilter(record.hostRaw) : ''),
      hasResult: record.fromResult ? 'true' : '',
    };
  }

  /** Fetch wrapper that retries on 429/503 with backoff (honoring Retry-After). */
  private async fetchWithRetry(url: string, init: RequestInit, maxRetries = 5): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, init);
      if ((response.status !== 429 && response.status !== 503) || attempt >= maxRetries) {
        return response;
      }
      const retryAfter = Number(response.headers.get('Retry-After'));
      const backoff =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(500 * 2 ** attempt, 8000);
      await this.delay(backoff + Math.random() * 250);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
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
    // Display in the browser's local timezone to match how SystemLink shows timestamps.
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  }

  private pad(value: number): string {
    return value.toString().padStart(2, '0');
  }
}
